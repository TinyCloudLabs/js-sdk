import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { signedRestorableSession } from "../../node-sdk/src/test-support/signed-restorable-session";
import { createIndexedDbLifecycle } from "../../replica/src/kv-storage/lifecycle";
import { pkhDid, type ReplicationEvent } from "@tinycloud/sdk-core";

const format = process.argv[2];
assert(format === "mjs" || format === "cjs", "pass mjs or cjs");
const require = createRequire(import.meta.url);
(globalThis as any).HTMLElement = class { attachShadow() { return { innerHTML: "", querySelector: () => null }; } };
(globalThis as any).customElements = { define() {}, get() {} };
(globalThis as any).window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  location: { hostname: "test.local" },
};
(globalThis as any).document = {
  createElement() { return { style: {}, setAttribute() {}, appendChild() {}, remove() {} }; },
  body: { style: {}, appendChild() {} },
};
const importTouches = { indexedDB: 0, worker: 0 };
Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() {
  importTouches.indexedDB++;
  throw new Error("core or inert optional import touched IndexedDB");
} });
(globalThis as any).Worker = class { constructor() {
  importTouches.worker++;
  throw new Error("core or inert optional import started replica worker");
} };
(globalThis as any).fetch = async () => { throw new Error("offline by fixture"); };
const entries = new Map<string, string>();
const backend = {
  get length() { return entries.size; },
  key: (i: number) => [...entries.keys()][i] ?? null,
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => { entries.set(key, value); },
  removeItem: (key: string) => { entries.delete(key); },
  clear: () => entries.clear(),
};
(globalThis as any).localStorage = backend;
const base = import.meta.dir + "/../dist/";
const root = format === "mjs" ? await import(base + "index.mjs") : require(base + "index.cjs");
const optional = format === "mjs" ? await import(base + "replica.mjs") : require(base + "replica.cjs");
assert.deepEqual(importTouches, { indexedDB: 0, worker: 0 });
assert.throws(() => new root.TinyCloudWeb({ replication: {
  enabled: true, prefixes: ["notes/"], storage: { kind: "indexeddb" },
} }), /registerBrowserReplica/);
root.registerBrowserReplica(optional.browserReplicaPlugin);
assert.throws(() => root.registerBrowserReplica(optional.browserReplicaPlugin), /already registered/);
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
(globalThis as any).IDBKeyRange = IDBKeyRange;
(globalThis as any).navigator = { locks: { request: async (_name: string, options: unknown, section?: () => Promise<unknown>) =>
  (typeof options === "function" ? options : section!)() } };

const proof = await signedRestorableSession({ abilities: { kv: {
  "notes/": ["tinycloud.kv/get", "tinycloud.kv/sync"],
} } });
const issuedAt = proof.siwe.match(/^Issued At: (.+)$/m)?.[1];
assert(issuedAt);
const lifecycle = createIndexedDbLifecycle();
const stamp = await lifecycle.establishSessionStamp(pkhDid(proof.address, proof.chainId), {
  consentAnchor: { source: "siwe", at: Date.parse(issuedAt) },
});
const factory = await optional.loadIndexedDbReplicaStorage();
const replicaStorage = factory({ lifecycle });
const sessionStorage = new root.BrowserSessionStorage({ storage: backend });
await sessionStorage.save(proof.address, {
  address: proof.address, chainId: proof.chainId, sessionKey: JSON.stringify(proof.jwk),
  siwe: proof.siwe, signature: proof.signature, expiresAt: proof.expiresAt,
  createdAt: issuedAt, version: "1.0", tinycloudHosts: ["https://offline.test"], replicaStamp: stamp,
  tinycloudSession: {
    delegationHeader: proof.delegationHeader, delegationCid: proof.delegationCid,
    spaceId: proof.spaceId, verificationMethod: proof.verificationMethod,
  },
});
const provider = { request: async ({ method }: { method: string }) => {
  if (method === "eth_accounts") return [proof.address];
  if (method === "eth_chainId") return "0x1";
  throw new Error("unexpected provider request " + method);
} };
const config = {
  sessionStorage, tinycloudHosts: ["https://offline.test"], tinycloudRegistryUrl: null,
  autoDiscoverLocalNode: false, includeAccountRegistryPermissions: false, autoBootstrapAccount: false,
  replication: { enabled: true, prefixes: ["notes/"], storage: replicaStorage },
};
const web = await root.TinyCloudWeb.create({ ...config, provider });
const restored = await web.restoreSession(proof.address);
assert.equal(restored.status, "restored", JSON.stringify(restored));
const node = (web as any)._node;
assert(node instanceof root.TinyCloudNode && node.restorableSession?.address === proof.address);
const authority = await node.replicationAuthority();
assert.equal(authority.consentAnchor()?.source, "siwe", "signed owner anchor unavailable across bundles");
// A full verified owner proof can plan an initial session-parent mint, but
// without a usable installed grant an offline get cannot return local bytes.
const offlineRead = await web.kv.get("notes/a");
assert(!offlineRead.ok, "offline read without an installed grant returned local bytes");
assert.equal(offlineRead.error.code, "NETWORK_ERROR", "offline read did not fall back to the network");
assert.equal(offlineRead.error.message, "offline by fixture", "offline read did not attempt the network");
assert.equal(authority.plan("notes/").path, "session", "verified owner cannot plan session-parent mint");
const otherWallet = { request: async ({ method }: { method: string }) => {
  if (method === "eth_accounts") return ["0x0000000000000000000000000000000000000001"];
  if (method === "eth_chainId") return "0x1";
  throw new Error("unexpected provider request " + method);
} };
const mismatched = await root.TinyCloudWeb.create({ ...config, provider: otherWallet });
assert.equal((await mismatched.restoreSession(proof.address)).status, "restored",
  "a different connected wallet must not invalidate signed network restoration");
