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

  test("a connection opened after the purge is fenced until it initializes", async () => {
    // The post-purge generation trap Sol found: a store opened *after* the
    // purge records the tombstone's own generation, so generation equality
    // alone cannot fence it — `purged` must be part of the fence. Before
    // init, every read and every mutation is RESET_REQUIRED, including the
    // trivial forms that short-circuit before touching rows.
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    await purgeReplicaStore(store, { locks: fakeLocks().locks, replicaId });

    const late = await IndexedDbReplicaStore.open(replicaId, { holder: "holder-late" });
    // open() alone may see the tombstone — its null is the not-created
    // signal init needs to reinitialize in place.
    expect(await late.open()).toBeNull();
    await rejectsWith(late.hasContent([]), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.hasContent(["f".repeat(64)]), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.readContent("not-a-hash"), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.get("notes/a"), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.list({}), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.status(), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.pendingRepairs(10), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.commitSerial(), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.acquireSyncLease(60_000), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.claimWriterLock(), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.installGrant(deviceGrant({ prefix: "notes/" })), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.setRetentionGrant("bafyretain"), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(late.markRevoked("delegation-revoked: bafy"), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(
      late.recordError({ at: "2026-10-07T00:00:00.000Z", code: ReplicaErrorCode.STORAGE_ERROR, message: "x" }),
      ReplicaErrorCode.RESET_REQUIRED,
    );
    await rejectsWith(
      late.reset({ token: 1, holder: "holder-late" }, "manual"),
      ReplicaErrorCode.RESET_REQUIRED,
    );

    // init at generation + 1 clears the marker; the same store then works.
    const raw = await holdOpen(replicaDatabaseName(replicaId));
    const tombstoneGeneration = (await metaThrough(raw))!.generation!;
    raw.close();
    await late.init(config({ replicaId }));
    await late.installGrant(deviceGrant({ prefix: "notes/" }));
    const node = new FakeNode();
    node.put("notes/a", "restarted");
    await new Replica({ store: late, transport: node }).sync();
    const revived = (await late.open())!;
    expect(revived.generation).toBe(tombstoneGeneration + 1);
    const entry = await late.get("notes/a");
    if (entry === undefined || entry.deleted) throw new Error("entry missing");
    expect(text0(await late.readContent(entry.hash))).toBe("restarted");
    await late.close();
  });

  test("finishPurgeIfPending refuses a tombstone from a foreign generation", async () => {
    // A opened under G; a purge stamps the tombstone at G+1. The tombstone
    // no-op must come after the generation check — otherwise A's open-time
    // repair silently "succeeds" against a purge it did not perform.
    const replicaId = nextId();
    const storeA = await newStore(replicaId, "holder-a");
    const purger = await IndexedDbReplicaStore.open(replicaId, { holder: "holder-purger" });
    await purger.claimWriterLock();
    await purger.destroy((await purger.acquireSyncLease(60_000))!);

    await rejectsWith(storeA.finishPurgeIfPending(), ReplicaErrorCode.RESET_REQUIRED);

    // The same-generation path still no-ops, as static open() needs: a
    // fresh connection reading the tombstone resolves without touching it.
    const fresh = await IndexedDbReplicaStore.open(replicaId, { holder: "holder-fresh" });
    await fresh.finishPurgeIfPending();
    const raw = await holdOpen(replicaDatabaseName(replicaId));
    try {
      const meta = await metaThrough(raw);
      expect(meta?.purged).toBe(true);
    } finally {
      raw.close();
    }
    await fresh.close();
    await storeA.close().catch(() => undefined);
    await purger.close().catch(() => undefined);
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
      expect(meta?.leaseHolder).toBeUndefined();
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

  test("the tombstone keeps no user data: raw dump has no config, grant, CID or error text", async () => {
    // The purge result is a minimal marker — only `purged`, `generation`,
    // `writerEpoch` and `purgePending` may survive. Everything else in meta
    // (config name/host/space/prefix, retention CID, grant, error text) is
    // user data and must not be readable after the commit.
    const replicaId = nextId();
    const store = await IndexedDbReplicaStore.open(replicaId, { holder: "holder-secrets" });
    await store.init(
      config({
        replicaId,
        name: "Private project name",
        host: "https://private-host.example",
        space: "space-private-9f2c",
        prefix: "notes-secret-fragile/",
        retentionGrantCid: "bafyreigetentioncid000000000000000000000000000000000000aa",
      }),
    );
    await store.installGrant(deviceGrant({ prefix: "notes-secret-fragile/" }));
    const node = new FakeNode("notes-secret-fragile/");
    node.space = "space-private-9f2c";
    node.put("notes-secret-fragile/launch-codes", "hunter2-launch");
    await new Replica({ store, transport: node }).sync();

    // A learned refusal text that names a key: it must die with the purge.
    await store.recordError({
      at: "2026-10-07T00:00:00.000Z",
      code: ReplicaErrorCode.STORAGE_ERROR,
      message: "could not write the entry for the key notes-secret-fragile/launch-codes",
    });

    const result = await purgeReplicaStore(store, { locks: fakeLocks().locks, replicaId });
    expect(result).toEqual({ purged: true });

    // Raw dump of every object store through a fresh, direct connection.
    const raw = await holdOpen(replicaDatabaseName(replicaId));
    try {
      const dumpAll = (storeName: string): Promise<unknown[]> =>
        new Promise((resolve, reject) => {
          const request = raw.transaction(storeName).objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const metaRows = await dumpAll("meta");
      const entries = await dumpAll("entries");
      const blobs = await dumpAll("blobs");
      const whole = JSON.stringify({ metaRows, entries, blobs });
      for (const forbidden of [
        "Private project name",
        "private-host.example",
        "space-private-9f2c",
        "notes-secret-fragile",
        "launch-codes",
        "bafyreigetentioncid000000000000000000000000000000000000aa",
        "hunter2-launch",
        "could not write",
      ]) {
        expect(whole).not.toContain(forbidden);
      }
      // The marker itself: exactly the fields the fence and reopen need.
      expect(metaRows).toHaveLength(1);
      const marker = metaRows[0] as Record<string, unknown>;
      expect(marker.purged).toBe(true);
      expect(typeof marker.generation).toBe("number");
      expect(Object.keys(marker).sort()).toEqual(["generation", "purgePending", "purged", "writerEpoch"]);
      expect(entries).toEqual([]);
      expect(blobs).toEqual([]);
    } finally {
      raw.close();
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
      expect(meta?.leaseHolder).toBeUndefined();
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

  test("delayed recovery connections cannot overwrite or read a replica synced after the purge", async () => {
    const replicaId = nextId();
    const store = await newStore(replicaId, "holder-purger");
    await purgeReplicaStore(store, { locks: fakeLocks().locks, replicaId });

    // Two recovery connections open against the tombstone — generation G —
    // then stall; the fresh open initializes and *syncs real data* at
    // generation G+1 before they resume.
    const delayed1 = await IndexedDbReplicaStore.open(replicaId, { holder: "r1" });
    const delayed2 = await IndexedDbReplicaStore.open(replicaId, { holder: "r2" });
    const winner = await IndexedDbReplicaStore.open(replicaId, { holder: "r3" });
    await winner.init(config({ replicaId }));
    await winner.installGrant(deviceGrant({ prefix: "notes/" }));
    const node = new FakeNode();
    node.put("notes/survivor", "post-purge bytes");
    await new Replica({ store: winner, transport: node }).sync();
    const won = (await winner.open())!;
    const wonEntry = (await winner.get("notes/survivor"))!;
    if (wonEntry.deleted) throw new Error("entry missing");
    const wonHash = wonEntry.hash;

    // The delayed connections resume: every path is fenced — init, reads,
    // leases and writes all refuse with RESET_REQUIRED.
    await rejectsWith(delayed1.init(config({ replicaId })), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(delayed2.init(config({ replicaId })), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(delayed1.get("notes/survivor"), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(delayed2.readContent(wonHash), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(delayed1.acquireSyncLease(60_000), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(delayed2.hasContent([wonHash]), ReplicaErrorCode.RESET_REQUIRED);
    // Even the trivial short-circuits refuse: empty hasContent and a
    // malformed readContent hash are fenced too.
    await rejectsWith(delayed1.hasContent([]), ReplicaErrorCode.RESET_REQUIRED);
    await rejectsWith(delayed2.readContent("not-a-hash"), ReplicaErrorCode.RESET_REQUIRED);

    // The winner's data, cursor and generation survived the resumed
    // connections entirely intact.
    const after = (await winner.open())!;
    expect(after.generation).toBe(won.generation);
    expect(after.cursor).toBe(won.cursor);
    expect(text0(await winner.readContent(wonHash))).toBe("post-purge bytes");
    await delayed1.close();
    await delayed2.close();
    await winner.close();
  });

  test("the purging client's own calls surface RESET_REQUIRED through the worker session", async () => {
    // Drive the real worker module: `reset({purge:true})` must leave a
    // *fenced* session behind so the client's next status/list/get return
    // RESET_REQUIRED — never NOT_FOUND. Restoring the worker's old
    // `session = null` makes this fail at the dispatch layer.
    const replies: Array<{ id: number; ok: boolean; result?: unknown; err?: { code: string } }> = [];
    const events: Array<{ event: string }> = [];
    const scope = self as unknown as { postMessage?: (m: unknown) => void; onmessage: unknown };
    const original = scope.postMessage;
    scope.postMessage = (m: unknown) => {
      const msg = m as { id?: number; ok?: boolean; result?: unknown; err?: { code: string }; event?: { event: string } };
      if (typeof msg.id === "number") replies.push(msg as (typeof replies)[number]);
      else if (msg.event !== undefined) events.push(msg.event);
    };
    try {
      // Dynamic import is required: the worker's `void main()` runs at
      // module evaluation and posts through self.postMessage, so the stub
      // above must exist before the module loads — a static import would
      // run main() before the test can install it.
      await import("../worker.js");
      // The worker signals readiness after its WASM init resolves.
      for (let i = 0; i < 200 && !events.some((e) => e.event === "ready"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(events.some((e) => e.event === "ready")).toBe(true);
      const onmessage = scope.onmessage as (m: MessageEvent) => void;
      const send = async (id: number, request: Record<string, unknown>) => {
        onmessage({ data: { id, ...request } } as MessageEvent);
        for (let i = 0; i < 200 && !replies.some((r) => r.id === id); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const reply = replies.find((r) => r.id === id);
        if (reply === undefined) throw new Error(`no reply for op ${String(request.op)}`);
        return reply;
      };
      const openReply = await send(1, {
        op: "open",
        host: "http://replica.test",
        space: "space-worker",
        prefix: "notes/",
        principal: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
      });
      expect(openReply.ok).toBe(true);

      const reset = await send(2, { op: "reset", purge: true });
      expect(reset.ok).toBe(true);
      expect(reset.result).toEqual({ reset: true, purged: true });

      // The kept-but-fenced session: every later call is RESET_REQUIRED.
      // `session = null` would make needSession throw REPLICA_NOT_FOUND.
      for (const [id, request] of [
        [3, { op: "status" }],
        [4, { op: "list" }],
        [5, { op: "get", key: "notes/a" }],
      ] as const) {
        const reply = await send(id, request);
        expect(reply.ok).toBe(false);
        expect(reply.err?.code).toBe("RESET_REQUIRED");
      }
      await send(9, { op: "close" });
    } finally {
      scope.postMessage = original;
    }
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
