import { afterAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { withRecapCaveat } from "./test-support/recap-caveat.js";
import type { DeviceAuthorizationInput } from "./device-auth.js";

// TC_HOME is read when the profile store loads, so import it afterwards.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-auth-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { PROFILES_DIR } = await import("../config/constants.js");
const { acquireDeviceDelegation, loginWithDeviceAuthorization } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");
const { sharePublishingPermissions } = await import("../share/publishing-manifest.js");

const NODE = "https://tee.node.tinycloud.xyz";
const SHARE = "https://share.tinycloud.xyz";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "default");
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Record<string, string>;
const sessionDid = keyToDID(key);
const requested = sharePublishingPermissions();
const [capabilityRead, bearerPrefix, addressedPrefix, artifactsPrefix] = requested as [PermissionEntry, PermissionEntry, PermissionEntry, PermissionEntry];
// OpenKey's required capability read is always signed; the owner unchecked addressed shares.
const bearerOnly = [capabilityRead, bearerPrefix];

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

/**
 * OpenKey's side of the relay, independently of the CLI's implementation:
 * WebCrypto ECDH over the JWK the CLI sent (the CLI uses node:crypto ECDH).
 */
async function encryptRelay(relayPublicJwk: object, transactionId: string, value: unknown) {
  const p256 = { name: "ECDH", namedCurve: "P-256" } as const;
  const ephemeral = await crypto.subtle.generateKey(p256, true, ["deriveBits"]);
  const relayPublicKey = await crypto.subtle.importKey("jwk", relayPublicJwk, p256, false, []);
  const sharedSecret = Buffer.from(await crypto.subtle.deriveBits({ name: "ECDH", public: relayPublicKey }, ephemeral.privateKey, 256));
  const extracted = createHmac("sha256", Buffer.from(transactionId)).update(sharedSecret).digest();
  const relayKey = createHmac("sha256", extracted).update(Buffer.from("openkey-device-relay-v1")).update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", relayKey, nonce);
  cipher.setAAD(Buffer.from(transactionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return {
    version: 1,
    algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

/** What OpenKey's /delegate/complete returns for an owner-signed SIWE over `signed`; `caveat` is signed onto every action. */
async function signedDelegation(signed: PermissionEntry[], publicJwk: object, claimed: PermissionEntry[] = signed, lifetimeMs = 3600_000, caveat?: Record<string, unknown>) {
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of signed) {
    const service = permission.service.slice("tinycloud.".length);
    (abilities[service] ??= {})[permission.path] = permission.actions;
  }
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + lifetimeMs).toISOString();
  const prepared = wasm.prepareSession({
    abilities, address, chainId: 1, domain: "openkey.so", spaceId, jwk: key,
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
  });
  if (caveat) prepared.siwe = withRecapCaveat(prepared.siwe, caveat);
  const signature = await signer.signMessage(prepared.siwe);
  return {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    jwk: publicJwk, verificationMethod: sessionDid, address, chainId: 1, spaceId, ownerDid,
    siwe: prepared.siwe, signature, expiresAt, permissions: claimed, hostActivated: true,
  };
}

interface OpenKeyStub {
  readonly fetchFn: typeof globalThis.fetch;
  readonly startBodies: Record<string, unknown>[];
  readonly urls: string[];
  readonly polls: number;
}

/** OpenKey device API double: `approve` builds the token-endpoint answer from the start request. */
function openKeyRelayStub(approve: (start: Record<string, unknown>, transactionId: string) => Promise<Response> | Response, options: { start?: Response } = {}): OpenKeyStub {
  const startBodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const transactionId = randomBytes(18).toString("base64url");
  let polls = 0;
  const fetchFn = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url).endsWith("/api/device-authorizations")) {
      startBodies.push(body);
      // Real OpenKey serves the page on its site: api.openkey.so -> openkey.so.
      const site = new URL(String(url));
      site.hostname = site.hostname.replace(/^api\./, "");
      return options.start ?? response({
        transactionId,
        userCode: "ABCD-EFGH",
        verificationUri: `${site.origin}/device`,
        verificationUriComplete: `${site.origin}/device?user_code=ABCD-EFGH`,
        expiresIn: 600,
        interval: 2,
      }, 201);
    }
    polls += 1;
    return approve(startBodies[0]!, transactionId);
  }, { preconnect: () => undefined }) as typeof globalThis.fetch;
  return { fetchFn, startBodies, urls, get polls() { return polls; } };
}

const fakeOpenKey = openKeyRelayStub;

