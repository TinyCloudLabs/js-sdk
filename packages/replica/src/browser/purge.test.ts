/**
 * Purge ordering (TC-19 review): the Web Lock is taken before the durable
 * lease, everything acquired is released on failure, and a delete queued on
 * a non-cooperative connection is waited on — never reported as failed while
 * it is still queued.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { config, deviceGrant } from "../../test/fixtures.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { purgeReplicaStore } from "./purge.js";
import { IndexedDbReplicaStore, replicaDatabaseName } from "./store.js";

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

  test("a failed destroy releases the lease it took", async () => {
    // Release-everything-on-failure: the lease lands inside the lock; when
    // destroy throws, the purge must give the lease back instead of fencing
    // out every later writer for the TTL.
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

  test("an uncontended purge deletes the database", async () => {
    const replicaId = nextId();
    const purger = await newStore(replicaId, "holder-purger");
    await purgeReplicaStore(purger, { locks: fakeLocks([]), replicaId });
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h3" });
    expect(await reopened.open()).toBeNull();
    await reopened.close();
  });

  test("a purge blocked by a non-cooperative connection waits and still deletes — never BUSY for a queued delete", async () => {
    // The `blocked` event means the delete is queued, not failed: a raw
    // connection without a versionchange handler holds it, and the delete
    // completes when the holder lets go.
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    const name = replicaDatabaseName(replicaId);
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const lease = (await store.acquireSyncLease(60_000))!;
      let blocked = 0;
      const destruction = store.destroy(lease, { onDeleteBlocked: () => (blocked += 1) });
      // While the holder is open the delete is queued — not reported as failed.
      const early = await Promise.race([
        destruction.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
      ]);
      expect(early).toBe("pending");
      holder.close();
      await destruction;
      const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h2" });
      expect(await reopened.open()).toBeNull();
      await reopened.close();
      // The blocked hook fired exactly once so the caller could tell
      // siblings (and its own client) the reset is coming.
      expect(blocked).toBe(1);
    } finally {
      holder.close();
    }
  });
});
