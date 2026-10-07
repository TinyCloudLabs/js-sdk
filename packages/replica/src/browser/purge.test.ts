/**
 * Purge lifecycle — wipe in place (TC-19 round 4): the Web Lock is taken
 * before the durable lease; one readwrite commit clears the data, drops the
 * grant and authority, releases the lease and stamps `{purged, generation+1}`
 * — the point of no return. No `deleteDatabase` exists: a tombstoned store
 * reads the marker inside its own transactions and gets RESET_REQUIRED, and
 * `init` reinitializes the same database under the next generation, so a
 * queued or replayed delete can never bury a replica created after a purge.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { FakeNode, config, deviceGrant } from "../../test/fixtures.js";
import { Replica } from "../engine.js";
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
    if (error instanceof ReplicaError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
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

/** Read the raw meta row through an already-open connection. */
async function metaThrough(db: IDBDatabase): Promise<{ leaseHolder: string | null; purged?: boolean; generation?: number } | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta");
    const get = tx.objectStore("meta").get("state");
    get.onsuccess = () => resolve(get.result as { leaseHolder: string | null; purged?: boolean } | undefined);
    get.onerror = () => reject(get.error);
  });
}

/** Count keys in a store through an already-open connection. */
async function countThrough(db: IDBDatabase, store: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAllKeys();
    request.onsuccess = () => resolve(request.result.length);
    request.onerror = () => reject(request.error);
  });
}

/**
 * A real Web-Locks-shaped fake: `request` queues behind a held name and
 * honors `ifAvailable`; `held()` reports what is taken right now. The purge
 * path under test uses `{ifAvailable: true}` exactly like the browser.
 */