async function approved(start: Record<string, unknown>, transactionId: string, input: { signed: PermissionEntry[]; claimed?: PermissionEntry[]; binding?: PermissionEntry[]; shareOrigin?: string; lifetimeMs?: number; caveat?: Record<string, unknown>; primary?: boolean; space?: Record<string, unknown> }) {
  const delegation = await signedDelegation(input.signed, start.publicJwk as object, input.claimed ?? input.signed, input.lifetimeMs, input.caveat);
  // OpenKey's unsigned report that the approving key is the account's primary key, and how far it got hosting the space.
  const relayed = { ...delegation, ...(input.primary === undefined ? {} : { primary: input.primary }), ...input.space };
  return response({
    status: "approved",
    relay: await encryptRelay(start.relayPublicJwk as object, transactionId, relayed),
    binding: {
      transactionId,
      sessionDid,
      nodeOrigin: NODE,
      shareOrigin: input.shareOrigin ?? SHARE,
      permissions: input.binding ?? input.claimed ?? input.signed,
      delegationExpiresAt: delegation.expiresAt,
    },
  });
}

function acquire(openkey: OpenKeyStub, overrides: Partial<DeviceAuthorizationInput> = {}) {
  return acquireDeviceDelegation({
    sessionDid, jwk: key, nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested,
    fetchFn: openkey.fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
    ...overrides,
  });
}

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
});
afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

// TC-2363: a device approval the CLI refuses AFTER the owner approved it leaves a live delegation. The refusal prints ONE notice:
// the delegation's CID, until when OpenKey granted it, what happened to its key, and that this CLI cannot revoke it.
// Refusals that grant nothing (denied, expired) print none.
const REVOKE_URL = "https://account.tinycloud.xyz/delegations";
const stderr: string[] = [];
async function capturing<T>(run: () => Promise<T>): Promise<T> {
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as never);
  try { return await run(); } finally { spy.mockRestore(); }
}
const text = () => stderr.join("");
const notices = () => text().split("\n").filter((line) => line.includes("OpenKey granted this approval"));
const login = (openkey: OpenKeyStub, permissions: PermissionEntry[] = requested) => capturing(() => loginWithDeviceAuthorization({
  profileName: "agent", nodeOrigin: NODE, shareOrigin: SHARE, permissions, fetchFn: openkey.fetchFn,
  emitInstructions: () => undefined, wait: async () => undefined,
}));
const deleted = /^Refused delegation: \S+\. OpenKey granted this approval until \d{4}-\d\d-\d\dT[\d:.]+Z, but this CLI did not use it and its key was deleted, so it cannot be used\. You can also remove it at account\.tinycloud\.xyz\. .*cannot revoke it.*https:\/\/account\.tinycloud\.xyz\/delegations/;
const kept = /^Refused delegation: \S+\. OpenKey granted this approval until \d{4}-\d\d-\d\dT[\d:.]+Z and the key it belongs to still exists on this device \(other grants may use it\)\. Revoke it at account\.tinycloud\.xyz\. .*cannot revoke it.*https:\/\/account\.tinycloud\.xyz\/delegations/;

describe("a refused device approval", () => {
  beforeEach(() => { stderr.length = 0; });

  test("DEVICE_AUTH_BINDING_MISMATCH on a first login (the key exists only in memory): one deleted notice, no key or profile written", async () => {
    const openkey = openKeyRelayStub((start, id) => approved(start, id, { signed: requested, shareOrigin: "https://outside.example" }));
    await expect(login(openkey)).rejects.toMatchObject({ code: "DEVICE_AUTH_BINDING_MISMATCH" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatch(deleted);
    expect(await ProfileManager.getKey("agent")).toBeNull();
    expect(await ProfileManager.profileExists("agent")).toBe(false);
  });

  test("OPENKEY_GRANT_BROADENED (the owner signed more than was asked) on a profile that has a key: one kept notice, the key is byte for byte unchanged", async () => {
    await ProfileManager.setKey("agent", key);
    const before = { name: "agent", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z" };
    await ProfileManager.setProfile("agent", before);
    // The request asked for the capability read and the bearer prefix; the owner signed the whole publishing set.
    const openkey = openKeyRelayStub((start, id) => approved(start, id, { signed: requested }));
    await expect(login(openkey, bearerOnly)).rejects.toMatchObject({ code: "OPENKEY_GRANT_BROADENED" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatch(kept);
    expect(await ProfileManager.getKey("agent")).toEqual(key);
    expect(await ProfileManager.getProfile("agent")).toEqual(before);
  });

  test("the owner denied it: nothing was granted, so no notice", async () => {
    const openkey = openKeyRelayStub(() => response({ error: "access_denied" }, 400));
    await expect(login(openkey)).rejects.toMatchObject({ code: "DEVICE_AUTH_DENIED" });
    expect(text()).not.toContain("OpenKey granted this approval");
    expect(text()).not.toContain(REVOKE_URL);
  });

  test("an approval that is accepted prints no notice", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { name: "agent", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z" });
    const openkey = openKeyRelayStub((start, id) => approved(start, id, { signed: requested }));
    await login(openkey);
    expect(text()).not.toContain("OpenKey granted this approval");
    expect(text()).not.toContain(REVOKE_URL);
  });
});
