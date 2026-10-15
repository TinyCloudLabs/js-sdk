/**
 * The durable, identity-scoped `PendingWriteStore` in the origin database
 * (plan §3 "Pending writes"), under `fake-indexeddb` with an in-memory Web
 * Locks stand-in shared by two "tabs".
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";
import { replicationIdentityKey } from "@tinycloud/sdk-services/kv/replication";

import { SPACE } from "../../test/fixtures.js";
import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { KV_DATABASE, KV_STORE, identityKeyHash, kvPartitionEraser, openKvDatabase } from "./schema.js";
import { IndexedDbPendingWriteStore } from "./pending.js";

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

let sequence = 0;
const identity = () => ({
  host: "https://node.example",
  space: SPACE,
  principal: `did:pkh:eip155:1:0x${(++sequence).toString(16).padStart(40, "0")}`,
});

/** A minimal exclusive `LockManager.request` shared by every "tab" in this process. */
function sharedLocks(): { locks: Pick<LockManager, "request">; held: string[] } {
  const tails = new Map<string, Promise<unknown>>();
  const held: string[] = [];
  const locks = {
    request(name: string, ...args: unknown[]): Promise<unknown> {
      const callback = args[args.length - 1] as (lock: Lock | null) => Promise<unknown>;
      const tail = tails.get(name) ?? Promise.resolve();
      const run = tail.then(async () => {
        held.push(name);
        try {
          return await callback({ name, mode: "exclusive" } as Lock);
        } finally {
          held.splice(held.indexOf(name), 1);
        }
      });
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  } as Pick<LockManager, "request">;
  return { locks, held };
}

describe("IndexedDB pending-write store", () => {
  test("is durable: a new store instance reads what an earlier one wrote", async () => {
    const id = identity();
    const { locks } = sharedLocks();
    const first = new IndexedDbPendingWriteStore(id, { locks });
    expect(first.durable).toBe(true);
    expect(await first.read()).toEqual({ v: 2, identity: id, committedEpoch: 0, seq: 0, records: [] });
    await first.update((state) => {
      state.committedEpoch = 3;
      state.seq = 1;
      state.records.push({ opId: "a", seq: 1, key: "notes/a", op: "put", state: "in_flight", epoch: null, at: "2026-10-15T00:00:00.000Z", settledAt: null });
    });
    const later = new IndexedDbPendingWriteStore(id, { locks });
    const state = await later.read();
    expect(state.committedEpoch).toBe(3);
    expect(state.records.map((record) => record.opId)).toEqual(["a"]);
  });

  test("is identity-scoped: two identities never see each other's records", async () => {
    const { locks } = sharedLocks();
    const a = new IndexedDbPendingWriteStore(identity(), { locks });
    const b = new IndexedDbPendingWriteStore(identity(), { locks });
    await a.update((state) => void (state.seq = 9));
    expect((await b.read()).seq).toBe(0);
    expect((await a.read()).seq).toBe(9);
  });

  test("two tabs' concurrent read-modify-writes lose nothing", async () => {
    const id = identity();
    const { locks } = sharedLocks();
    const tabA = new IndexedDbPendingWriteStore(id, { locks });
    const tabB = new IndexedDbPendingWriteStore(id, { locks });
    const writes = Array.from({ length: 40 }, (_, index) => {
      const store = index % 2 === 0 ? tabA : tabB;
      return store.update((state) => {
        state.seq += 1;
        state.records.push({ opId: `op${index}`, seq: state.seq, key: `notes/${index}`, op: "put", state: "in_flight", epoch: null, at: "2026-10-15T00:00:00.000Z", settledAt: null });
        return state.seq;
      });
    });
    const seqs = await Promise.all(writes);
    expect(new Set(seqs).size).toBe(40);
    const state = await tabA.read();
    expect(state.seq).toBe(40);
    expect(state.records).toHaveLength(40);
  });

  test("update holds the identity's Web Lock across its read-modify-write", async () => {
    const id = identity();
    const { locks, held } = sharedLocks();
    const store = new IndexedDbPendingWriteStore(id, { locks });
    const inside = await store.update(() => [...held]);
    expect(inside).toHaveLength(1);
    expect(inside[0]).toContain("tinycloud-replica-kv:pending:");
    expect(held).toHaveLength(0);
  });

  test("a throwing mutation writes nothing", async () => {
    const id = identity();
    const store = new IndexedDbPendingWriteStore(id, { locks: sharedLocks().locks });
    await store.update((state) => void (state.seq = 1));
    await expect(
      store.update((state) => {
        state.seq = 99;
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    expect((await store.read()).seq).toBe(1);
  });

  test("a record belonging to another identity is STORAGE_ERROR, never shared", async () => {
    const id = identity();
    const db = (await openKvDatabase({ create: true }))!;
    const tx = db.transaction(KV_STORE.pending, "readwrite");
    tx.objectStore(KV_STORE.pending).put({ v: 2, identity: identity(), committedEpoch: 0, seq: 0, records: [] }, identityKeyHash(replicationIdentityKey(id)));
    await transactionDone(tx);
    db.close();
    await expect(new IndexedDbPendingWriteStore(id, { locks: sharedLocks().locks }).read()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  test("readExisting never creates the database or a record", async () => {
    await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE) as unknown as IDBRequest<undefined>);
    const store = new IndexedDbPendingWriteStore(identity(), { locks: sharedLocks().locks });
    expect(await store.readExisting()).toBeUndefined();
    expect((await indexedDB.databases()).some((info) => info.name === KV_DATABASE)).toBe(false);
    await store.update((state) => void (state.seq = 2));
    expect((await store.readExisting())?.seq).toBe(2);
  });

  test("kvPartitionEraser.eraseIdentityPending removes one identity's record in the caller's transaction", async () => {
    const { locks } = sharedLocks();
    const a = identity();
    const b = identity();
    await new IndexedDbPendingWriteStore(a, { locks }).update((state) => void (state.seq = 1));
    await new IndexedDbPendingWriteStore(b, { locks }).update((state) => void (state.seq = 1));
    const db = (await openKvDatabase({ create: false }))!;
    const tx = db.transaction(KV_STORE.pending, "readwrite");
    await kvPartitionEraser.eraseIdentityPending(tx, replicationIdentityKey(a));
    await transactionDone(tx);
    db.close();
    expect(await new IndexedDbPendingWriteStore(a, { locks }).readExisting()).toBeUndefined();
    expect((await new IndexedDbPendingWriteStore(b, { locks }).readExisting())?.seq).toBe(1);
  });
});