function fakeLocks() {
  const held = new Set<string>();
  const waiters: Array<() => void> = [];
  const drain = () => {
    for (const wake of waiters.splice(0)) wake();
  };
  const locks = {
    async request(
      name: string,
      options: { ifAvailable?: boolean } | ((lock: { name: string } | null) => unknown),
      callback?: (lock: { name: string } | null) => unknown,
    ): Promise<unknown> {
      const cb = (typeof options === "function" ? options : callback!) as (lock: { name: string } | null) => unknown;
      const ifAvailable = typeof options === "object" && options !== null && options.ifAvailable === true;
      for (;;) {
        if (!held.has(name)) {
          held.add(name);
          try {
            return await cb({ name });
          } finally {
            held.delete(name);
            drain();
          }
        }
        if (ifAvailable) return cb(null);
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  } as unknown as LockManager;
  return { locks, isHeld: (name: string) => held.has(name) };
}

/** A raw connection that never closes unless the test closes it. */
async function holdOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("purge lifecycle — wipe in place (indexeddb)", () => {
  test("a busy Web Lock reports REPLICA_BUSY and leaves an expired lease row untouched", async () => {
    const replicaId = nextId();
    let clock = 1_000;
    const now = () => clock;
    const writerA = await newStore(replicaId, "holder-a", now);
    expect(await writerA.acquireSyncLease(60_000)).not.toBeNull();
    clock = 1_000 + 61_000; // A's lease row is now expired.

    const purger = await newStore(replicaId, "holder-purger", now);
    const lockNameHeld = `tinycloud-replica:${replicaId}`;
    // Web Lock genuinely held: a non-ifAvailable request would wait, so the
    // purge must take the busy path — and must not have taken the lease.
    const { locks } = fakeLocks();
    void locks.request(lockNameHeld, () => new Promise(() => undefined)); // held forever
    await rejectsWith(purgeReplicaStore(purger, { locks, replicaId }), ReplicaErrorCode.BUSY);

    // The expired row was never touched: a fresh acquire claims it at once.
    expect(await purger.acquireSyncLease(60_000)).not.toBeNull();
    await writerA.close();
    await purger.close();
  });

  test("a busy Web Lock reports REPLICA_BUSY and never steals a live lease", async () => {
    const replicaId = nextId();
    const writerA = await newStore(replicaId, "holder-a");
    expect(await writerA.acquireSyncLease(60_000)).not.toBeNull();

    const purger = await newStore(replicaId, "holder-purger");
    const { locks } = fakeLocks();
    void locks.request(lockName(replicaId), () => new Promise(() => undefined));
    await rejectsWith(purgeReplicaStore(purger, { locks, replicaId }), ReplicaErrorCode.BUSY);

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
      await rejectsWith(purgeReplicaStore(purger, { locks: fakeLocks().locks, replicaId }), ReplicaErrorCode.BUSY);
      expect(await purger.acquireSyncLease(60_000)).not.toBeNull();
    } finally {
      purger.destroy = destroy;
      await purger.close();
    }
  });

  test("an uncontended purge wipes the replica in place and reports it", async () => {
    const replicaId = nextId();
    const purger = await newStore(replicaId, "holder-purger");
    expect(await purgeReplicaStore(purger, { locks: fakeLocks().locks, replicaId })).toEqual({ purged: true });
    // The same database remains, marked: a fresh open reads the tombstone
    // generation, reports not-created, and init reinitializes it in place.
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h3" });
    expect(await reopened.open()).toBeNull();
    await reopened.close();
  });

  test("a never-closing sibling connection: purge resolves promptly, data gone, generation-fenced", async () => {
    // fake-indexeddb would let deleteDatabase queue forever behind this
    // connection — with wipe-in-place no delete exists at all. The blocker
    // is a raw connection opened before the purge: it keeps reading the
    // tombstone row, proving the erase committed and the lease is gone.
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    const name = replicaDatabaseName(replicaId);
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    await new Replica({ store, transport: node }).sync();

    const sibling = await IndexedDbReplicaStore.open(replicaId, { holder: "holder-sibling" });
    const blocker = await holdOpen(name);
    // Never close it — if purge needed cooperation it would hang here.
    const deleteSpy: string[] = [];
    const realDelete = fakeIndexedDB.deleteDatabase.bind(fakeIndexedDB);
    fakeIndexedDB.deleteDatabase = ((dbName: string) => {
      deleteSpy.push(dbName);
      return realDelete(dbName);
    }) as typeof indexedDB.deleteDatabase;
    try {
      const purged = await purgeReplicaStore(store, { locks: fakeLocks().locks, replicaId });
      expect(purged).toEqual({ purged: true });
      expect(deleteSpy).toEqual([]); // no deleteDatabase call exists

      // Through the blocker's still-open connection: marker set, lease dead,
      // entries and blobs empty — the erase commit ran.
      const meta = await metaThrough(blocker);
      expect(meta?.purged).toBe(true);
      expect(meta?.leaseHolder).toBeNull();
      expect(await countThrough(blocker, "entries")).toBe(0);
      expect(await countThrough(blocker, "blobs")).toBe(0);

      // The Web Lock is free again — ifAvailable would have to wait on it.
      const { locks, isHeld } = fakeLocks();
      let ran = false;
      await locks.request(lockName(replicaId), () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(isHeld(lockName(replicaId))).toBe(false);

      // Reads and writes on old connections all fence on the generation.
      await rejectsWith(store.open(), ReplicaErrorCode.RESET_REQUIRED);
      await rejectsWith(store.list({}), ReplicaErrorCode.RESET_REQUIRED);
      await rejectsWith(sibling.open(), ReplicaErrorCode.RESET_REQUIRED);
      await rejectsWith(sibling.acquireSyncLease(60_000), ReplicaErrorCode.RESET_REQUIRED);
      await rejectsWith(sibling.status(), ReplicaErrorCode.RESET_REQUIRED);

      // A fresh open reinitializes in place and syncs a new replica…
      const fresh = await newStore(replicaId, "holder-fresh");
      const node2 = new FakeNode();
      node2.put("notes/b", "beta");
      await new Replica({ store: fresh, transport: node2 }).sync();
      expect((await fresh.open())!.coverage).toBe("complete");
      const entry = await fresh.get("notes/b");
      if (entry === undefined || entry.deleted) throw new Error("fresh entry missing");
      expect(text0(await fresh.readContent(entry.hash))).toBe("beta");

      // …and the old connections still get RESET_REQUIRED — they never see
      // the new data because their generation is fenced permanently.
      await rejectsWith(store.get("notes/b"), ReplicaErrorCode.RESET_REQUIRED);
      await rejectsWith(sibling.get("notes/b"), ReplicaErrorCode.RESET_REQUIRED);
      await fresh.close();
    } finally {
      blocker.close();
      await sibling.close().catch(() => undefined);
      fakeIndexedDB.deleteDatabase = realDelete;
    }
  });

  test("a post-commit broadcast failure cannot reject the purge", async () => {
    // `onPurged` runs after the erase commit; a throwing channel must be
    // swallowed — the result is already fixed.
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    const result = await purgeReplicaStore(store, {
      locks: fakeLocks().locks,
      replicaId,
      onPurged: () => {
        throw new Error("BroadcastChannel is closed");
      },
    });
    expect(result).toEqual({ purged: true });
    const probe = await holdOpen(replicaDatabaseName(replicaId));
    try {
      const meta = await metaThrough(probe);
      expect(meta?.purged).toBe(true);
      expect(meta?.leaseHolder).toBeNull();
    } finally {
      probe.close();
    }
  });

  test("one purge emits exactly one onPurged", async () => {
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    let notified = 0;
    await purgeReplicaStore(store, {
      locks: fakeLocks().locks,
      replicaId,
      onPurged: () => (notified += 1),
    });
    expect(notified).toBe(1);
  });

  test("two racing reopens plus a fresh open lose no replica after a purge", async () => {
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    await purgeReplicaStore(store, { locks: fakeLocks().locks, replicaId });

    // Three connections race to reinitialize the marked database. Every one
    // that loses the race must surface RESET_REQUIRED — never clobber the
    // winner, never leave the replica half-created.
    const outcomes = await Promise.all(
      ["r1", "r2", "r3"].map(async (holder) => {
        const s = await IndexedDbReplicaStore.open(replicaId, { holder });
        try {
          await s.init(config({ replicaId }));
          return { s, ok: true as const };
        } catch (error) {
          return { s, ok: false as const, code: (error as ReplicaError).code };
        }
      }),
    );
    expect(outcomes.filter((o) => o.ok).length).toBeGreaterThanOrEqual(1);
    for (const loser of outcomes.filter((o) => !o.ok)) {
      expect(loser.code).toBe(ReplicaErrorCode.RESET_REQUIRED);
    }
    // The winner's replica is intact and usable.
    const probe = await IndexedDbReplicaStore.open(replicaId, { holder: "probe" });
    const state = await probe.open();
    expect(state).not.toBeNull();
    expect(state!.config.replicaId).toBe(replicaId);
    for (const o of outcomes) await o.s.close().catch(() => undefined);
    await probe.close();
  });

  test("the purging client's own calls all surface RESET_REQUIRED", async () => {
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    await purgeReplicaStore(store, { locks: fakeLocks().locks, replicaId });
    await rejectsWith(store.status(), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(store.list({}), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(store.get("notes/a"), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(store.acquireSyncLease(60_000), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(store.installGrant(deviceGrant({ prefix: "notes/" })), ReplicaErrorCode.RESET_REQUIRED);
  });

  test("an open-time failure leaves no connection behind", async () => {
    // The generation read runs inside a transaction; if it throws, static
    // open must close the database it already obtained — a leaked open
    // connection would fence the replica DB for a later purge attempt.
    const replicaId = nextId();
    const realOpen = fakeIndexedDB.open.bind(fakeIndexedDB);
    const leakedBox: { value: { closed: boolean } | null } = { value: null };
    fakeIndexedDB.open = ((...args: Parameters<typeof indexedDB.open>) => {
      const request = realOpen(...args);
      const onsuccess = { current: null as null | ((event: Event) => void) };
      Object.defineProperty(request, "onsuccess", {
        set: (handler) => {
          onsuccess.current = handler === null ? null : (event: Event) => {
            const db = request.result;
            const tracker = { closed: false };
            const realClose = db.close.bind(db);
            db.close = () => {
              tracker.closed = true;
              realClose();
            };
            leakedBox.value = tracker;
            // Make the open-time transaction throw — like a blocked or
            // corrupted meta read — then check the connection was closed.
            const realTransaction = db.transaction.bind(db);
            db.transaction = ((...tArgs: unknown[]) => {
              throw new DOMException("injected open failure", "UnknownError");
            }) as typeof db.transaction;
            void realTransaction; // keep the binding honest
            handler(event);
          };
        },
        get: () => onsuccess.current,
      });
      return request;
    }) as typeof indexedDB.open;
    try {
      await rejectsWith(IndexedDbReplicaStore.open(replicaId, { holder: "h" }), ReplicaErrorCode.STORAGE_ERROR);
      expect(leakedBox.value?.closed).toBe(true);
    } finally {
      fakeIndexedDB.open = realOpen;
    }
  });
});

const text0 = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));
