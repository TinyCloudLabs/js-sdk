import { afterAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { withRecapCaveat } from "./test-support/recap-caveat.js";
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
const [capabilityRead, bearerPrefix, addressedPrefix] = requested as [PermissionEntry, PermissionEntry, PermissionEntry];
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

async function approved(start: Record<string, unknown>, transactionId: string, input: { signed: PermissionEntry[]; claimed?: PermissionEntry[]; binding?: PermissionEntry[]; shareOrigin?: string; lifetimeMs?: number; caveat?: Record<string, unknown> }) {
  const delegation = await signedDelegation(input.signed, start.publicJwk as object, input.claimed ?? input.signed, input.lifetimeMs, input.caveat);
  return response({
    status: "approved",
    relay: await encryptRelay(start.relayPublicJwk as object, transactionId, delegation),
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
    const result = await acquire(openkey, { expiry: { durationMs: 7_200_000 }, reason: "Publish Share links.", emitInstructions: (prompt) => prompts.push(prompt) });

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

  test("the built-in publishing manifest carries OpenKey's required capability read in its one space", () => {
    expect(capabilityRead).toEqual({ service: "tinycloud.capabilities", space: "default", path: "", actions: ["tinycloud.capabilities/read"] });
    expect(new Set(requested.map((permission) => permission.space))).toEqual(new Set(["default"]));
  });

  test("reports capabilities the owner unchecked and keeps only the signed subset, including the required capability read", async () => {
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: bearerOnly }));
    const result = await acquire(openkey);
    expect(result.approved.map((p) => `${p.service}:${p.path}`)).toEqual(["tinycloud.capabilities:", "tinycloud.kv:xyz.tinycloud.share/shares/"]);
    expect(result.declined).toEqual([{
      service: "tinycloud.kv",
      space: spaceId.toLowerCase(),
      path: "shares/",
      actions: addressedPrefix.actions,
    }]);
  });

  test("rejects a signed grant broader than the approved binding claims", async () => {
    const broad = [capabilityRead, { ...bearerPrefix, path: "" }];
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

  test("refuses a relay whose ephemeral key is not a P-256 point", async () => {
    const openkey = fakeOpenKey(async (start, id) => {
      const body = await (await approved(start, id, { signed: requested })).json() as { relay: { ephemeralPublicJwk: { y: string } } };
      body.relay.ephemeralPublicJwk.y = Buffer.alloc(32).toString("base64url");
      return response(body);
    });
    await expect(acquire(openkey)).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID_RESPONSE", message: "OpenKey returned an invalid relay key" });
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

  test("sends a manifest without the capability read as written, so OpenKey's invalid_scope surfaces", async () => {
    const kvOnly = [bearerPrefix, addressedPrefix];
    const openkey = fakeOpenKey(() => response({}), {
      start: response({ error: "invalid_scope", errorDescription: "tinycloud.capabilities/read on \"\" is required" }, 400),
    });
    await expect(acquire(openkey, { permissions: kvOnly })).rejects.toMatchObject({ code: "SCOPE_REJECTED" });
    expect(openkey.startBodies[0]!.permissions).toEqual(kvOnly);
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
    await expect(acquire(openkey, { expiry: { durationMs: 31 * 24 * 60 * 60 * 1000 } })).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
    expect(openkey.startBodies).toEqual([]);
  });

  test("a lifetime counts from approval, so a slow approval is not refused", async () => {
    // Approval arrives 20 minutes in and signs a 40-minute session.
    const t0 = Date.now();
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested, lifetimeMs: 40 * 60_000 }));
    try {
      const result = await acquire(openkey, { expiry: { durationMs: 45 * 60_000 }, wait: async () => { setSystemTime(new Date(t0 + 20 * 60_000)); } });
      expect(result.declined).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  test("names OpenKey when its device API is unreachable", async () => {
    const fetchFn = Object.assign(async () => { throw new TypeError("fetch failed"); }, { preconnect: () => undefined }) as typeof globalThis.fetch;
    await expect(acquireDeviceDelegation({
      sessionDid, jwk: key, nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested,
      openkeyHost: "https://openkey.example", fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
    })).rejects.toMatchObject({ code: "OPENKEY_UNREACHABLE", message: expect.stringContaining("https://openkey.example") });
  });

  test("refuses verification pages off the OpenKey site and unbounded approval windows", async () => {
    const start = (overrides: Record<string, unknown>) => response({
      transactionId: randomBytes(18).toString("base64url"), userCode: "ABCD-EFGH",
      verificationUri: "https://openkey.so/device", expiresIn: 600, interval: 2, ...overrides,
    }, 201);
    const prompts: unknown[] = [];
    for (const overrides of [{ verificationUri: "https://openkey.attacker.example/device" }, { expiresIn: 7 * 24 * 60 * 60 }]) {
      const openkey = fakeOpenKey(() => response({}), { start: start(overrides) });
      await expect(acquire(openkey, { emitInstructions: (prompt) => prompts.push(prompt) })).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID_RESPONSE" });
    }
    expect(prompts).toEqual([]);
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

  const OTHER_OWNER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
  const baseProfile = { name: "agent", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z" };
  const login = (openkey: FakeOpenKey, extra: Record<string, unknown> = {}) => loginWithDeviceAuthorization({
    profileName: "agent", nodeOrigin: NODE, shareOrigin: SHARE, permissions: requested,
    fetchFn: openkey.fetchFn, emitInstructions: () => undefined, wait: async () => undefined, ...extra,
  });

  test("pins the recorded owner on init-shaped and posture-only profiles", async () => {
    // `tc init` records ownerDid without authMethod; `tc profile create` records only a posture.
    for (const shape of [{ ownerDid: OTHER_OWNER }, { ownerDid: OTHER_OWNER, posture: "owner-openkey" as const }]) {
      await rm(join(home, ".tinycloud"), { recursive: true, force: true });
      await ProfileManager.setKey("agent", key);
      await ProfileManager.setProfile("agent", { ...baseProfile, ...shape });
      const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));
      await expect(login(openkey)).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
      expect(await ProfileManager.getProfile("agent")).toEqual({ ...baseProfile, ...shape });
      expect(await ProfileManager.getSession("agent")).toBeNull();
    }
  });

  test("refuses a local-owner-key profile before contacting OpenKey", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, authMethod: "local", privateKey: "0xlocal", ownerDid: OTHER_OWNER });
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));
    await expect(login(openkey)).rejects.toMatchObject({ code: "LOCAL_OWNER_PROFILE" });
    expect(openkey.urls).toEqual([]);
  });

  test("keeps another app's live session unless --replace-session; renewing the same scope is allowed", async () => {
    const appSession = { spaceId: wasm.makeSpaceId(address, 1, "applications"), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), permissions: [{ service: "tinycloud.kv", space: "applications", path: "tinychat/", actions: ["tinycloud.kv/get"] }] };
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, ownerDid, posture: "owner-openkey" });
    await ProfileManager.setSession("agent", appSession);

    const refused = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));
    await expect(login(refused)).rejects.toMatchObject({ code: "SESSION_IN_USE", message: expect.stringContaining("--replace-session") });
    expect(refused.urls).toEqual([]);
    expect(await ProfileManager.getSession("agent")).toEqual(appSession);

    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })), { replaceSession: true });
    // The publishing session is now live; logging in again for the same scope renews it.
    const renewed = await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })));
    expect(renewed.result.ownerDid).toBe(ownerDid);
  });

  test("a narrowed approval does not replace a live, broader session; a broader one renews a narrowed session", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, ownerDid, posture: "owner-openkey" });
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })));
    const full = await ProfileManager.getSession("agent");

    // Requested scope keeps everything, but the owner approves only the capability read.
    const narrowed = fakeOpenKey((start, id) => approved(start, id, { signed: [capabilityRead] }));
    await expect(login(narrowed)).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(narrowed.polls).toBe(1);
    expect(await ProfileManager.getSession("agent")).toEqual(full);

    // Explicitly replacing installs the narrowed session...
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: bearerOnly })), { replaceSession: true });
    // ...and renewing with the full manifest widens it again without the flag.
    const widened = await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })));
    expect(widened.result.declined).toEqual([]);
  });

  test("an approval that signs a caveat onto the same actions does not replace the unrestricted session", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, ownerDid, posture: "owner-openkey" });
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })));
    const unrestricted = await ProfileManager.getSession("agent");

    const caveated = () => fakeOpenKey((start, id) => approved(start, id, { signed: requested, caveat: { tenant: "alpha" } }));
    await expect(login(caveated())).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(await ProfileManager.getSession("agent")).toEqual(unrestricted);

    await login(caveated(), { replaceSession: true });
    const permissions = (await ProfileManager.getSession("agent") as { permissions: PermissionEntry[] }).permissions;
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.every((permission) => JSON.stringify(permission.caveats) === JSON.stringify([{ tenant: "alpha" }]))).toBe(true);
  });

  test("refuses to commit when another login for a different owner finished during approval", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", baseProfile);
    const ownerB = { ...baseProfile, ownerDid: OTHER_OWNER, posture: "owner-openkey" as const, authMethod: "openkey" as const };
    const sessionB = { spaceId: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default", ownerDid: OTHER_OWNER, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    const openkey = fakeOpenKey(async (start, id) => {
      // A scoped login for owner B completes while owner A is still approving.
      await ProfileManager.setSession("agent", sessionB);
      await ProfileManager.setProfile("agent", ownerB);
      return approved(start, id, { signed: requested });
    });
    await expect(login(openkey)).rejects.toMatchObject({ code: "PROFILE_CHANGED_DURING_LOGIN" });
    expect(await ProfileManager.getProfile("agent")).toEqual(ownerB);
    expect(await ProfileManager.getSession("agent")).toEqual(sessionB);
  });

  test("refuses to commit over an applications session that appeared during approval", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, ownerDid });
    const appSession = { spaceId: wasm.makeSpaceId(address, 1, "applications"), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    const openkey = fakeOpenKey(async (start, id) => {
      await ProfileManager.setSession("agent", appSession);
      return approved(start, id, { signed: requested });
    });
    await expect(login(openkey)).rejects.toMatchObject({ code: "PROFILE_CHANGED_DURING_LOGIN" });
    expect(await ProfileManager.getSession("agent")).toEqual(appSession);
  });

  test("treats a profile signed in with a local key as local-owner even under an owner-openkey posture", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, posture: "owner-openkey", authMethod: "local", privateKey: "0xlocal" });
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));
    await expect(login(openkey)).rejects.toMatchObject({ code: "LOCAL_OWNER_PROFILE" });
    expect(openkey.urls).toEqual([]);
  });

  test("a same-scope renewal that would end earlier needs --replace-session", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, ownerDid });
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested, lifetimeMs: 6 * 3600_000 })), { expiry: { durationMs: 6 * 3600_000 } });

    // Requesting a shorter lifetime is refused before consent...
    const shorter = fakeOpenKey((start, id) => approved(start, id, { signed: requested, lifetimeMs: 3600_000 }));
    await expect(login(shorter, { expiry: { durationMs: 3600_000 } })).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(shorter.urls).toEqual([]);
    // ...and an approval that signs a shorter session is refused before saving.
    const shortened = fakeOpenKey((start, id) => approved(start, id, { signed: requested, lifetimeMs: 3600_000 }));
    await expect(login(shortened, { expiry: { durationMs: 12 * 3600_000 } })).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(shortened.polls).toBe(1);
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested, lifetimeMs: 3600_000 })), { expiry: { durationMs: 3600_000 }, replaceSession: true });
  });

  test("concurrent profile updates are read-modify-write transactions: none is erased", async () => {
    await ProfileManager.setProfile("agent", baseProfile);
    const names = Array.from({ length: 8 }, (_, index) => `node-${index}`);
    await Promise.all(names.map((name) => ProfileManager.updateProfile("agent", (profile) => ({
      ...profile,
      pinnedLocalNodeDids: { ...profile.pinnedLocalNodeDids, [name]: `did:key:${name}` },
    }))));
    expect(Object.keys((await ProfileManager.getProfile("agent")).pinnedLocalNodeDids ?? {}).sort()).toEqual(names);
  });

  test("a key rotation waits for a commit in progress instead of being overwritten by it", async () => {
    const oldKey = { ...key, kid: "old" };
    const rotatedKey = { ...key, kid: "rotated" };
    await ProfileManager.setKey("agent", oldKey);
    const inside = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    // A login commit holds the lock and rewrites the key it snapshotted.
    const commit = ProfileManager.withLock("agent", async () => {
      inside.resolve();
      await finish.promise;
      await ProfileManager.setKey("agent", oldKey);
    });
    await inside.promise;
    // The store writes a signal file when a writer finds the lock held.
    const contention = join(home, "lock-contention");
    process.env.NODE_ENV = "test";
    process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = contention;
    const rotation = ProfileManager.setKey("agent", rotatedKey);
    while (!await stat(contention).then(() => true, () => false)) { /* each stat yields to the rotation */ }
    delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    expect(await ProfileManager.getKey("agent")).toEqual(oldKey);
    finish.resolve();
    await commit;
    await rotation;
    expect(await ProfileManager.getKey("agent")).toEqual(rotatedKey);
  });

  test("treats an unreadable profile as an error instead of a missing one", async () => {
    await ProfileManager.setKey("agent", key);
    await writeFile(join(PROFILES_DIR, "agent", "profile.json"), "{ not json");
    const openkey = fakeOpenKey((start, id) => approved(start, id, { signed: requested }));
    await expect(login(openkey)).rejects.toBeInstanceOf(SyntaxError);
    expect(openkey.urls).toEqual([]);
  });

  test("replaces an expired session without a flag", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, ownerDid });
    await ProfileManager.setSession("agent", { spaceId: "tinycloud:pkh:eip155:1:0x0:applications", expiresAt: new Date(Date.now() - 1000).toISOString() });
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })));
    expect(await ProfileManager.getSession("agent")).toMatchObject({ spaceId });
  });

  test("stores the node host only when it was chosen explicitly", async () => {
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setProfile("agent", { ...baseProfile, host: "https://stored.example" });
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })));
    expect((await ProfileManager.getProfile("agent")).host).toBe("https://stored.example");
    await login(fakeOpenKey((start, id) => approved(start, id, { signed: requested })), { persistHost: true });
    expect((await ProfileManager.getProfile("agent")).host).toBe(NODE);
  });

  test("tightens state written 0775/0664 by older releases on the next write", async () => {
    const { appendGrantHistory } = await import("../lib/permissions.js");
    const tinycloud = join(home, ".tinycloud");
    const profileDir = join(PROFILES_DIR, "agent");
    await mkdir(join(profileDir, "cache"), { recursive: true, mode: 0o775 });
    for (const directory of [tinycloud, PROFILES_DIR, profileDir, join(profileDir, "cache")]) await chmod(directory, 0o775);
    await writeFile(join(profileDir, "key.json"), JSON.stringify(key), { mode: 0o664 });
    await writeFile(join(profileDir, "auth-grants.jsonl"), "", { mode: 0o664 });
    await chmod(join(profileDir, "auth-grants.jsonl"), 0o664);

    await ProfileManager.setProfile("agent", baseProfile);
    await ProfileManager.setKey("agent", key);
    await ProfileManager.setSession("agent", { spaceId });
    await ProfileManager.getCacheDir("agent");
    await appendGrantHistory("agent", { addedCaps: [], source: "cli" });

    for (const directory of [tinycloud, PROFILES_DIR, profileDir, join(profileDir, "cache")]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const file of ["key.json", "profile.json", "session.json", "auth-grants.jsonl"]) {
      expect((await stat(join(profileDir, file))).mode & 0o777).toBe(0o600);
    }
  });
});
