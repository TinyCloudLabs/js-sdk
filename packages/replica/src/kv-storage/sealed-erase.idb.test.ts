import { beforeAll, beforeEach, expect, test } from "bun:test";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";

import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { measureSealedRow } from "./sealed.js";
import { ERASE_STORES, KV_DATABASE, KV_STORE, kvPartitionEraser, openKvDatabase } from "./schema.js";

beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

beforeEach(async () => {
  await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
});

test("purge removes sealed partition content, leaves a keyless generation tombstone, and releases only measured bytes", async () => {
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
  const put = db.transaction([...ERASE_STORES], "readwrite");
  const written = transactionDone(put);
  put.objectStore(KV_STORE.meta).put(meta, pid);
  put.objectStore(KV_STORE.entries).put(entry, entryKey);
  put.objectStore(KV_STORE.blobs).put(blob, blobKey);
  await written;

  const erase = db.transaction([...ERASE_STORES], "readwrite");
  const complete = transactionDone(erase);
  const { bytes } = await kvPartitionEraser.erasePartition(erase, pid);
  await complete;
  const tombstone = await requestAsPromise<Record<string, unknown>>(db.transaction(KV_STORE.meta).objectStore(KV_STORE.meta).get(pid));
  expect(tombstone).toMatchObject({ pid, purged: true, generation: 3, coverageCode: 0, keys: 0, contentBytes: 0 });
  expect(tombstone).not.toHaveProperty("bytes");
  expect(tombstone).not.toHaveProperty("iv");
  expect(bytes).toBe(meta.size + entry.size + blob.size - measureSealedRow(pid, tombstone as Parameters<typeof measureSealedRow>[1]));
  expect(await requestAsPromise(db.transaction(KV_STORE.entries).objectStore(KV_STORE.entries).count())).toBe(0);
  expect(await requestAsPromise(db.transaction(KV_STORE.blobs).objectStore(KV_STORE.blobs).count())).toBe(0);

  const repeat = db.transaction([...ERASE_STORES], "readwrite");
  const repeated = transactionDone(repeat);
  expect(await kvPartitionEraser.erasePartition(repeat, pid)).toEqual({ bytes: 0 });
  await repeated;
  db.close();
});