assert.equal((await mismatched.replication.status())[0].gate, "principal_mismatch",
  "wallet B must never unlock A's replica");
const unknown = await root.TinyCloudWeb.create({ ...config, provider: {
  request: async () => { throw new Error("provider unavailable"); },
} });
assert.equal((await unknown.restoreSession(proof.address)).status, "restored",
  "an unavailable wallet must not invalidate signed network restoration");
assert.equal((await unknown.replication.status())[0].gate, "gate_unavailable",
  "an unproven wallet must never unlock A's replica");
const saved = await sessionStorage.load(proof.address);
assert(saved, "signed browser session was not persisted");
const staleStamp = { ...stamp, incarnation: crypto.randomUUID() };
await sessionStorage.save(proof.address, { ...saved, replicaStamp: staleStamp });
const gatedReads: ReplicationEvent[] = [];
const stale = await root.TinyCloudWeb.create({
  ...config, provider,
  replication: { ...config.replication, onEvent: (event: ReplicationEvent) => gatedReads.push(event) },
});
assert.equal((await stale.restoreSession(proof.address)).status, "restored",
  "stale replica stamp must not invalidate the verified network session");
assert.equal((await stale.replication.status())[0].gate, "stamp_stale",
  "persisted stale stamp must not allow any local replica read");
assert.equal((await sessionStorage.load(proof.address))?.replicaStamp?.incarnation, staleStamp.incarnation,
  "restore must not mint or silently repair a stale stamp");
const gatedRead = await stale.kv.get("notes/a");
assert.equal(gatedRead.ok, false, "a stale stamp must not serve local replica bytes");
assert.equal(gatedRead.error.code, "NETWORK_ERROR", "gated fallback must retain the network result");
const networkReads = gatedReads.filter(
  (event): event is Extract<ReplicationEvent, { type: "replication.read" }> => event.type === "replication.read",
);
assert.equal(networkReads.length, 1, "covered gated read must report exactly one network result");
assert.deepEqual(
  { source: networkReads[0].source, reason: networkReads[0].reason, outcome: networkReads[0].outcome, code: networkReads[0].code },
  { source: "network", reason: "replica_gated", outcome: "error", code: "REPLICA_GATED" },
);
const gatedLoader = optional.browserReplicaPlugin.loaders.gatedNetwork;
optional.browserReplicaPlugin.loaders.gatedNetwork = async () => { throw new Error("gated chunk unavailable"); };
try {
  const stillNetwork = await root.TinyCloudWeb.create({ ...config, provider });
  assert.equal((await stillNetwork.restoreSession(proof.address)).status, "restored",
    "a missing optional observer must not fail signed network restoration");
  assert.equal((await stillNetwork.replication.status())[0].gate, "stamp_stale");
  const result = await stillNetwork.kv.get("notes/a");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NETWORK_ERROR");
  assert.equal(result.error.message, "offline by fixture",
    "a missing optional observer must leave the real network KV path usable");
} finally {
  optional.browserReplicaPlugin.loaders.gatedNetwork = gatedLoader;
}
await web.signOut();
assert("refused" in authority.plan("notes/"), "old authority survived sign-out and key rotation");
console.log(`${format}: built core+optional signed owner restore, single registration and stale-session fence passed`);
