/**
 * The TC-18 sync-hardening scenarios (src/sync-hardening.test.ts) run against
 * the IndexedDB store under `fake-indexeddb`. Only genuinely SQLite-level
 * cases are absent: filesystem deletion/recreation of the replica directory,
 * the mutation guard and the WAL checkpoint have no IndexedDB analogue.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { FakeNode, NODE_DID, config, deviceGrant, etagOf } from "../../test/fixtures.js";
import { Replica } from "../engine.js";
import { ReplicaError, ReplicaErrorCode, isReplicaError } from "../errors.js";
import type { GrantRecord } from "../types.js";
import { openDatabase, requestAsPromise } from "./idb.js";
import { IndexedDbReplicaStore, replicaDatabaseName } from "./store.js";

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
let sequence = 0;
const nextId = () => `r-hardening-${++sequence}`;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isReplicaError(error) ? error.code : String(error);
  }
}

/** A created store (fresh database) with the pending device grant installed. */
async function newIdbStore(
  replicaId = nextId(),
  overrides: Parameters<typeof config>[0] = {},
  options: { now?: () => number; holder?: string } = {},
): Promise<IndexedDbReplicaStore> {
  const store = await IndexedDbReplicaStore.open(replicaId, { holder: options.holder ?? `holder-${replicaId}`, ...(options.now ? { now: options.now } : {}) });
  await store.init(config({ replicaId, ...overrides }));
  await store.installGrant(deviceGrant({ prefix: overrides.prefix ?? "notes/" }));
  return store;
}

async function blobCount(replicaId: string): Promise<number> {
  const db = await openDatabase(replicaDatabaseName(replicaId), () => {});
  try {
    const keys = await requestAsPromise<IDBValidKey[]>(db.transaction("blobs").objectStore("blobs").getAllKeys());
    return keys.length;
  } finally {
    db.close();
  }
}

describe("content reused within one page (indexeddb)", () => {
  test("delete a, then put b with the same bytes", async () => {
    const node = new FakeNode();
    node.put("notes/a", "same bytes");
    const store = await newIdbStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.delete("notes/a");
    node.put("notes/b", "same bytes");
    expect(await replica.sync()).toMatchObject({ changes: 2, fetched: 0 });
    const b = await replica.get("notes/b");
    expect(b.status === "present" && text(b.value)).toBe("same bytes");
    expect((await replica.get("notes/a")).status).toBe("deleted");
  });

  test("update cur v1 to v2, then put prev = v1", async () => {
    const node = new FakeNode();
    node.put("notes/cur", "v1");
    const store = await newIdbStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.put("notes/cur", "v2");
    node.put("notes/prev", "v1");
    await replica.sync();
    const prev = await replica.get("notes/prev");
    const cur = await replica.get("notes/cur");
    expect([prev.status === "present" && text(prev.value), cur.status === "present" && text(cur.value)]).toEqual(["v1", "v2"]);
  });
});

describe("retention grant revocation (indexeddb)", () => {
  async function retained() {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = {
      notBefore: null,
      expiresAt: new Date(now + 60_000).toISOString(),
      retainUntil: new Date(now + 600_000).toISOString(),
    };
    const store = await newIdbStore(undefined, { localReadPolicy: "retainAfterExpiry", retentionGrantCid: "bafyretain" }, { now: () => now });
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    return { node, store, replica, advance: (ms: number) => (now += ms) };
  }

  test("a revoked retain grant is persisted and blocks post-expiry reads with GRANT_REVOKED", async () => {
    const { node, store, replica, advance } = await retained();
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, "refused", { reason: "retention-grant-revoked" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.RETENTION_GRANT_REFUSED);
    const state = (await store.open())!;
    expect(state.retentionRevoked).not.toBeNull();
    expect(state.authority?.retainUntil).toBeNull();
    expect(state.config.retentionGrantCid).toBeNull();
    // Before expiry the sync grant still serves reads.
    expect((await replica.get("notes/a")).status).toBe("present");
    advance(120_000);
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
  });

  test("other retention refusals stay plain errors", async () => {
    const { node, store, replica, advance } = await retained();
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, "refused", { reason: "retention-grant-not-covering" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.RETENTION_GRANT_REFUSED);
    expect((await store.open())!.retentionRevoked).toBeNull();
    advance(120_000);
    expect((await replica.get("notes/a")).meta.authority).toBe("expired");
  });
});

