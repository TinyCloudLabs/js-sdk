/**
 * Purge lifecycle (TC-19 review): the Web Lock is taken before the durable
 * lease; the erase commit (clear + `purged` marker + lease release) is the
 * point of no return; the file deletion is bounded — a queued delete that
 * outlives the bound resolves "pending", an errored one "failed", and the
 * marker makes the tombstone read as RESET_REQUIRED until the next open
 * finishes the deletion.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { config, deviceGrant } from "../../test/fixtures.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { purgeReplicaStore } from "./purge.js";
import { IndexedDbReplicaStore, deleteReplicaDatabase, replicaDatabaseName } from "./store.js";

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

let sequence = 0;
const nextId = () => `r-purge-${++sequence}`;
const lockName = (replicaId: string) => `tinycloud-replica:${replicaId}`;

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

async function newStore(replicaId: string, holder: string, now?: () => number): Promise<IndexedDbReplicaStore> {
  const store = await IndexedDbReplicaStore.open(replicaId, {
    holder,
    ...(now === undefined ? {} : { now }),
  });
  await store.init(config({ replicaId }));
  await store.installGrant(deviceGrant({ prefix: "notes/" }));
  return store;
}

/**
 * A fake Web Locks manager: `held` names are already taken. With
 * `ifAvailable` the callback runs with `null`, exactly like the browser.
 */
function fakeLocks(held: string[] = []): LockManager {
  return {
    async request(
      name: string,
      options: { ifAvailable?: boolean } | ((lock: { name: string } | null) => unknown),
      callback?: (lock: { name: string } | null) => unknown,
    ): Promise<unknown> {
      const cb = typeof options === "function" ? options : callback!;
      const ifAvailable = typeof options === "object" && options !== null && options.ifAvailable === true;
      if (held.includes(name)) {
        if (!ifAvailable) return new Promise(() => undefined); // wait forever
        return cb(null);
      }
      return cb({ name });
    },
  } as unknown as LockManager;
}

