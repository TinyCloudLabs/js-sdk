/**
 * The durable, identity-scoped, gated `PendingWriteStore` in the origin
 * database (plan §3 "Pending writes", CONTRACT.md §1), under `fake-indexeddb`
 * with the adapter's test gate and an in-memory Web Locks stand-in shared by
 * two "tabs".
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";
import type { ReplicaSessionStamp, ReplicationIdentity } from "@tinycloud/sdk-services/kv/replication";

import { SPACE } from "../../test/fixtures.js";
import { createTestGate, type TestGate } from "../../test/test-gate.js";
import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { KV_DATABASE, KV_STORE, identityKeyHashOf, kvPartitionEraser, openKvDatabase } from "./schema.js";
import { createKvWorkerHost } from "./host.js";
import { IndexedDbPendingWriteStore } from "./pending.js";

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

const PRINCIPAL = "did:pkh:eip155:1:0x00000000000000000000000000000000000000d1";
let sequence = 0;
/** Identities of the signed-in principal (a fresh space each), as the controller builds them. */
const identity = () => ({ host: "https://node.example", space: SPACE.replace(":default", `:p${++sequence}`), principal: PRINCIPAL });

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

const record = (opId: string, seq: number) => ({ opId, seq, key: `notes/${opId}`, op: "put" as const, state: "in_flight" as const, epoch: null, at: "2026-10-15T00:00:00.000Z", settledAt: null });

let gate: TestGate;
let stamp: ReplicaSessionStamp;

beforeEach(async () => {
  await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
  gate = createTestGate();
  stamp = await gate.establish(PRINCIPAL);
});

async function identityId(id: ReplicationIdentity): Promise<string> {
  const snapshot = await gate.snapshot();
  if (snapshot === null) throw new Error("Expected an established test gate.");
  return identityKeyHashOf(id, snapshot.gateHmac);
}