describe("revocation learned while fetching content (indexeddb)", () => {
  test("from the verify fetch: persisted, recorded as lastError, and reads blocked after reopen", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    node.put("notes/b", "two");
    node.failNextFetch = new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "delegation-revoked: bafy");
    expect(await codeOf(new Replica({ store, transport: node }).sync())).toBe(ReplicaErrorCode.GRANT_REVOKED);
    await store.close();
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h2" });
    const state = (await reopened.open())!;
    expect(state.revoked).not.toBeNull();
    expect(state.lastError?.code).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await codeOf(new Replica({ store: reopened }).get("notes/a"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await blobCount(replicaId)).toBe(0);
  });

  test("from the repair fetch", async () => {
    const node = new FakeNode();
    node.put("notes/a", "v1");
    const store = await newIdbStore();
    const replica = new Replica({ store, transport: node });
    const newer = new TextEncoder().encode("v2");
    node.tamper.set("notes/a", { bytes: newer, etag: `"x"` });
    await replica.sync();
    expect((await replica.get("notes/a")).status).toBe("content_missing");
    node.tamper.clear();
    node.failNextFetch = new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "delegation-ancestor-revoked: bafy");
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect((await store.open())!.revoked).not.toBeNull();
  });
});

describe("source pin across an automatic reset (indexeddb)", () => {
  test("a different node after a 410 is SOURCE_CHANGED with nothing committed; an explicit reset re-pins", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newIdbStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.nodeDid = "did:key:z6MkOtherNode";
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RESET_REQUIRED, "reset", { reason: "position-unknown" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.SOURCE_CHANGED);
    const state = (await store.open())!;
    expect(state.nodeDid).toBe(NODE_DID);
    expect(state.cursor).toBeNull();
    expect(await store.get("notes/a")).toBeUndefined();

    await replica.reset("manual");
    await replica.sync();
    expect((await store.open())!.nodeDid).toBe("did:key:z6MkOtherNode");
  });
});

describe("grant promotion and pending-grant fallback (indexeddb)", () => {
  test("promotion is bound to the CID the node validated; a grant installed meanwhile stays pending", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newIdbStore();
    const validated = (await store.open())!.pendingGrant!;
    const newer = deviceGrant({ exp: Math.floor(Date.now() / 1000) + 9000 });
    node.onSyncPage = async () => {
      node.onSyncPage = undefined;
      await store.installGrant(newer);
    };
    await new Replica({ store, transport: node }).sync();
    const state = (await store.open())!;
    expect([state.grant?.cid, state.pendingGrant?.cid]).toEqual([validated.cid, newer.cid]);
  });

  async function withPending() {
    const good = new FakeNode();
    good.put("notes/a", "one");
    const store = await newIdbStore();
    await new Replica({ store, transport: good }).sync();
    const active = (await store.open())!.grant!;
    const pending = deviceGrant({ exp: Math.floor(Date.now() / 1000) + 9000 });
    await store.installGrant(pending);
    const refusing = new FakeNode();
    const transportFor = (grant: GrantRecord) => (grant.cid === pending.cid ? refusing : good);
    return { good, refusing, store, active, pending, replica: new Replica({ store, transportFor }) };
  }

  test("a refused pending grant keeps its error and the active grant serves", async () => {
    const { good, refusing, store, active, pending, replica } = await withPending();
    refusing.failNextSync = new ReplicaError(ReplicaErrorCode.GRANT_UNAUTHORIZED, "401 - ancestor expired");
    good.put("notes/b", "two");
    expect(await replica.sync()).toMatchObject({ changes: 1, promotedGrant: false });
    const state = (await store.open())!;
    expect([state.grant?.cid, state.pendingGrant?.cid]).toEqual([active.cid, pending.cid]);
    expect(state.pendingGrantError?.code).toBe(ReplicaErrorCode.GRANT_UNAUTHORIZED);
    expect((await replica.status()).device.pendingDelegationError?.code).toBe(ReplicaErrorCode.GRANT_UNAUTHORIZED);
  });

  test("a revoked pending grant is discarded without purging the replica", async () => {
    const { refusing, store, active, replica } = await withPending();
    refusing.failNextSync = new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "delegation-revoked: pending");
    await replica.sync();
    const state = (await store.open())!;
    expect(state.revoked).toBeNull();
    expect([state.grant?.cid, state.pendingGrant]).toEqual([active.cid, null]);
    expect((await replica.get("notes/a")).status).toBe("present");
  });
});

