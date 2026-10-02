import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function proof(options: { write?: boolean; expired?: boolean; spaceName?: string; path?: string; caveats?: Record<string, unknown>[] } = {}) {
  const now = Date.now();
  const proofSpace = options.spaceName ? wasm.makeSpaceId(address, 1, options.spaceName) : spaceId;
  const proofPath = options.path ?? "example/";
  const prepared = wasm.prepareSession({
    abilities: { kv: { [proofPath]: options.write ? ["tinycloud.kv/get", "tinycloud.kv/put"] : ["tinycloud.kv/get"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId: proofSpace, jwk: key,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + (options.expired ? -30_000 : 3600_000)).toISOString(),
  });
  if (options.caveats) {
    prepared.siwe = prepared.siwe.replace(/urn:recap:([A-Za-z0-9_-]+)/g, (_urn: string, encoded: string) => {
      const recap = JSON.parse(Buffer.from(encoded, "base64url").toString());
      for (const abilities of Object.values(recap.att) as Record<string, unknown>[]) {
        for (const action of Object.keys(abilities)) abilities[action] = options.caveats;
      }
      return `urn:recap:${Buffer.from(JSON.stringify(recap)).toString("base64url")}`;
    });
  }
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId: proofSpace, ownerDid, siwe: prepared.siwe, signature, hostActivated: true };
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

  test("rejects constrained raw requests before consent rather than dropping their caveats", async () => {
    let opened = false;
    await expect(refreshOpenKeySession("scoped", host, {
      permissions: [{ ...requested[0]!, caveats: [{ limit: 1 }] }],
      openKeyAcquisition: async () => { opened = true; return proof(); },
    })).rejects.toMatchObject({ code: "INVALID_LOGIN_SCOPE" });
    expect(opened).toBe(false);
  });

  test("rejects a signed constrained ReCap instead of flattening it during persistence", async () => {
    const response = await proof({ caveats: [{ limit: 1 }] });
    const caveat = wasm.validatePersistedSession({ ...response, jwk: key }).verifiedRecap[0]!.caveats[0];
    expect(caveat instanceof Map ? Object.fromEntries(caveat) : caveat).toEqual({ limit: 1 });
    await expect(refreshOpenKeySession("scoped", host, {
      permissions: requested, openKeyAcquisition: async () => response,
    })).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();
  });

  test("refuses wrong owner, incomplete proof and expired proof before persistence", async () => {
    const valid = await proof();
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, expectedOwner: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111", openKeyAcquisition: async () => valid })).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => ({ ...valid, signature: undefined }) })).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    await expect(refreshOpenKeySession("scoped", host, { permissions: requested, openKeyAcquisition: async () => proof({ expired: true }) })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();
  });

  test("rejects empty first-login requests before opening consent", async () => {
    let calls = 0;
    const acquire = async () => { calls++; return proof(); };
    await expect(refreshOpenKeySession("scoped", host, { permissions: [], openKeyAcquisition: acquire })).rejects.toMatchObject({ code: "INVALID_LOGIN_SCOPE" });
    expect(calls).toBe(0);
  });
  test("profile host drift during consent rejects installation", async () => {
    await expect(refreshOpenKeySession("scoped", host, {
      permissions: requested,
      openKeyAcquisition: async () => {
        await ProfileManager.setProfile("scoped", { ...await ProfileManager.getProfile("scoped"), host: "https://other.invalid" });
        return proof();
      },
    })).rejects.toMatchObject({ code: "AUTH_CONTEXT_CHANGED" });
    expect(await ProfileManager.getSession("scoped")).toBeNull();
  });

  test("loads raw permission arrays without adding manifest default abilities", async () => {
    const { loadLoginPermissionsFile } = await import("./scoped-login.js");
    const path = join(home, "exact-permissions.json");
    const exact = [{ service: "tinycloud.sql", space: "applications", path: "metrics", actions: ["tinycloud.sql/read", "tinycloud.sql/write"] }, { service: "tinycloud.kv", space: "account", path: "applications/example", actions: ["tinycloud.kv/get"] }];
    await writeFile(path, JSON.stringify(exact), { mode: 0o600 });
    expect(await loadLoginPermissionsFile(path)).toEqual(exact);
    await writeFile(path, JSON.stringify([null]));
    await expect(loadLoginPermissionsFile(path)).rejects.toMatchObject({ code: "INVALID_LOGIN_SCOPE" });
  });
});