describe("IndexedDB pending-write store", () => {
  test("missing Web Locks refuses pending mutations without writing a row", async () => {
    const id = identity();
    const store = new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp });
    await expect(store.update((state) => void (state.seq++))).rejects.toMatchObject({
      code: "REPLICA_GATED", gate: "gate_unavailable",
    });
    expect(await store.readExisting()).toBeUndefined();
  });
  test("worker refuses open before device creation when Web Locks are unavailable", async () => {
    const id = identity();
    const response = Promise.withResolvers<unknown>();
    const worker = createKvWorkerHost({
      gateTx: gate,
      channel: null,
      post: (message) => response.resolve(message),
      createDevice: () => { throw new Error("no device may be minted"); },
      transportFor: () => { throw new Error("no transport may be created"); },
    });
    worker.receive({
      id: 1, op: "open",
      spec: { identity: id, space: id.space, prefix: "notes/", allowSecrets: false, stamp, grantPolicy: { grantTtlMs: 60_000, consentAnchor: null } },
    });
    expect(await response.promise).toMatchObject({ id: 1, ok: false, err: { code: "REPLICA_GATED", detail: { gate: "gate_unavailable" } } });
    const db = (await openKvDatabase({ create: false }))!;
    expect(await requestAsPromise(db.transaction(KV_STORE.meta).objectStore(KV_STORE.meta).count())).toBe(0);
    db.close();
  });


  test("is durable: a new store instance reads what an earlier one wrote", async () => {
    const id = identity();
    const { locks } = sharedLocks();
    const first = new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp, locks });
    expect(first.durable).toBe(true);
    expect(await first.read()).toEqual({ v: 2, identity: id, committedEpoch: 0, seq: 0, records: [] });
    await first.update((state) => {
      state.committedEpoch = 3;
      state.seq = 1;
      state.records.push(record("a", 1));
    });
    const state = await new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp, locks }).read();
    expect(state.committedEpoch).toBe(3);
    expect(state.records.map((entry) => entry.opId)).toEqual(["a"]);
  });

  test("is keyed by a private identity HMAC, and two identities never share a record", async () => {
    const { locks } = sharedLocks();
    const [one, two] = [identity(), identity()];
    await new IndexedDbPendingWriteStore(one, { gateTx: gate, stamp, locks }).update((state) => void (state.seq = 9));
    expect((await new IndexedDbPendingWriteStore(two, { gateTx: gate, stamp, locks }).read()).seq).toBe(0);
    const db = (await openKvDatabase({ create: false }))!;
    const keys = await requestAsPromise(db.transaction(KV_STORE.pending).objectStore(KV_STORE.pending).getAllKeys());
    db.close();
    expect(keys).toEqual([await identityId(one)]);
  });

  test("two tabs' concurrent read-modify-writes lose nothing, under the identity's Web Lock", async () => {
    const id = identity();
    const { locks, held } = sharedLocks();
    const tabA = new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp, locks });
    const tabB = new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp, locks });
    const lockNames = new Set<string>();
    const seqs = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? tabA : tabB).update((state) => {
          held.forEach((name) => lockNames.add(name));
          state.seq += 1;
          state.records.push(record(`op${index}`, state.seq));
          return state.seq;
        }),
      ),
    );
    expect(new Set(seqs).size).toBe(40);
    const state = await tabA.read();
    expect(state.seq).toBe(40);
    expect(state.records).toHaveLength(40);
    expect([...lockNames]).toEqual([`tinycloud-replica-kv:pending:${await identityId(id)}`]);
  });

  test("a throwing mutation writes nothing", async () => {
    const store = new IndexedDbPendingWriteStore(identity(), { gateTx: gate, stamp, locks: sharedLocks().locks });
    await store.update((state) => void (state.seq = 1));
    await expect(
      store.update((state) => {
        state.seq = 99;
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    expect((await store.read()).seq).toBe(1);
  });

  test("ciphertext from another identity cannot be replayed under this identity's key", async () => {
    const [id, other] = [identity(), identity()];
    const locks = sharedLocks().locks;
    await new IndexedDbPendingWriteStore(other, { gateTx: gate, stamp, locks }).update((state) => void (state.seq = 7));
    const [from, to] = await Promise.all([identityId(other), identityId(id)]);
    const db = (await openKvDatabase({ create: false }))!;
    const tx = db.transaction(KV_STORE.pending, "readwrite");
    const row = await requestAsPromise(tx.objectStore(KV_STORE.pending).get(from));
    tx.objectStore(KV_STORE.pending).put(row, to);
    await transactionDone(tx);
    db.close();
    await expect(new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp, locks }).read()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  test("without a stamp, without a gate, or after the gate moved, every call refuses and nothing is written", async () => {
    const id = identity();
    const { locks } = sharedLocks();
    await expect(new IndexedDbPendingWriteStore(id, { gateTx: gate, locks }).read()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "not_established" });
    await expect(new IndexedDbPendingWriteStore(id, { stamp, locks }).update(() => undefined)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });

    const store = new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp, locks });
    await store.update((state) => void (state.seq = 1));
    await gate.deny();
    await expect(store.update((state) => void (state.seq = 2))).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(store.read()).rejects.toMatchObject({ code: "REPLICA_GATED" });
    const fresh = await gate.establish(PRINCIPAL);
    expect((await new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp: fresh, locks }).read()).seq).toBe(0);
  });

  test("a pending intent over the identity makes it unreadable", async () => {
    const id = identity();
    const store = new IndexedDbPendingWriteStore(id, { gateTx: gate, stamp, locks: sharedLocks().locks });
    await store.update((state) => void (state.seq = 1));
    await gate.addIntent({ kind: "pending", identityKeyHash: await identityId(id) });
    await expect(store.read()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "purge_pending" });
  });

  test("readExisting refuses a missing gate without creating a database", async () => {
    await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
    const store = new IndexedDbPendingWriteStore(identity(), { gateTx: gate, stamp, locks: sharedLocks().locks });
    await expect(store.readExisting()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "not_established" });
    expect((await indexedDB.databases()).some((info) => info.name === KV_DATABASE)).toBe(false);
  });

  test("kvPartitionEraser.eraseIdentityPending removes one identity's record in the caller's transaction", async () => {
    const { locks } = sharedLocks();
    const [a, b] = [identity(), identity()];
    await new IndexedDbPendingWriteStore(a, { gateTx: gate, stamp, locks }).update((state) => void (state.seq = 1));
    await new IndexedDbPendingWriteStore(b, { gateTx: gate, stamp, locks }).update((state) => void (state.seq = 1));
    const key = await identityId(a);
    const db = (await openKvDatabase({ create: false }))!;
    const tx = db.transaction(KV_STORE.pending, "readwrite");
    await kvPartitionEraser.eraseIdentityPending(tx, key);
    await transactionDone(tx);
    db.close();
    expect(await new IndexedDbPendingWriteStore(a, { gateTx: gate, stamp, locks }).readExisting()).toBeUndefined();
    expect((await new IndexedDbPendingWriteStore(b, { gateTx: gate, stamp, locks }).readExisting())?.seq).toBe(1);
  });
});
