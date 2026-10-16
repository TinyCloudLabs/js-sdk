import { beforeAll, beforeEach, expect, test } from "bun:test";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";

import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { ledgerFor } from "./ledger.js";
import { measureSealedRow } from "./sealed.js";
import { ERASE_STORES, KV_DATABASE, KV_STORE, kvPartitionEraser, openKvDatabase } from "./schema.js";

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

beforeEach(async () => {
  await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
});

test("purge retains measured tombstone usage once, and recreating the same partition charges only the replacement delta", async () => {
  const db = (await openKvDatabase({ create: true }))!;
  const pid = "opaque-partition";
  const entryKey: IDBValidKey = [pid, "opaque-entry"];
  const blobKey: IDBValidKey = [pid, "opaque-blob"];
  const sealed = { v: 1 as const, iv: new Uint8Array(12), bytes: new Uint8Array(48) };
  const meta = {
    ...sealed, pid, revision: 4, generation: 2, coverageCode: 2, syncedThroughEpoch: 7,
    keys: 1, contentMissing: 0, tombstones: 0, contentBytes: 5, purged: false, size: 0,
  };
  meta.size = measureSealedRow(pid, meta);
  const entry = { ...sealed, pid, size: 0 };
  entry.size = measureSealedRow(entryKey, entry);
  const blob = { ...sealed, pid, size: 0 };
  blob.size = measureSealedRow(blobKey, blob);
  const ledger = ledgerFor({ minFreeBytes: 0 });
  const originalBytes = meta.size + entry.size + blob.size;
  const put = db.transaction([...ERASE_STORES, KV_STORE.quota], "readwrite");
  const written = transactionDone(put);
  put.objectStore(KV_STORE.meta).put(meta, pid);
  put.objectStore(KV_STORE.entries).put(entry, entryKey);
  put.objectStore(KV_STORE.blobs).put(blob, blobKey);
  await ledger.accountRows(put, { partitionId: pid, partitionDeltaBytes: originalBytes, deviceDeltaBytes: 0 });
  await written;

  const erase = db.transaction([...ERASE_STORES, KV_STORE.quota], "readwrite");
  const complete = transactionDone(erase);
  const { bytes } = await kvPartitionEraser.erasePartition(erase, pid);
  await ledger.accountErase(erase, { partitionId: pid, bytes });
  await complete;
  const tombstone = await requestAsPromise<Record<string, unknown>>(db.transaction(KV_STORE.meta).objectStore(KV_STORE.meta).get(pid));
  expect(tombstone).toMatchObject({ pid, purged: true, generation: 3, coverageCode: 0, keys: 0, contentBytes: 0 });
  expect(tombstone).not.toHaveProperty("bytes");
  expect(tombstone).not.toHaveProperty("iv");
  const retainedBytes = measureSealedRow(pid, tombstone as Parameters<typeof measureSealedRow>[1]);
  const quota = db.transaction(KV_STORE.quota);
  expect(await requestAsPromise(quota.objectStore(KV_STORE.quota).get("total"))).toEqual({ bytes: retainedBytes });
  expect(await requestAsPromise(quota.objectStore(KV_STORE.quota).get(`partition:${pid}`))).toEqual({ bytes: retainedBytes });
  expect(bytes).toBe(meta.size + entry.size + blob.size - measureSealedRow(pid, tombstone as Parameters<typeof measureSealedRow>[1]));
  expect(await requestAsPromise(db.transaction(KV_STORE.entries).objectStore(KV_STORE.entries).count())).toBe(0);
  expect(await requestAsPromise(db.transaction(KV_STORE.blobs).objectStore(KV_STORE.blobs).count())).toBe(0);

  const repeat = db.transaction([...ERASE_STORES, KV_STORE.quota], "readwrite");
  const repeated = transactionDone(repeat);
  const replay = await kvPartitionEraser.erasePartition(repeat, pid);
  expect(replay).toEqual({ bytes: 0 });
  await ledger.accountErase(repeat, { partitionId: pid, bytes: replay.bytes });
  await repeated;
  const afterReplay = db.transaction(KV_STORE.quota);
  expect(await requestAsPromise(afterReplay.objectStore(KV_STORE.quota).get("total"))).toEqual({ bytes: retainedBytes });
  expect(await requestAsPromise(afterReplay.objectStore(KV_STORE.quota).get(`partition:${pid}`))).toEqual({ bytes: retainedBytes });

  const recreated = { ...meta, revision: 6, generation: 4, coverageCode: 0 as const, syncedThroughEpoch: 0,
    keys: 0, contentMissing: 0, tombstones: 0, contentBytes: 0, size: 0 };
  recreated.size = measureSealedRow(pid, recreated);
  const restore = db.transaction([KV_STORE.meta, KV_STORE.quota], "readwrite");
  const restored = transactionDone(restore);
  const delta = recreated.size - retainedBytes;
  await ledger.admitRows(restore, { partitionId: pid, partitionDeltaBytes: delta, deviceDeltaBytes: 0, freeBytes: 1_000_000 });
  restore.objectStore(KV_STORE.meta).put(recreated, pid);
  await ledger.accountRows(restore, { partitionId: pid, partitionDeltaBytes: delta, deviceDeltaBytes: 0 });
  await restored;
  const afterRestore = db.transaction(KV_STORE.quota);
  expect(await requestAsPromise(afterRestore.objectStore(KV_STORE.quota).get("total"))).toEqual({ bytes: recreated.size });
  expect(await requestAsPromise(afterRestore.objectStore(KV_STORE.quota).get(`partition:${pid}`))).toEqual({ bytes: recreated.size });
  db.close();
});
