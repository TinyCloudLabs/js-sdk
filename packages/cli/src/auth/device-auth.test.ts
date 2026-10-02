import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, type JsonWebKey } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import type { DeviceAuthorizationInput } from "./device-auth.js";

// TC_HOME is read when the profile store loads, so import it afterwards.
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
const bearerOnly = [requested[0]!];

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function encryptRelay(relayPublicJwk: object, transactionId: string, value: unknown) {
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: relayPublicJwk as JsonWebKey, format: "jwk" }) });
  const extracted = createHmac("sha256", Buffer.from(transactionId)).update(sharedSecret).digest();
  const relayKey = createHmac("sha256", extracted).update(Buffer.from("openkey-device-relay-v1")).update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", relayKey, nonce);
  cipher.setAAD(Buffer.from(transactionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return {
    version: 1,
    algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: ephemeral.publicKey.export({ format: "jwk" }),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

/** What OpenKey's /delegate/complete returns for an owner-signed SIWE over `signed`. */
async function signedDelegation(signed: PermissionEntry[], publicJwk: object, claimed: PermissionEntry[] = signed) {
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of signed) {
    const service = permission.service.slice("tinycloud.".length);
    (abilities[service] ??= {})[permission.path] = permission.actions;
  }
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities, address, chainId: 1, domain: "openkey.so", spaceId, jwk: key,
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
  });
  const signature = await signer.signMessage(prepared.siwe);
  return {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    jwk: publicJwk, verificationMethod: sessionDid, address, chainId: 1, spaceId, ownerDid,
    siwe: prepared.siwe, signature, expiresAt, permissions: claimed, hostActivated: true,
  };
}

interface FakeOpenKey {
  readonly fetchFn: typeof globalThis.fetch;
  readonly startBodies: Record<string, unknown>[];
  readonly urls: string[];
  readonly polls: number;
}

/** OpenKey device API double: `approve` builds the token-endpoint answer from the start request. */
function fakeOpenKey(approve: (start: Record<string, unknown>, transactionId: string) => Promise<Response> | Response, options: { start?: Response } = {}): FakeOpenKey {
  const startBodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const transactionId = randomBytes(18).toString("base64url");
  let polls = 0;
  const fetchFn = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url).endsWith("/api/device-authorizations")) {
      startBodies.push(body);
      return options.start ?? response({
        transactionId,
        userCode: "ABCD-EFGH",
        verificationUri: "https://openkey.so/device",
        verificationUriComplete: "https://openkey.so/device?user_code=ABCD-EFGH",
        expiresIn: 600,
        interval: 2,
      }, 201);
    }
    polls += 1;
    return approve(startBodies[0]!, transactionId);
  }, { preconnect: () => undefined }) as typeof globalThis.fetch;
  return { fetchFn, startBodies, urls, get polls() { return polls; } };
}