describe("authority at the commit boundary (indexeddb)", () => {
  test("a page whose content fetch crosses the expiry instant does not commit", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    node.onFetch = () => {
      now += 61_000;
    };
    const store = await newIdbStore(undefined, {}, { now: () => now });
    expect(await codeOf(new Replica({ store, transport: node, now: () => now }).sync())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    const state = (await store.open())!;
    expect([state.cursor, await store.get("notes/a")]).toEqual([null, undefined]);
  });

  test("a repair whose fetch crosses the expiry instant does not commit", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "v1");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    const store = await newIdbStore(undefined, {}, { now: () => now });
    const replica = new Replica({ store, transport: node, now: () => now });
    node.tamper.set("notes/a", { bytes: new TextEncoder().encode("v2"), etag: `"x"` });
    await replica.sync();
    node.tamper.clear();
    node.onFetch = () => {
      now += 61_000;
    };
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    expect((await store.get("notes/a")) as { content?: boolean }).toMatchObject({ content: false });
  });

  test("a malformed authority timestamp is PROTOCOL_ERROR and commits nothing", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newIdbStore();
    const lease = (await store.acquireSyncLease(60_000))!;
    const page = {
      changes: [{ key: "notes/a", deleted: false as const, etag: etagOf(new TextEncoder().encode("one")), hash: "", metadata: {}, content: false }],
      blobs: new Map<string, Uint8Array>(),
      cursor: "1:1",
      source: { nodeDid: NODE_DID, space: "s", prefix: "notes/" },
      authority: null,
      coverage: "complete" as const,
      at: new Date().toISOString(),
      now: Date.now(),
      window: { notBefore: "not-a-date", expiresAt: null },
      complete: true,
      promoteGrant: null,
    };
    expect(await codeOf(store.applyPage(lease, page))).toBe(ReplicaErrorCode.PROTOCOL_ERROR);
    expect((await store.open())!.cursor).toBeNull();
  });
});

describe("revocation purge fencing (indexeddb)", () => {
  test("an outstanding writer cannot commit, collect or reset after the purge", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    const writer = (await store.acquireSyncLease(60_000))!;
    await store.markRevoked("delegation-revoked: bafy");
    const page = {
      changes: [{ key: "notes/z", deleted: true as const }],
      blobs: new Map<string, Uint8Array>(),
      cursor: "9:9",
      source: { nodeDid: NODE_DID, space: "s", prefix: "notes/" },
      authority: null,
      coverage: "complete" as const,
      at: new Date().toISOString(),
      now: Date.now(),
      window: { notBefore: null, expiresAt: null },
      complete: true,
      promoteGrant: null,
    };
    expect(await codeOf(store.applyPage(writer, page))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await codeOf(store.collectGarbage(writer))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await codeOf(store.reset(writer, "x"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await store.list({})).toEqual([]);
    expect(await blobCount(replicaId)).toBe(0);
  });
});

describe("lease and reader timing (indexeddb)", () => {
  test("the lease is renewed with the configured TTL while content is fetched", async () => {
    let now = Date.now();
    const replicaId = nextId();
    const node = new FakeNode();
    for (let index = 0; index < 250; index += 1) node.put(`notes/k${index}`, `value ${index}`);
    const store = await newIdbStore(replicaId, {}, { now: () => now });
    const rival = await IndexedDbReplicaStore.open(replicaId, { holder: "rival", now: () => now });
    const stolen: boolean[] = [];
    node.onFetch = async () => {
      now += 40_000;
      stolen.push((await rival.acquireSyncLease(1000)) !== null);
    };
    await new Replica({ store, transport: node, now: () => now, leaseTtlMs: 50_000 }).sync();
    expect(stolen).toEqual([false, false, false]);
  });

  test("an expired lease fences the holder out", async () => {
    let now = Date.now();
    const replicaId = nextId();
    const store = await newIdbStore(replicaId, {}, { now: () => now });
    const lease = (await store.acquireSyncLease(1000))!;
    now += 2000;
    expect(await codeOf(store.renewLease(lease, 1000))).toBe(ReplicaErrorCode.BUSY);
    expect(await codeOf(store.collectGarbage(lease))).toBe(ReplicaErrorCode.BUSY);
    // A new holder can take over once the old lease expired.
    const rival = await IndexedDbReplicaStore.open(replicaId, { holder: "rival", now: () => now });
    expect(await rival.acquireSyncLease(60_000)).not.toBeNull();
  });

  test("a read racing a sync that replaced the entry and collected its blob re-reads instead of reporting corruption", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newIdbStore();
    await new Replica({ store, transport: node }).sync();
    let first = true;
    const readContent = async (hash: string) => {
      if (first) {
        first = false;
        return undefined; // collected between the entry read and this blob read
      }
      return store.readContent(hash);
    };
    const racing = new Proxy(store, {
      get(target, property) {
        if (property === "readContent") return readContent;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const a = await new Replica({ store: racing }).get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("one");
  });
});