describe("purge ordering (indexeddb)", () => {
  test("a busy Web Lock reports REPLICA_BUSY and leaves an expired lease row untouched", async () => {
    // Ordering A: writer A holds the Web Lock; A's lease already expired (the
    // crashed-holder case). The purge must fail at the lock — the old code
    // took the (expired → free) lease first and leaked it.
    const replicaId = nextId();
    let clock = 1_000;
    const now = () => clock;
    const writerA = await newStore(replicaId, "holder-a", now);
    expect(await writerA.acquireSyncLease(60_000)).not.toBeNull();
    clock = 1_000 + 61_000; // A's lease row is now expired.

    const purger = await newStore(replicaId, "holder-purger", now);
    const lock = fakeLocks([lockName(replicaId)]);
    await rejectsWith(purgeReplicaStore(purger, { locks: lock, replicaId }), ReplicaErrorCode.BUSY);

    // A live leaked lease would block this acquire; the expired row is still
    // free because the purge never took it.
    expect(await purger.acquireSyncLease(60_000)).not.toBeNull();
    await writerA.close();
    await purger.close();
  });

  test("a busy Web Lock reports REPLICA_BUSY and never steals a live lease", async () => {
    // Ordering B: writer A holds the Web Lock with a live lease. The purge
    // must report BUSY and leave A's lease alone — the leaked-lease version
    // blocked A's next sync until expiry.
    const replicaId = nextId();
    const writerA = await newStore(replicaId, "holder-a");
    expect(await writerA.acquireSyncLease(60_000)).not.toBeNull();

    const purger = await newStore(replicaId, "holder-purger");
    const lock = fakeLocks([lockName(replicaId)]);
    await rejectsWith(purgeReplicaStore(purger, { locks: lock, replicaId }), ReplicaErrorCode.BUSY);

    // A's live lease still blocks another acquire — it was not stolen.
    expect(await purger.acquireSyncLease(60_000)).toBeNull();
    await writerA.close();
    await purger.close();
  });

  test("a failed erase releases the lease it took", async () => {
    // The lease lands inside the lock; when the erase commit throws, the
    // purge must hand it back on the still-open connection instead of
    // fencing out every later writer for the TTL.
    const replicaId = nextId();
    const purger = await newStore(replicaId, "holder-purger");
    const destroy = purger.destroy.bind(purger);
    purger.destroy = async () => {
      throw new ReplicaError(ReplicaErrorCode.BUSY, "simulated destroy failure");
    };
    try {
      await rejectsWith(purgeReplicaStore(purger, { locks: fakeLocks([]), replicaId }), ReplicaErrorCode.BUSY);
      // The lease was released: a fresh acquire succeeds at once.
      const next = await purger.acquireSyncLease(60_000);
      expect(next).not.toBeNull();
    } finally {
      purger.destroy = destroy;
      await purger.close();
    }
  });

  test("an uncontended purge deletes the database and reports it", async () => {
    const replicaId = nextId();
    const purger = await newStore(replicaId, "holder-purger");
    expect(await purgeReplicaStore(purger, { locks: fakeLocks([]), replicaId })).toEqual({
      purged: true,
      deletion: "complete",
    });
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h3" });
    expect(await reopened.open()).toBeNull();
    await reopened.close();
  });

  test("a purge blocked past the bound resolves pending — data gone, locks released, delete completes later", async () => {
    // The never-closing connection: `blocked` stays true forever, so the
    // pre-bound code hung holding the Web Lock and the lease. Now the erase
    // commit makes the purge logical before the file goes, the bounded wait
    // resolves "pending", and the queued delete finishes when the blocker
    // finally closes.
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    const name = replicaDatabaseName(replicaId);
    // Two connections the purge cannot close: `holder` ignores
    // `versionchange` forever, `sibling` is a real store opened before the
    // delete queues — its connection outlives the queued delete, which is
    // the only way to observe the tombstone (an `open` issued after the
    // delete queues sits behind it, like a real browser).
    const sibling = await newStore(replicaId, "holder-sibling");
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const lease = (await store.acquireSyncLease(60_000))!;
      let purgedNotified = 0;
      const outcome = await store.destroy(lease, {
        deleteWaitMs: 150,
        onPurged: () => (purgedNotified += 1),
      });
      expect(outcome).toBe("pending");
      // The reset broadcast fired with the erase commit, before the delete.
      expect(purgedNotified).toBe(1);

      // The lease died inside the erase commit: the sibling's still-open
      // connection sees the tombstone — RESET_REQUIRED on every path, no
      // live lease row, and empty entries/blobs via getAllKeys.
      await rejectsWith(sibling.open(), ReplicaErrorCode.RESET_REQUIRED);
      await rejectsWith(sibling.acquireSyncLease(60_000), ReplicaErrorCode.RESET_REQUIRED);
      // Row-level reads fail closed too — the erase commit ran, the marker
      // is set, and every surface reports the purge, not empty data.
      await rejectsWith(sibling.list({}), ReplicaErrorCode.RESET_REQUIRED);

      // The blocker lets go: the queued delete completes on its own, the
      // file is gone, and the next raw open creates a fresh database.
      holder.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const recreated = await new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          const db = request.result;
          db.close();
          resolve(false);
        };
        request.onupgradeneeded = () => {
          (request.result as IDBDatabase).close();
          resolve(true);
        };
        request.onerror = () => reject(request.error);
      });
      expect(recreated).toBe(true);
      // The raw probe created a store-less database — drop it, then a fresh
      // replica acquires its lease immediately: nothing was stranded.
      expect(await deleteReplicaDatabase(replicaId)).toBe("complete");
      const fresh = await newStore(replicaId, "holder-fresh");
      expect(await fresh.acquireSyncLease(60_000)).not.toBeNull();
    } finally {
      holder.close();
      await sibling.close().catch(() => undefined);
    }
  });

  test("a deletion error resolves failed, strands no lease, and the next open finishes the delete", async () => {
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    const name = replicaDatabaseName(replicaId);
    const lease = (await store.acquireSyncLease(60_000))!;

    // Inject the failure at the IDB request — not by stubbing destroy — so
    // the real close/delete path runs.
    const realDelete = fakeIndexedDB.deleteDatabase.bind(fakeIndexedDB);
    fakeIndexedDB.deleteDatabase = (() => {
      const request: Record<string, unknown> = {
        error: new DOMException("injected failure", "UnknownError"),
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => (request.onerror as ((event: unknown) => void) | null)?.({ target: request }));
      return request;
    }) as unknown as typeof indexedDB.deleteDatabase;
    let outcome;
    try {
      outcome = await store.destroy(lease);
    } finally {
      fakeIndexedDB.deleteDatabase = realDelete;
    }
    expect(outcome).toBe("failed");

    // The lease was released inside the erase commit — not through the
    // closed connection — so nothing strands it for ~60 s.
    const meta = await new Promise<{ leaseHolder: string | null; purged?: boolean }>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction("meta").objectStore("meta").get("state");
        get.onsuccess = () => {
          db.close();
          resolve(get.result);
        };
        get.onerror = () => reject(get.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(meta.purged).toBe(true);
    expect(meta.leaseHolder).toBeNull();

    // The next open sees the marker, finishes the deletion, and reports
    // RESET_REQUIRED; the open after that recreates cleanly.
    const second = await IndexedDbReplicaStore.open(replicaId, { holder: "h-second" }).catch((error) => error);
    expect(second).toBeInstanceOf(ReplicaError);
    expect((second as ReplicaError).code).toBe(ReplicaErrorCode.RESET_REQUIRED);
    const third = await IndexedDbReplicaStore.open(replicaId, { holder: "h-third" });
    expect(await third.open()).toBeNull();
    // And a fresh acquire on the recreated replica succeeds immediately.
    await third.init(config({ replicaId }));
    expect(await third.acquireSyncLease(60_000)).not.toBeNull();
    await third.close();
  });
});