async function approved(start: Record<string, unknown>, transactionId: string, input: { signed: PermissionEntry[]; claimed?: PermissionEntry[]; binding?: PermissionEntry[]; shareOrigin?: string }) {
  const delegation = await signedDelegation(input.signed, start.publicJwk as object, input.claimed ?? input.signed);
  return response({
    status: "approved",
    relay: encryptRelay(start.relayPublicJwk as object, transactionId, delegation),
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

function acquire(openkey: FakeOpenKey, overrides: Partial<DeviceAuthorizationInput> = {}) {
  return acquireDeviceDelegation({
    sessionDid, jwk: key, nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested,
    fetchFn: openkey.fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
    ...overrides,
  });
}

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe("OpenKey device authorization", () => {
  test("requests the manifest scope without private key material and returns the verified session", async () => {
    const prompts: unknown[] = [];
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));
    const result = await acquire(openkey, { delegationTtlSeconds: 7200, reason: "Publish Share links.", emitInstructions: (prompt) => prompts.push(prompt) });

    const start = openkey.startBodies[0]!;
    expect(start.permissions).toEqual(requested);
    expect(start.delegationTtlSeconds).toBe(7200);
    expect(start.reason).toBe("Publish Share links.");
    expect(start).toMatchObject({ sessionDid, nodeOrigin: NODE, shareOrigin: SHARE });
    expect(JSON.stringify(start)).not.toContain(key.d);
    expect(prompts).toEqual([expect.objectContaining({
      verificationUri: "https://openkey.so/device",
      verificationUriComplete: "https://openkey.so/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
    })]);
    expect(result.ownerDid).toBe(ownerDid);
    expect(result.spaceId).toBe(spaceId);
    expect(result.declined).toEqual([]);
    expect(new Set(result.approved.flatMap((p) => p.actions.map((a) => `${p.path}|${a}`))))
      .toEqual(new Set(requested.flatMap((p) => p.actions.map((a) => `${p.path}|${a}`))));
    expect((result.session.jwk as Record<string, string>).d).toBe(key.d);
  });

  test("reports capabilities the owner unchecked and keeps only the approved subset", async () => {
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: bearerOnly }));
    const result = await acquire(openkey);
    expect(result.approved.map((p) => p.path)).toEqual(["xyz.tinycloud.share/shares/"]);
    expect(result.declined).toEqual([{
      service: "tinycloud.kv",
      space: spaceId.toLowerCase(),
      path: "shares/",
      actions: requested[1]!.actions,
    }]);
  });

  test("rejects a signed grant broader than the approved binding claims", async () => {
    const broad = [{ ...bearerOnly[0]!, path: "" }];
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: broad, claimed: bearerOnly }));
    await expect(acquire(openkey)).rejects.toMatchObject({ code: "OPENKEY_GRANT_BROADENED" });
  });

  test("rejects OpenKey metadata that claims more than the signed grant", async () => {
    // Signed ReCap covers only bearer links; binding and relay claim both prefixes.
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: bearerOnly, claimed: requested }));
    await expect(acquire(openkey)).rejects.toMatchObject({ code: "DEVICE_AUTH_BINDING_MISMATCH" });
  });

  test("compares owner addresses case-insensitively but space names exactly", async () => {
    expect(address).not.toBe(address.toLowerCase());
    const checksumSpace = `tinycloud:pkh:eip155:1:${address}:default`;
    const lowerSpace = `tinycloud:pkh:eip155:1:${address.toLowerCase()}:default`;
    const asUri = (space: string) => requested.map((permission) => ({ ...permission, space }));
    const accepted = fakeOpenKey((start, id) => approved(start, id, { signed: requested, claimed: asUri(checksumSpace), binding: asUri(lowerSpace) }));
    const result = await acquire(accepted, { permissions: asUri(lowerSpace), expectedOwner: ownerDid.toLowerCase() });
    expect(result.declined).toEqual([]);

    const renamed = fakeOpenKey((start, id) => approved(start, id, { signed: requested, binding: asUri(lowerSpace.replace(/:default$/, ":Default")) }));
    await expect(acquire(renamed)).rejects.toMatchObject({ code: "DEVICE_AUTH_BINDING_MISMATCH" });
  });

  test("rejects an approval whose binding and relayed delegation disagree", async () => {
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: bearerOnly, claimed: bearerOnly, binding: requested }));
    await expect(acquire(openkey)).rejects.toMatchObject({ code: "DEVICE_AUTH_BINDING_MISMATCH" });
  });

  test("rejects a relay bound to another Share origin", async () => {
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested, shareOrigin: "https://attacker.example" }));
    await expect(acquire(openkey)).rejects.toMatchObject({ code: "DEVICE_AUTH_BINDING_MISMATCH" });
  });

  test("rejects an approval by an identity other than the expected owner", async () => {
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));
    await expect(acquire(openkey, { expectedOwner: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" }))
      .rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
  });

  test("surfaces OpenKey's invalid_scope as SCOPE_REJECTED with the offending capability", async () => {
    const openkey = fakeOpenKey(() => response({}), {
      start: response({ error: "invalid_scope", errorDescription: "tinycloud.secrets/get is not allowed over device authorization" }, 400),
    });
    await expect(acquire(openkey)).rejects.toMatchObject({
      code: "SCOPE_REJECTED",
      metadata: { capability: "tinycloud.secrets/get is not allowed over device authorization" },
    });
  });

  test("keeps waiting through dropped polls, server errors, pending and slow_down until approval", async () => {
    const waits: number[] = [];
    let call = 0;
    const openkey = fakeOpenKey(async (start, id) => {
      call += 1;
      if (call === 1) throw new TypeError("fetch failed");
      if (call === 2) return response({ error: "server_error" }, 503);
      if (call === 3) return response({ status: "pending", interval: 2 });
      if (call === 4) return response({ error: "slow_down" }, 429);
      return approved(start, id, { signed: requested });
    });
    const result = await acquire(openkey, { wait: async (ms) => { waits.push(ms); } });
    expect(result.declined).toEqual([]);
    expect(openkey.polls).toBe(5);
    expect(waits).toEqual([2000, 2000, 2000, 2000, 7000]);
  });

  test("stops on denial or expiry instead of retrying", async () => {
    await expect(acquire(fakeOpenKey(() => response({ error: "access_denied" }, 400)))).rejects.toMatchObject({ code: "DEVICE_AUTH_DENIED" });
    await expect(acquire(fakeOpenKey(() => response({ error: "expired_token" }, 410)), { openkeyHost: "https://openkey.localhost" }))
      .rejects.toMatchObject({ code: "DEVICE_AUTH_EXPIRED" });
  });

  test("refuses multi-space requests and lifetimes above 30 days before contacting OpenKey", async () => {
    const openkey = fakeOpenKey(() => response({}));
    await expect(acquire(openkey, { permissions: [...requested, { ...requested[0]!, space: "applications" }] })).rejects.toMatchObject({ code: "INVALID_LOGIN_SCOPE" });
    await expect(acquire(openkey, { delegationTtlSeconds: 31 * 24 * 60 * 60 })).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
    expect(openkey.startBodies).toEqual([]);
  });
});

