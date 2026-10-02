import { afterAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { withRecapCaveat } from "./test-support/recap-caveat.js";

const home = await mkdtemp(join(tmpdir(), "tc-scoped-login-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { refreshOpenKeySession } = await import("../commands/auth.js");
const { loadManifestPermissions } = await import("../lib/permissions.js");
const host = "https://node.example.test";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "applications");
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const requested: PermissionEntry[] = [{ service: "tinycloud.kv", space: "applications", path: "example/", actions: ["tinycloud.kv/get"] }];

/** A real owner-signed session for kv `example/`; `caveat` is signed onto every action. */
async function proof(options: { write?: boolean; expired?: boolean; lifetimeMs?: number; caveat?: Record<string, unknown> } = {}) {
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "example/": options.write ? ["tinycloud.kv/get", "tinycloud.kv/put"] : ["tinycloud.kv/get"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk: key,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + (options.expired ? -30_000 : options.lifetimeMs ?? 3600_000)).toISOString(),
  });
  if (options.caveat) prepared.siwe = withRecapCaveat(prepared.siwe, options.caveat);
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
}

beforeEach(async () => {
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setKey("scoped", key);
  await ProfileManager.setProfile("scoped", { name: "scoped", host, did, sessionDid: did, chainId: 1, spaceName: "default", createdAt: new Date().toISOString() });
  await ProfileManager.clearSession("scoped");
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe("scoped first login", () => {
  test("fresh owner profile loads a logical-space manifest without a prior owner login", async () => {
    const path = join(home, "read.manifest.json");
    await writeFile(path, JSON.stringify({ app_id: "example", space: "applications", permissions: [{ service: "kv", path: "", actions: ["get"] }] }));
    expect(await loadManifestPermissions(path, "scoped", { allowLogicalSpaces: true })).toEqual(requested);
  });

  test("sends the scoped request and expiry, persists only verified proof with the local private key", async () => {
    const received: unknown[] = [];
    const response = await proof();
    await refreshOpenKeySession("scoped", host, { permissions: requested, expiry: "1h", expectedOwner: ownerDid.toLowerCase(), openKeyAcquisition: async (_did, options) => { received.push(options); return response; } });
    expect(received[0]).toMatchObject({ permissions: requested, expiry: "3600s", host });
    const saved = await ProfileManager.getSession("scoped") as any;
    expect(saved.jwk.d).toBe(key.d);
    expect(saved.permissions).toEqual([{ ...requested[0], space: spaceId }]);
    expect((await ProfileManager.getProfile("scoped")).ownerDid).toBe(ownerDid);
  });

  test("refuses a signed write grant even when the unsigned callback permissions claim read-only", async () => {
    const response = { ...await proof({ write: true }), permissions: requested };
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => response })).rejects.toMatchObject({ code: "OPENKEY_GRANT_BROADENED" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();
  });

  test("refuses wrong owner, incomplete proof and expired proof before persistence", async () => {
    const valid = await proof();
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, expectedOwner: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111", openKeyAcquisition: async () => valid })).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => ({ ...valid, signature: undefined }) })).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => proof({ expired: true }) })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();
  });

  test("refuses a signed session that outlives the requested --expiry", async () => {
    const oneHour = await proof();
    for (const expiry of ["1m", 60_000]) {
      await expect(refreshOpenKeySession("scoped", host, { permissions: requested, expiry, openKeyAcquisition: async () => oneHour }))
        .rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    }
    expect(await ProfileManager.getSession("scoped")).toBeNull();
  });

  test("rejects empty or multi-space first-login requests before opening consent", async () => {
    let calls = 0;
    const acquire = async () => { calls++; return proof(); };
    await expect(refreshOpenKeySession("scoped", host, { permissions: [], openKeyAcquisition: acquire })).rejects.toMatchObject({ code: "INVALID_LOGIN_SCOPE" });
    await expect(refreshOpenKeySession("scoped", host, { permissions: [...requested, { ...requested[0]!, space: "default" }], openKeyAcquisition: acquire })).rejects.toMatchObject({ code: "INVALID_LOGIN_SCOPE" });
    expect(calls).toBe(0);
  });

  test("enforces --expiry on unscoped login too", async () => {
    const oneHour = await proof();
    await expect(refreshOpenKeySession("scoped", host, { expiry: "1m", openKeyAcquisition: async () => oneHour }))
      .rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();
    await refreshOpenKeySession("scoped", host, { expiry: "2h", openKeyAcquisition: async () => oneHour });
    expect(await ProfileManager.getSession("scoped")).not.toBeNull();
  });

  test("refuses an ISO --expiry before consent; a duration survives a slow consent", async () => {
    let calls = 0;
    const deadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, expiry: deadline, openKeyAcquisition: async () => { calls++; return proof(); } }))
      .rejects.toMatchObject({ code: "INVALID_EXPIRY", message: expect.stringContaining("duration") });
    expect(calls).toBe(0);

    // Consent takes 20 minutes and OpenKey signs 40 minutes from then.
    const t0 = Date.now();
    const delayedConsent = async () => {
      setSystemTime(new Date(t0 + 20 * 60_000));
      return proof({ lifetimeMs: 40 * 60_000 });
    };
    try {
      await refreshOpenKeySession("scoped", host, { permissions: requested, expiry: "45m", openKeyAcquisition: delayedConsent });
    } finally {
      setSystemTime();
    }
    expect(await ProfileManager.getSession("scoped")).not.toBeNull();
  });

  test("pins the owner a profile recorded without authMethod (tc init shape)", async () => {
    const other = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
    await ProfileManager.setProfile("scoped", { name: "scoped", host, did, sessionDid: did, chainId: 1, spaceName: "default", createdAt: new Date().toISOString(), ownerDid: other });
    const valid = await proof();
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => valid })).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, expectedOwner: ownerDid, openKeyAcquisition: async () => valid })).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();
  });

  test("keeps the stored host unless the login chose one explicitly", async () => {
    const valid = await proof();
    await refreshOpenKeySession("scoped", "https://discovered.local.example", { permissions: requested, openKeyAcquisition: async () => valid });
    expect((await ProfileManager.getProfile("scoped")).host).toBe(host);
    await refreshOpenKeySession("scoped", "https://chosen.example", { permissions: requested, persistHost: true, openKeyAcquisition: async () => valid });
    expect((await ProfileManager.getProfile("scoped")).host).toBe("https://chosen.example");
  });

  const baseProfile = () => ({ name: "scoped", host, did, sessionDid: did, chainId: 1, spaceName: "default", createdAt: new Date().toISOString() });
  const liveAppSession = () => ({ spaceId: wasm.makeSpaceId(address, 1, "tinychat"), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

  test("scoped browser login keeps another app's live session unless --replace-session", async () => {
    const app = liveAppSession();
    await ProfileManager.setSession("scoped", app);
    let calls = 0;
    const acquire = async () => { calls++; return proof(); };
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: acquire })).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(calls).toBe(0);
    expect(await ProfileManager.getSession("scoped")).toEqual(app);
    await refreshOpenKeySession("scoped", host, { permissions: requested, replaceSession: true, openKeyAcquisition: acquire });
    expect(await ProfileManager.getSession("scoped")).toMatchObject({ spaceId });
  });

  test("scoped browser login refuses a local-owner-key profile before consent", async () => {
    await ProfileManager.setProfile("scoped", { ...baseProfile(), authMethod: "local", privateKey: "0xlocal" });
    let calls = 0;
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => { calls++; return proof(); } }))
      .rejects.toMatchObject({ code: "LOCAL_OWNER_PROFILE" });
    expect(calls).toBe(0);
  });

  test("refuses to commit when the profile changed while consent was pending", async () => {
    const app = liveAppSession();
    const concurrentLogin = async () => {
      await ProfileManager.setSession("scoped", app);
      return proof();
    };
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: concurrentLogin }))
      .rejects.toMatchObject({ code: "PROFILE_CHANGED_DURING_LOGIN" });
    expect(await ProfileManager.getSession("scoped")).toEqual(app);
  });

  test("unscoped login keeps the recorded owner and records only the signed owner", async () => {
    const valid = await proof();
    await ProfileManager.setProfile("scoped", { ...baseProfile(), ownerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" });
    await expect(refreshOpenKeySession("scoped", host, { openKeyAcquisition: async () => valid })).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();

    await ProfileManager.setProfile("scoped", baseProfile());
    const forged = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
    await refreshOpenKeySession("scoped", host, { openKeyAcquisition: async () => ({ ...valid, ownerDid: forged }) });
    expect((await ProfileManager.getProfile("scoped")).ownerDid).toBe(ownerDid);
    expect(await ProfileManager.getSession("scoped")).toMatchObject({ ownerDid });
  });

  test("sends --expiry to OpenKey as seconds and refuses less than a minute before consent", async () => {
    const received: Array<{ expiry?: unknown }> = [];
    await refreshOpenKeySession("scoped", host, { permissions: requested, expiry: "2h", openKeyAcquisition: async (_did, options) => { received.push(options ?? {}); return proof(); } });
    expect(received[0]!.expiry).toBe("7200s");
    let calls = 0;
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, expiry: 30_000, openKeyAcquisition: async () => { calls++; return proof(); } }))
      .rejects.toMatchObject({ code: "INVALID_EXPIRY" });
    expect(calls).toBe(0);
  });

  test("an unscoped callback cannot forge the signed-scope marker, owner or expiry", async () => {
    const valid = await proof();
    const ownerless = await ProfileManager.getProfile("scoped");
    const forged = { permissionsSource: "signed-recap", permissions: [], ownerDid: "did:pkh:eip155:1:0x2222222222222222222222222222222222222222", expiresAt: "2099-01-01T00:00:00.000Z" };
    await refreshOpenKeySession("scoped", host, { openKeyAcquisition: async () => ({ ...valid, ...forged }) });
    const saved = await ProfileManager.getSession("scoped") as Record<string, unknown>;
    expect(saved).toMatchObject({ ownerDid, permissionsSource: "signed-recap", permissions: [{ ...requested[0], space: spaceId }] });
    expect(saved.expiresAt).not.toBe(forged.expiresAt);
    // The saved scope is the verified one, so a scoped login for other data cannot replace it.
    const other = [{ ...requested[0]!, path: "other/" }];
    await expect(refreshOpenKeySession("scoped", host, { permissions: other, openKeyAcquisition: async () => proof() })).rejects.toMatchObject({ code: "SESSION_IN_USE" });

    // A callback without a proof, on a profile with no recorded owner and no
    // --expiry, contributes no authority fields at all.
    await ProfileManager.clearSession("scoped");
    await ProfileManager.setProfile("scoped", ownerless);
    const { siwe: _siwe, signature: _signature, ...unproven } = valid;
    await refreshOpenKeySession("scoped", host, { openKeyAcquisition: async () => ({ ...unproven, ...forged }) });
    const legacy = await ProfileManager.getSession("scoped") as Record<string, unknown>;
    for (const field of ["permissionsSource", "permissions", "ownerDid", "expiresAt"]) expect(legacy[field]).toBeUndefined();
  });

  test("restores profile, key and session when a commit write fails", async () => {
    const before = { profile: await ProfileManager.getProfile("scoped"), key: await ProfileManager.getKey("scoped") };
    const failing = spyOn(ProfileManager, "setProfile").mockImplementationOnce(async () => {
      throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    });
    try {
      await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => proof() })).rejects.toMatchObject({ code: "EIO" });
    } finally {
      failing.mockRestore();
    }
    expect(await ProfileManager.getSession("scoped")).toBeNull();
    expect(await ProfileManager.getProfile("scoped")).toEqual(before.profile);
    expect(await ProfileManager.getKey("scoped")).toEqual(before.key);
  });

  test("an inconsistent profile left by an interrupted write needs --replace-session", async () => {
    // A live session that belongs to another key (a crash between commit writes).
    const otherManager = wasm.createSessionManager();
    const stray = { ...await proof(), verificationMethod: otherManager.getDID("default"), jwk: JSON.parse(otherManager.jwk("default")!), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    await ProfileManager.setSession("scoped", stray);
    let calls = 0;
    const acquire = async () => { calls++; return proof(); };
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: acquire })).rejects.toMatchObject({ code: "PROFILE_STATE_INCONSISTENT" });
    expect(calls).toBe(0);
    await refreshOpenKeySession("scoped", host, { permissions: requested, replaceSession: true, openKeyAcquisition: acquire });
    expect(await ProfileManager.getSession("scoped")).toMatchObject({ verificationMethod: did });
  });

  test("a renewal that adds a signed caveat narrows the live session and needs --replace-session", async () => {
    await refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => proof() });
    const unrestricted = await ProfileManager.getSession("scoped");
    // Same service, space, path and action, but signed only for one tenant.
    const narrowed = async () => proof({ caveat: { tenant: "alpha" } });
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: narrowed }))
      .rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(await ProfileManager.getSession("scoped")).toEqual(unrestricted);

    await refreshOpenKeySession("scoped", host, { permissions: requested, replaceSession: true, openKeyAcquisition: narrowed });
    const saved = await ProfileManager.getSession("scoped") as Record<string, unknown>;
    expect(saved.permissions).toEqual([{ ...requested[0], space: spaceId, caveats: [{ tenant: "alpha" }] }]);
    // Dropping the caveat keeps everything the restricted session held.
    await refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => proof() });
    expect((await ProfileManager.getSession("scoped") as Record<string, unknown>).permissions).toEqual([{ ...requested[0], space: spaceId }]);
  });

  test("reports every failure when restoring after a failed commit also fails", async () => {
    const before = await ProfileManager.getProfile("scoped");
    // The commit publishes key and session, then fails writing the profile;
    // the restore then fails to put the key back but still restores the rest.
    const profileWrite = spyOn(ProfileManager, "setProfile").mockImplementationOnce(async () => {
      throw new Error("EIO: i/o error, write profile.json");
    });
    const realSetKey = ProfileManager.setKey.bind(ProfileManager);
    let keyWrites = 0;
    const keyWrite = spyOn(ProfileManager, "setKey").mockImplementation(async (name, value) => {
      if (++keyWrites === 2) throw new Error("ENOSPC: no space left on device, write key.json");
      await realSetKey(name, value);
    });
    let failure: unknown;
    try {
      await refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => proof() }).catch((error: unknown) => { failure = error; });
    } finally {
      profileWrite.mockRestore();
      keyWrite.mockRestore();
    }
    expect(failure).toMatchObject({ code: "PROFILE_STATE_INCONSISTENT" });
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("EIO: i/o error, write profile.json");
    expect(message).toContain("ENOSPC: no space left on device, write key.json");
    expect(message).toContain("--replace-session");
    expect(await ProfileManager.getSession("scoped")).toBeNull();
    expect(await ProfileManager.getProfile("scoped")).toEqual(before);
  });

  test("an unsigned SIWE's past Expiration Time does not make the saved session look expired", async () => {
    const valid = await proof();
    const { signature: _signature, ...unsigned } = valid;
    const expired = valid.siwe.replace(/^Expiration Time: .+$/m, "Expiration Time: 2000-01-01T00:00:00.000Z");
    await refreshOpenKeySession("scoped", host, { openKeyAcquisition: async () => ({ ...unsigned, siwe: expired }) });
    const saved = await ProfileManager.getSession("scoped") as Record<string, unknown>;
    expect(saved.siwe).toBeUndefined();
    let calls = 0;
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => { calls++; return proof(); } }))
      .rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(calls).toBe(0);
  });

  test("a session naming an owner beside a profile without one is inconsistent", async () => {
    await refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => proof() });
    await ProfileManager.setProfile("scoped", baseProfile());
    let calls = 0;
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => { calls++; return proof(); } }))
      .rejects.toMatchObject({ code: "PROFILE_STATE_INCONSISTENT" });
    expect(calls).toBe(0);
  });
});
