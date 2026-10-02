import { afterAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";

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

async function proof(options: { write?: boolean; expired?: boolean; lifetimeMs?: number } = {}) {
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "example/": options.write ? ["tinycloud.kv/get", "tinycloud.kv/put"] : ["tinycloud.kv/get"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk: key,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + (options.expired ? -30_000 : options.lifetimeMs ?? 3600_000)).toISOString(),
  });
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
    expect(received[0]).toMatchObject({ permissions: requested, expiry: "1h", host });
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

  test("an ISO --expiry stays an absolute deadline while consent is pending", async () => {
    // Consent takes 20 minutes and OpenKey signs 40 minutes from then (+60).
    const t0 = Date.now();
    const delayedConsent = async () => {
      setSystemTime(new Date(t0 + 20 * 60_000));
      return proof({ lifetimeMs: 40 * 60_000 });
    };
    try {
      await expect(refreshOpenKeySession("scoped", host, { permissions: requested, expiry: new Date(t0 + 45 * 60_000).toISOString(), openKeyAcquisition: delayedConsent }))
        .rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
      setSystemTime();
      // The same 45 minutes as a duration counts from approval (+65): accepted.
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
});