describe("device login persistence", () => {
  test("a key-only profile becomes an OpenKey owner profile with owner-only credential files", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { name: "agent", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z" });
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));

    await loginWithDeviceAuthorization({ profileName: "agent", nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested, fetchFn: openkey.fetchFn, emitInstructions: () => undefined, wait: async () => undefined });

    expect(await ProfileManager.getProfile("agent")).toMatchObject({ authMethod: "openkey", posture: "owner-openkey", ownerDid, spaceId, sessionDid, host: NODE });
    expect(await ProfileManager.getSession("agent")).toMatchObject({ ownerDid, spaceId, jwk: { d: key.d } });
    for (const file of ["key.json", "session.json", "profile.json"]) {
      expect((await stat(join(PROFILES_DIR, "agent", file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(PROFILES_DIR, "agent"))).mode & 0o777).toBe(0o700);
  });

  test("a rejected approval leaves the profile and its session untouched", async () => {
    await ProfileManager.setKey("agent", key);
    const before = { name: "agent", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z" };
    await ProfileManager.setProfile("agent", before);
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested, shareOrigin: "https://attacker.example" }));

    await expect(loginWithDeviceAuthorization({ profileName: "agent", nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested, fetchFn: openkey.fetchFn, emitInstructions: () => undefined, wait: async () => undefined }))
      .rejects.toMatchObject({ code: "DEVICE_AUTH_BINDING_MISMATCH" });
    expect(await ProfileManager.getProfile("agent")).toEqual(before);
    expect(await ProfileManager.getSession("agent")).toBeNull();
  });

  test("uses the profile's self-hosted OpenKey for the device API and keeps it", async () => {
    delete process.env.TC_OPENKEY_HOST;
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { name: "agent", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z", openkeyHost: "https://openkey.example" });
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));

    await loginWithDeviceAuthorization({ profileName: "agent", nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested, fetchFn: openkey.fetchFn, emitInstructions: () => undefined, wait: async () => undefined });

    expect(new Set(openkey.urls.map((url) => new URL(url).origin))).toEqual(new Set(["https://openkey.example"]));
    expect((await ProfileManager.getProfile("agent")).openkeyHost).toBe("https://openkey.example");
  });
});
