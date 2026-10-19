/**
 * The single origin database of `@tinycloud/replica/kv-storage` under
 * `fake-indexeddb`: partition naming, partition isolation inside one
 * database, the erase S3 runs, the hook seams S3 and S5 plug into, and the
 * epoch fence. The RC1 engine runs unchanged over the partition layout.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils";
import { replicationIdentityKey } from "@tinycloud/sdk-services/kv/replication";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";

import { FakeNode, SPACE, config, deviceGrant, device } from "../../test/fixtures.js";
import { Replica } from "../engine.js";
import { isReplicaError, ReplicaError, ReplicaErrorCode } from "../errors.js";
import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { IndexedDbReplicaStore, type ReplicaStoreHooks } from "../browser/store.js";
import { ERASE_STORES, KV_DATABASE, KV_STORE, identityKeyHashOf, kvLayout, kvPartitionEraser, openKvDatabase, partitionIdOf } from "./schema.js";

const encoder = new TextEncoder();

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

const identity = { host: "https://node.example", space: SPACE, principal: "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa" };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
let sequence = 0;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isReplicaError(error) ? error.code : String(error);
  }
}

async function partition(
  options: { hooks?: ReplicaStoreHooks; prefix?: string; now?: () => number } = {},
): Promise<{ id: string; store: IndexedDbReplicaStore; db: IDBDatabase }> {
  const id = `p${++sequence}`;
  const db = (await openKvDatabase({ create: true }))!;
  const store = await IndexedDbReplicaStore.openIn(db, {
    holder: `holder-${id}`,
    layout: kvLayout(id),
    ownsDb: true,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  await store.init(config({ replicaId: id, prefix: options.prefix ?? "notes/" }));
  await store.installGrant(deviceGrant({ prefix: options.prefix ?? "notes/" }));
  return { id, store, db };
}

async function rowsOf(storeName: string, id: string): Promise<number> {
  const db = (await openKvDatabase({ create: false }))!;
  try {
    const layout = kvLayout(id);
    return (await requestAsPromise(db.transaction(storeName).objectStore(storeName).getAllKeys(layout.range))).length;
  } finally {
    db.close();
  }
}

describe("origin schema cutover", () => {
  test("read-only inspection does not upgrade plaintext v1; writable open atomically drops its rows", async () => {
    // A preceding v2 test must not prevent the v1 migration scenario.
    const previous = (await openKvDatabase({ create: true }))!;
    previous.close();
    await requestAsPromise(fakeIndexedDB.deleteDatabase(KV_DATABASE));

    let legacy: IDBDatabase | undefined;
    let untouched: IDBDatabase | undefined;
    let upgraded: IDBDatabase | undefined;
    try {
      const legacyRequest = fakeIndexedDB.open(KV_DATABASE, 1);
      legacyRequest.onupgradeneeded = () => legacyRequest.result.createObjectStore(KV_STORE.blobs);
      legacy = await requestAsPromise(legacyRequest);
      const write = legacy.transaction(KV_STORE.blobs, "readwrite");
      const written = transactionDone(write);
      write.objectStore(KV_STORE.blobs).put({ bytes: "legacy plaintext" }, ["partition", "hash"]);
      await written;
      legacy.close();

      expect(await openKvDatabase({ create: false })).toBeNull();
      untouched = await requestAsPromise(fakeIndexedDB.open(KV_DATABASE));
      expect(untouched.version).toBe(1);
      expect(await requestAsPromise(untouched.transaction(KV_STORE.blobs).objectStore(KV_STORE.blobs).count())).toBe(1);
      untouched.close();

      upgraded = (await openKvDatabase({ create: true }))!;
      expect(upgraded.version).toBe(2);
      expect(await requestAsPromise(upgraded.transaction(KV_STORE.blobs).objectStore(KV_STORE.blobs).count())).toBe(0);
      expect(upgraded.objectStoreNames.contains(KV_STORE.gate)).toBe(true);
    } finally {
      legacy?.close();
      untouched?.close();
      upgraded?.close();
      await requestAsPromise(fakeIndexedDB.deleteDatabase(KV_DATABASE));
    }
  });
});

describe("opaque partition lookup", () => {
  test("one gate-keyed identity/prefix lookup resolves every stored and injected device partition", async () => {
    const db = (await openKvDatabase({ create: true }))!;
    const lookupId = `opaque-lookup-${++sequence}`;
    const tx = db.transaction(KV_STORE.partitions, "readwrite");
    const completed = transactionDone(tx);
    const partitions = tx.objectStore(KV_STORE.partitions);
    partitions.put({ lookupId, partitionId: `${lookupId}-owner`, ownerDevice: true }, `${lookupId}-owner`);
    partitions.put({ lookupId, partitionId: `${lookupId}-session`, ownerDevice: false }, `${lookupId}-session`);
    await completed;
    const found = await requestAsPromise<Array<{ lookupId: string; partitionId: string; ownerDevice: boolean }>>(
      db.transaction(KV_STORE.partitions).objectStore(KV_STORE.partitions).index("byLookupId").getAll(lookupId),
    );
    expect(found.map((row) => row.partitionId).sort()).toEqual([`${lookupId}-owner`, `${lookupId}-session`]);
    expect(found.filter((row) => row.ownerDevice).map((row) => row.partitionId)).toEqual([`${lookupId}-owner`]);
    db.close();
  });
});

describe("partition ids", () => {
  const key = () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const expected = async (key: CryptoKey, domain: string, material: string): Promise<string> =>
    bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${domain}\0${material}`))));

  test("private keyed identity and partition ids agree across canonical spellings", async () => {
    const gateKey = await key();
    const a = await partitionIdOf({ identity, prefix: "notes/", deviceDid: device.did }, gateKey);
    const b = await partitionIdOf(
      {
        identity: { ...identity, host: "https://NODE.example/", principal: identity.principal.replace("aa", "AA") },
        prefix: "notes/",
        deviceDid: `${device.did}#${device.did.slice("did:key:".length)}`,
      },
      gateKey,
    );
    expect(a).toBe(b);
    expect(a).toBe(await expected(gateKey, "partition", `${replicationIdentityKey(identity)}\nnotes/\n${device.did}`));
    expect(await identityKeyHashOf(identity, gateKey)).toBe(await expected(gateKey, "identity", replicationIdentityKey(identity)));
  });

  test("prefix, device, principal, space, host and gate key each name a different partition", async () => {
    const gateKey = await key();
    const otherKey = await key();
    const base = await partitionIdOf({ identity, prefix: "notes/", deviceDid: device.did }, gateKey);
    const others = await Promise.all([
      partitionIdOf({ identity, prefix: "notes/deep/", deviceDid: device.did }, gateKey),
      partitionIdOf({ identity, prefix: "notes/", deviceDid: "did:key:z6MkotherDeviceKey" }, gateKey),
      partitionIdOf({ identity: { ...identity, principal: "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb" }, prefix: "notes/", deviceDid: device.did }, gateKey),
      partitionIdOf({ identity: { ...identity, space: SPACE.replace(":default", ":other") }, prefix: "notes/", deviceDid: device.did }, gateKey),
      partitionIdOf({ identity: { ...identity, host: "https://other.example" }, prefix: "notes/", deviceDid: device.did }, gateKey),
      partitionIdOf({ identity, prefix: "notes/", deviceDid: device.did }, otherKey),
    ]);
    expect(new Set([base, ...others]).size).toBe(7);
  });
});

describe("the origin database", () => {
  test("opening without create never creates it", async () => {
    await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
    expect(await openKvDatabase({ create: false })).toBeNull();
    expect((await indexedDB.databases()).some((info) => info.name === KV_DATABASE)).toBe(false);
    const db = (await openKvDatabase({ create: true }))!;
    expect(Array.from(db.objectStoreNames).sort()).toEqual(Object.values(KV_STORE).sort());
    db.close();
    const again = await openKvDatabase({ create: false });
    expect(again).not.toBeNull();
    again!.close();
  });

  test("two partitions sync and read independently inside one database", async () => {
    const one = await partition();
    const two = await partition();
    const nodeOne = new FakeNode();
    const nodeTwo = new FakeNode();
    nodeOne.put("notes/a", "from one");
    nodeTwo.put("notes/a", "from two");
    nodeTwo.put("notes/b", "only two");
    await new Replica({ store: one.store, transport: nodeOne }).sync();
    await new Replica({ store: two.store, transport: nodeTwo }).sync();
    const a1 = await new Replica({ store: one.store }).get("notes/a");
    const a2 = await new Replica({ store: two.store }).get("notes/a");
    expect([a1.status === "present" && text(a1.value), a2.status === "present" && text(a2.value)]).toEqual(["from one", "from two"]);
    expect((await new Replica({ store: one.store }).get("notes/b")).status).toBe("absent");
    expect((await new Replica({ store: one.store }).list()).entries.map((entry) => entry.key)).toEqual(["notes/a"]);
    expect(await rowsOf(KV_STORE.blobs, one.id)).toBe(1);
    expect(await rowsOf(KV_STORE.blobs, two.id)).toBe(2);
  });

  test("reset, revocation and GC stay inside their partition", async () => {
    const one = await partition();
    const two = await partition();
    const node = new FakeNode();
    node.put("notes/a", "shared bytes");
    await new Replica({ store: one.store, transport: node }).sync();
    await new Replica({ store: two.store, transport: node }).sync();
    await new Replica({ store: one.store }).reset("manual");
    await two.store.markRevoked("revoked in test");
    expect(await rowsOf(KV_STORE.entries, one.id)).toBe(0);
    expect(await rowsOf(KV_STORE.entries, two.id)).toBe(0);
    const three = await partition();
    await new Replica({ store: three.store, transport: node }).sync();
    node.put("notes/a", "replaced bytes");
    await new Replica({ store: three.store, transport: node }).sync();
    // GC removed the replaced blob of partition three only.
    expect(await rowsOf(KV_STORE.blobs, three.id)).toBe(1);
  });

});

describe("transaction seams", () => {
  test("with a gate, run opens every transaction, checks first, and a refusal returns and commits nothing", async () => {
    let refuse = false;
    let calls = 0;
    let db: IDBDatabase | undefined;
    const hooks: ReplicaStoreHooks = {
      async run(stores, mode, fn) {
        calls += 1;
        // A gate in the shape of ReplicaGateTx.run: it opens the transaction with its
        // control stores, checks first, then runs the body and resolves after the commit.
        const tx = db!.transaction([...stores, KV_STORE.gate], mode);
        const done = transactionDone(tx);
        await requestAsPromise(tx.objectStore(KV_STORE.gate).get("account"));
        if (refuse) {
          tx.abort();
          await done.catch(() => undefined);
          throw Object.assign(new Error("gated"), { code: "REPLICA_GATED", gate: "stamp_stale" });
        }
        const result = await fn(tx);
        await done;
        return result;
      },
    };
    db = (await openKvDatabase({ create: true }))!;
    const { store } = await partition({ hooks });
    const node = new FakeNode();
    node.put("notes/a", "one");
    await new Replica({ store, transport: node }).sync();
    expect(calls).toBeGreaterThan(5);
    refuse = true;
    const refusal = new Replica({ store }).get("notes/a").catch((error: unknown) => error);
    expect(await refusal).toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    node.put("notes/b", "two");
    expect(await new Replica({ store, transport: node }).sync().catch((error: unknown) => error)).toMatchObject({ code: "REPLICA_GATED" });
    refuse = false;
    expect((await new Replica({ store }).get("notes/b")).status).toBe("absent");
  });

  test("indexPartition runs in the transaction that creates the state row", async () => {
    let indexed = 0;
    await partition({
      hooks: {
        async indexPartition(tx) {
          expect(Array.from(tx.objectStoreNames)).toContain(KV_STORE.partitions);
          indexed += 1;
        },
      },
    });
    expect(indexed).toBe(1);
  });

  test("the ledger hooks see exactly the bytes committed and erased", async () => {
    let ledger = 0;
    const pages: Array<{ blobBytes: number; entries: number; freeBytes: number | null }> = [];
    const hooks: ReplicaStoreHooks = {
      freeBytes: async () => 1_000_000,
      async admitPage(_tx, page) {
        pages.push({ blobBytes: page.blobBytes, entries: page.entries, freeBytes: page.freeBytes });
      },
      async accountCommit(_tx, commit) {
        ledger += commit.deltaBytes;
      },
      async accountErase(_tx, erase) {
        ledger -= erase.bytes;
      },
    };
    const { store } = await partition({ hooks });
    const node = new FakeNode();
    node.put("notes/a", "aaaa");
    node.put("notes/b", "bbbbbb");
    node.put("notes/c", "aaaa");
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    expect(ledger).toBe(10);
    expect(pages[0]).toEqual({ blobBytes: 10, entries: 3, freeBytes: 1_000_000 });
    node.put("notes/b", "cc");
    await replica.sync();
    // b's old blob was collected; c and a still share "aaaa".
    expect(ledger).toBe(6);
    await store.markRevoked("gone");
    expect(ledger).toBe(0);
  });

  test("a refused page commits nothing: no rows, no cursor, no ledger delta", async () => {
    let refuseBytes = Number.POSITIVE_INFINITY;
    let ledger = 0;
    const { id, store } = await partition({
      hooks: {
        async admitPage(_tx, page) {
          if (page.blobBytes > refuseBytes) throw new ReplicaError("STORAGE_BUDGET" as ReplicaErrorCode, "over budget");
        },
        async accountCommit(_tx, commit) {
          ledger += commit.deltaBytes;
        },
      },
    });
    const node = new FakeNode();
    node.put("notes/a", "small");
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    const cursor = (await store.open())!.cursor;
    node.put("notes/big", "x".repeat(100));
    refuseBytes = 50;
    expect(await codeOf(replica.sync())).toBe("STORAGE_BUDGET");
    expect((await store.open())!.cursor).toBe(cursor);
    expect(await rowsOf(KV_STORE.entries, id)).toBe(1);
    expect(ledger).toBe("small".length);
  });

  test("serving reads refuse an elapsed consent window before an expired signed grant", async () => {
    let now = Date.now();
    const day = 24 * 60 * 60 * 1_000;
    const identityId = sequence + 1;
    const { store } = await partition({
      now: () => now,
      hooks: {
        grantPolicy: {
          policy: { grantTtlMs: 2 * day, consentAnchor: { at: now - 6 * day, source: "siwe" } },
          firstInstallKey: `firstInstall:test-${identityId}`,
          installedAtKey: (cid) => `grantInstall:test-${identityId}:${cid}`,
        },
      },
    });
    const node = new FakeNode();
    node.put("notes/a", "private");
    await new Replica({ store, transport: node, now: () => now }).sync();
    expect((await store.get("notes/a"))?.deleted).toBe(false);
    now += day + 1;
    expect(await codeOf(store.get("notes/a"))).toBe(ReplicaErrorCode.CONSENT_EXPIRED);
    expect(await codeOf(store.list({ prefix: "notes/" }))).toBe(ReplicaErrorCode.CONSENT_EXPIRED);
  });
});

describe("epoch fence", () => {
  test("completeSync persists the epoch under the live lease only", async () => {
    const { store } = await partition();
    expect(await store.syncFence()).toEqual({ syncedThroughEpoch: 0, syncCompletedAt: null });
    const lease = (await store.acquireSyncLease(60_000))!;
    await store.completeSync(lease, 7);
    expect((await store.syncFence()).syncedThroughEpoch).toBe(7);
    await store.releaseLease(lease);
    expect(await codeOf(store.completeSync(lease, 9))).toBe(ReplicaErrorCode.BUSY);
    expect((await store.syncFence()).syncedThroughEpoch).toBe(7);
  });
});
