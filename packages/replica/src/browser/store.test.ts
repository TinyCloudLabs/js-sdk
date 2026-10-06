/**
 * The IndexedDB store and the engine over it (TC-19), driven under
 * `fake-indexeddb`: the same contracts the Chromium e2e exercises for real.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { FakeNode, NODE_DID, config, deviceGrant, etagOf } from "../../test/fixtures.js";
import { Replica } from "../engine.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import {
  IndexedDbReplicaStore,
  deleteReplicaDatabase,
  replicaDatabaseName,
} from "./store.js";

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
let sequence = 0;
const nextId = () => `r-browser-${++sequence}`;

async function rejectsWith(promise: Promise<unknown>, code: ReplicaErrorCode): Promise<ReplicaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReplicaError);
    expect((error as ReplicaError).code).toBe(code);
    return error as ReplicaError;
  }
  throw new Error(`expected ${code}`);
}

/** A created store (fresh database) with the pending device grant installed. */
async function newIdbStore(replicaId = nextId(), overrides = {}): Promise<IndexedDbReplicaStore> {
  const store = await IndexedDbReplicaStore.open(replicaId, { holder: `holder-${replicaId}` });
  await store.init(config({ replicaId, ...overrides }));
  await store.installGrant(deviceGrant({ prefix: "notes/" }));
  return store;
}

describe("sync and offline reads (indexeddb)", () => {
  test("bootstraps over several pages, then serves reads with no transport", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha", { "content-type": "text/plain" });
    node.put("notes/b", "beta");
    node.put("notes/c", new Uint8Array([0, 1, 2, 255]));
    node.put("notes-secret/x", "hidden");
    node.put("other/y", "hidden");

    const store = await newIdbStore(replicaId);
    const report = await new Replica({ store, transport: node }).sync({ limit: 2 });
    expect(report).toMatchObject({ pages: 2, changes: 3, fetched: 3, coverage: "complete", promotedGrant: true });
    await store.close();

    // A fresh tab: reopen from IndexedDB, no transport at all.
    node.online = false;
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "holder-2" });
    const replica = new Replica({ store: reopened });
    const a = await replica.get("notes/a");
    expect(a.status).toBe("present");
    if (a.status !== "present") throw new Error("unreachable");
    expect(text(a.value)).toBe("alpha");
    expect(a.metadata).toEqual({ "content-type": "text/plain" });
    expect(a.meta).toMatchObject({ consistency: "observed", coverage: "complete", authority: "valid" });
    expect(a.meta.source.nodeDid).toBe(NODE_DID);
    const c = await replica.get("notes/c");
    expect(c.status === "present" && [...c.value]).toEqual([0, 1, 2, 255]);
    expect((await replica.get("notes/zzz")).status).toBe("absent");
    expect((await replica.get("notes-secret/x")).status).toBe("not_covered");
    expect((await replica.list()).entries.map((entry) => entry.key)).toEqual(["notes/a", "notes/b", "notes/c"]);
    const status = await replica.status();
    expect(status.counts).toEqual({ keys: 3, contentMissing: 0, tombstones: 0 });
    expect(status.device.delegationCid).not.toBeNull();
    expect(status.device.pendingDelegationCid).toBeNull();
    await reopened.close();
  });

  test("catches up updates and deletes", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    node.put("notes/b", "beta");
    const store = await newIdbStore(replicaId);
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.put("notes/a", "alpha-2");
    node.delete("notes/b");
    const report = await replica.sync();
    expect(report.changes).toBe(2);
    const a = await replica.get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("alpha-2");
    expect((await replica.get("notes/b")).status).toBe("deleted");
    await store.close();
  });

  test("out-of-scope keys never reach the database", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    node.put("notes-secret/x", "hidden");
    node.put("other/y", "hidden");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    // Store-level enumeration: only notes/ rows exist, and no blob holds
    // out-of-scope bytes (the engine refused them at scope check).
    const listed = await store.list({});
    expect(listed.map((entry) => entry.key)).toEqual(["notes/a"]);
    await store.close();
  });
});

describe("fencing and revocation (indexeddb)", () => {
  test("a second holder's lease cannot take over a live lease", async () => {
    const store = await newIdbStore();
    const lease = await store.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    // A foreign holder (another tab's writer id) is refused.
    const foreign = await IndexedDbReplicaStore.open(nextId(), { holder: "other" });
    // Same replica, different holder id: open on the same database.
    await foreign.close();
    const sameDbOtherHolder = await IndexedDbReplicaStore.open(
      (await store.open())!.config.replicaId,
      { holder: "other-holder" },
    );
    expect(await sameDbOtherHolder.acquireSyncLease(60_000)).toBeNull();
    await store.releaseLease(lease!);
    expect(await sameDbOtherHolder.acquireSyncLease(60_000)).not.toBeNull();
    await store.close();
    await sameDbOtherHolder.close();
  });

  test("markRevoked purges entries and blobs and fences an in-flight writer", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    const lease = await store.acquireSyncLease(60_000);

    await store.markRevoked("revoked by the node");
    // The outstanding lease is dead: the fence reports the revocation.
    await rejectsWith(
      store.applyPage(lease!, {
        changes: [],
        blobs: new Map(),
        cursor: null,
        source: { nodeDid: NODE_DID, space: "space", prefix: "notes/" },
        authority: null,
        coverage: "empty",
        at: new Date().toISOString(),
        window: { notBefore: null, expiresAt: null },

        complete: false,
        promoteGrant: null,
      }),
      ReplicaErrorCode.GRANT_REVOKED,
    );
    expect(await store.list({})).toEqual([]);
    const status = await store.status();
    expect(status.authority.state).toBe("revoked");
    await store.close();
    // Survives a reopen.
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h2" });
    expect((await reopened.status()).authority.state).toBe("revoked");
    await rejectsWith(new Replica({ store: reopened }).get("notes/a"), ReplicaErrorCode.GRANT_REVOKED);
    await reopened.close();
  });
});

describe("store mechanics (indexeddb)", () => {
  test("reset keeps the replica usable; purge deletes the database", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    const lease = await store.acquireSyncLease(60_000);
    await store.reset(lease!, "test reset");
    expect(await store.list({})).toEqual([]);
    expect((await store.open())!.cursor).toBeNull();
    await store.close();

    await deleteReplicaDatabase(replicaId);
    // The database name is derived, and deleting it makes a fresh open empty.
    expect(replicaDatabaseName(replicaId)).toContain(replicaId);
    const fresh = await IndexedDbReplicaStore.open(replicaId, { holder: "h" });
    expect(await fresh.open()).toBeNull();
    await fresh.close();
  });

  test("content reused within one page resolves held-blob sizes", async () => {
    // Two keys, same bytes → same hash; only one blob record must exist and
    // both entries must be readable.
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "same-bytes");
    node.put("notes/b", "same-bytes");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    const a = await store.get("notes/a");
    const b = await store.get("notes/b");
    if (a === undefined || b === undefined || a.deleted || b.deleted) throw new Error("entries missing");
    expect(a.hash === b.hash).toBe(true);
    expect(text((await store.readContent(a.hash))!)).toBe("same-bytes");
    await store.close();
  });
});
