/**
 * The TC-18 sync-hardening scenarios (src/sync-hardening.test.ts) run against
 * the IndexedDB store under `fake-indexeddb`. Only genuinely SQLite-level
 * cases are absent: filesystem deletion/recreation of the replica directory,
 * the mutation guard and the WAL checkpoint have no IndexedDB analogue.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { FakeNode, NODE_DID, SPACE, config, deviceGrant, etagOf } from "../../test/fixtures.js";
import { Replica, contentHash } from "../engine.js";
import { ReplicaError, ReplicaErrorCode, isReplicaError } from "../errors.js";
import { kvSyncTransport, type KVSyncClient } from "../transport.js";
import type { GrantRecord, ReplicaStore } from "../types.js";
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

  test("an in-flight page cannot restore the retainUntil a CID swap invalidated (indexeddb)", async () => {
    const { node, store, replica, advance } = await retained();
    expect((await store.open())!.authority?.retainUntil).not.toBeNull();

    // The next sync request is issued under `bafyretain`; mid-request a new
    // CID lands. The page still commits — under the new CID — but its
    // attested retainUntil belongs to the grant the request presented, so
    // the store must not persist it.
    node.onSyncPage = async () => {
      node.onSyncPage = undefined;
      await store.setRetentionGrant("bafyother");
    };
    await replica.sync();
    const state = (await store.open())!;
    expect(state.config.retentionGrantCid).toBe("bafyother");
    expect(state.authority?.retainUntil).toBeNull();
    // Post-expiry the read is a hard GRANT_EXPIRED, not a revived window.
    advance(120_000);
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
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
      window: { notBefore: "not-a-date", expiresAt: null },

      complete: true,
      retentionGrantCid: null,
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
      window: { notBefore: null, expiresAt: null },
      complete: true,
      retentionGrantCid: null,
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
    const late = new TextEncoder().encode("late");
    expect(
      await codeOf(
        store.applyPage(lease, {
          changes: [{ key: "notes/z", deleted: false, etag: etagOf(late), hash: contentHash(late), metadata: {}, content: true }],
          blobs: new Map([[contentHash(late), late]]),
          cursor: "9:9",
          source: { nodeDid: NODE_DID, space: "s", prefix: "notes/" },
          authority: null,
          coverage: "complete",
          at: new Date().toISOString(),
          window: { notBefore: null, expiresAt: null },
          complete: true,
          retentionGrantCid: null,
          promoteGrant: null,
        }),
      ),
    ).toBe(ReplicaErrorCode.BUSY);
    expect(await codeOf(store.reset(lease, "x"))).toBe(ReplicaErrorCode.BUSY);
    expect(await codeOf(store.destroy(lease))).toBe(ReplicaErrorCode.BUSY);
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

describe("retention grant CID binding (indexeddb)", () => {
  test("a refusal of the retain grant a request presented leaves a grant installed meanwhile", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = {
      notBefore: null,
      expiresAt: new Date(now + 60_000).toISOString(),
      retainUntil: new Date(now + 600_000).toISOString(),
    };
    const store = await newIdbStore(
      undefined,
      { localReadPolicy: "retainAfterExpiry", retentionGrantCid: "bafyretain" },
      { now: () => now },
    );
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    node.onSyncPage = async () => {
      node.onSyncPage = undefined;
      await store.setRetentionGrant("bafynewretain");
    };
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, "refused", { reason: "retention-grant-revoked" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.RETENTION_GRANT_REFUSED);
    const state = (await store.open())!;
    // The refused CID was `bafyretain`; the replacement stays installed.
    expect([state.config.retentionGrantCid, state.config.localReadPolicy, state.retentionRevoked]).toEqual([
      "bafynewretain",
      "retainAfterExpiry",
      null,
    ]);
    // The swap cleared the attested retainUntil: after the window the read
    // is a hard GRANT_EXPIRED, not an "expired" status.
    now += 120_000;
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });

  test("changing the retention CID drops the attested retainUntil until a new sync", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = {
      notBefore: null,
      expiresAt: new Date(now + 60_000).toISOString(),
      retainUntil: new Date(now + 600_000).toISOString(),
    };
    const store = await newIdbStore(
      undefined,
      { localReadPolicy: "retainAfterExpiry", retentionGrantCid: "bafyretain" },
      { now: () => now },
    );
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    expect((await store.open())!.authority?.retainUntil).not.toBeNull();

    // A different retain grant cannot inherit the old grant's attestation.
    await store.setRetentionGrant("bafyother");
    expect((await store.open())!.authority?.retainUntil).toBeNull();
    // Re-setting the same CID is a no-op: the attestation stays cleared.
    await store.setRetentionGrant("bafyother");
    expect((await store.open())!.authority?.retainUntil).toBeNull();
    // Clearing the opt-in also drops it.
    await store.setRetentionGrant("bafyretain");
    await replica.sync();
    expect((await store.open())!.authority?.retainUntil).not.toBeNull();
    await store.setRetentionGrant(null);
    expect((await store.open())!.authority?.retainUntil).toBeNull();

    // After the window lapses with no new attestation, reads fail.
    now += 120_000;
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });
});

describe("malformed authority bounds (indexeddb)", () => {
  test("a page with an unparseable bound is a protocol error that changes nothing", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const attested = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    node.authority = attested;
    const store = await newIdbStore(undefined, {}, { now: () => now });
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    const before = (await store.open())!;
    node.put("notes/b", "two");
    for (const bad of [
      { ...attested, expiresAt: "not-a-date" },
      { ...attested, notBefore: "yesterday" },
      { ...attested, retainUntil: "2030" },
    ]) {
      node.authority = bad;
      expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.PROTOCOL_ERROR);
      const after = (await store.open())!;
      expect([after.cursor, after.authority, await store.get("notes/b")]).toEqual([before.cursor, before.authority, undefined]);
    }
    now += 61_000;
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });
});

describe("false revocation (indexeddb)", () => {
  test("a node error fetching a key named like a revocation fails the sync and keeps the replica", async () => {
    const key = "notes/delegation-revoked: bafyx";
    const value = new TextEncoder().encode("kept");
    const kept = new TextEncoder().encode("one");
    let feed = [{ key: "notes/a", deleted: false as const, etag: etagOf(kept), metadata: {} }];
    const sdk: KVSyncClient = {
      changes: async () => ({
        ok: true,
        data: {
          changes: feed,
          more: false,
          cursor: `c${feed.length}`,
          source: { nodeDid: NODE_DID, space: SPACE, prefix: "notes/" },
          authority: { notBefore: null, expiresAt: new Date(Date.now() + 3600_000).toISOString(), retainUntil: null },
        },
      }),
      batchGet: async (keys) =>
        keys.includes(key)
          ? { ok: false, error: { code: "NETWORK_ERROR", message: `Failed to batch read 1 key(s): 500 - storage error reading ${key}`, meta: { status: 500 } } }
          : { ok: true, data: { results: keys.map((k) => ({ key: k, result: { ok: true as const, data: { data: kept, headers: { etag: etagOf(kept) } } } })) } },
      get: async () => ({ ok: false, error: { code: "NETWORK_ERROR", message: `Failed to get key ${JSON.stringify(key)}: 500 - boom`, meta: { status: 500 } } }),
    };
    const store = await newIdbStore();
    const replica = new Replica({ store, transport: kvSyncTransport(sdk) });
    await replica.sync();
    feed = [...feed, { key, deleted: false, etag: etagOf(value), metadata: {} }];
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.NODE_ERROR);
    expect((await store.open())!.revoked).toBeNull();
    const a = await replica.get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("one");
  });
});

describe("replica removal — fenced destroy (indexeddb)", () => {
  test("a stale lease cannot remove a replica another tab took over", async () => {
    const replicaId = nextId();
    const a = await newIdbStore(replicaId);
    const b = await IndexedDbReplicaStore.open(replicaId, { holder: "rival" });
    const stale = (await a.acquireSyncLease(60_000))!;
    await a.releaseLease(stale);
    const live = await b.acquireSyncLease(60_000);
    expect(live).not.toBeNull();
    expect(await codeOf(a.destroy(stale))).toBe(ReplicaErrorCode.BUSY);
    await b.close();
  });

  test("a live lease removes the replica, also a revoked one", async () => {
    const replicaId = nextId();
    const store = await newIdbStore(replicaId);
    const lease = (await store.acquireSyncLease(60_000))!;
    await store.destroy(lease);
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h2" });
    expect(await reopened.open()).toBeNull();
    await reopened.close();

    const revokedId = nextId();
    const dead = await newIdbStore(revokedId);
    await dead.markRevoked("delegation-revoked: bafy");
    // markRevoked invalidated the old lease; a fresh one destroys it.
    const fresh = (await dead.acquireSyncLease(60_000))!;
    await dead.destroy(fresh);
    const reRevoked = await IndexedDbReplicaStore.open(revokedId, { holder: "h3" });
    expect(await reRevoked.open()).toBeNull();
    await reRevoked.close();
  });

  test("a writer resuming after the purge writes no content, also after a reopen", async () => {
    const replicaId = nextId();
    const store = await newIdbStore(replicaId);
    const writer = (await store.acquireSyncLease(60_000))!;
    await store.markRevoked("delegation-revoked: bafy");
    const secret = new TextEncoder().encode("secret");
    expect(
      await codeOf(
        store.applyPage(writer, {
          changes: [{ key: "notes/z", deleted: false, etag: etagOf(secret), hash: contentHash(secret), metadata: {}, content: true }],
          blobs: new Map([[contentHash(secret), secret]]),
          cursor: "9:9",
          source: { nodeDid: NODE_DID, space: "s", prefix: "notes/" },
          authority: null,
          coverage: "complete",
          at: new Date().toISOString(),
          window: { notBefore: null, expiresAt: null },
          complete: true,
          retentionGrantCid: null,
          promoteGrant: null,
        }),
      ),
    ).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await blobCount(replicaId)).toBe(0);
    await store.close();
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h2" });
    expect((await reopened.status()).purgePending).toBe(false);
    await reopened.close();
    expect(await blobCount(replicaId)).toBe(0);
  });
});


describe("authority after a local read (indexeddb)", () => {
  /** `store`, with `hook` run after `method` has its result and before the caller gets it. */
  function pausedAfter(store: ReplicaStore, method: "readContent" | "list", hook: () => Promise<unknown> | void): ReplicaStore {
    return new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (property !== method) return value.bind(target);
        return async (...args: unknown[]) => {
          const result: unknown = await value.apply(target, args);
          await hook();
          return result;
        };
      },
    }) as ReplicaStore;
  }

  async function synced() {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "secret");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    const store = await newIdbStore(undefined, {}, { now: () => now });
    await new Replica({ store, transport: node, now: () => now }).sync();
    return { store, clock: () => now, expire: () => void (now += 61_000) };
  }

  test("a revocation purged while a get held the bytes returns GRANT_REVOKED, not the bytes", async () => {
    const { store, clock } = await synced();
    const paused = pausedAfter(store, "readContent", () => store.markRevoked("delegation-revoked: bafy"));
    expect(await codeOf(new Replica({ store: paused, now: clock }).get("notes/a"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
  });

  test("an expiry reached while a get held the bytes returns GRANT_EXPIRED, not the bytes", async () => {
    const { store, clock, expire } = await synced();
    const paused = pausedAfter(store, "readContent", expire);
    expect(await codeOf(new Replica({ store: paused, now: clock }).get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });

  test("a list that read its rows before a revocation or an expiry returns the error, not the rows", async () => {
    const revoked = await synced();
    const whileRevoking = pausedAfter(revoked.store, "list", () => revoked.store.markRevoked("delegation-revoked: bafy"));
    expect(await codeOf(new Replica({ store: whileRevoking, now: revoked.clock }).list())).toBe(ReplicaErrorCode.GRANT_REVOKED);
    const expiring = await synced();
    const whileExpiring = pausedAfter(expiring.store, "list", expiring.expire);
    expect(await codeOf(new Replica({ store: whileExpiring, now: expiring.clock }).list())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });
});
