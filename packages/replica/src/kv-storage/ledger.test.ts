import { describe, expect, test } from "bun:test";
import { indexedDB } from "fake-indexeddb";

import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { ledgerFor } from "./ledger.js";
import { measureSealedRow, seal } from "./sealed.js";

let nextDatabase = 0;
async function database(): Promise<IDBDatabase> {
  const name = `tc858-s5-ledger-${++nextDatabase}`;
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    for (const store of ["quota", "blobs", "entries", "meta"]) request.result.createObjectStore(store);
  };
  return requestAsPromise(request);
}

function stored(tx: IDBTransaction, store: string, key: IDBValidKey): Promise<unknown> {
  return requestAsPromise(tx.objectStore(store).get(key));
}

async function sealedRows(pid: string) {
  const secret = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const hash = "h".repeat(64);
  const keys = ["a".repeat(64), "b".repeat(64)];
  const blobKey = [pid, hash];
  const blob = { pid, ...(await seal(secret, new TextEncoder().encode("shared content"), `blobs\u0000${pid}\u0000${hash}`)), size: 0 };
  blob.size = measureSealedRow(blobKey, blob);
  const entries = await Promise.all(keys.map(async (id) => {
    const key = [pid, id];
    const row = { pid, hashId: hash, ...(await seal(secret, new TextEncoder().encode(`entry ${id}`), `entries\u0000${pid}\u0000${id}`)), size: 0 };
    row.size = measureSealedRow(key, row);
    return { key, row };
  }));
  return { blobKey, blob, entries, bytes: blob.size + entries[0]!.row.size + entries[1]!.row.size };
}

describe("origin ciphertext quota ledger", () => {
  test("counts one shared ciphertext blob and each sealed entry at the exact stored-row sizes", async () => {
    const db = await database();
    try {
      const pid = "p".repeat(64);
      const rows = await sealedRows(pid);
      const ledger = ledgerFor({ maxBytes: rows.bytes, minFreeBytes: 0 });
      const tx = db.transaction(["quota", "blobs", "entries"], "readwrite");
      const done = transactionDone(tx);
      await ledger.admitPage(tx, { partitionId: pid, deltaBytes: rows.bytes, freeBytes: 1_000_000 });
      tx.objectStore("blobs").put(rows.blob, rows.blobKey);
      for (const entry of rows.entries) tx.objectStore("entries").put(entry.row, entry.key);
      await ledger.accountCommit(tx, { partitionId: pid, deltaBytes: rows.bytes });
      await done;

      const read = db.transaction(["quota", "blobs", "entries"], "readonly");
      const persistedBlob = await stored(read, "blobs", rows.blobKey);
      const persistedEntries = await Promise.all(rows.entries.map(({ key }) => stored(read, "entries", key)));
      const actual = measureSealedRow(rows.blobKey, persistedBlob as typeof rows.blob)
        + persistedEntries.reduce<number>((bytes, row, index) => bytes + measureSealedRow(rows.entries[index]!.key, row as typeof rows.entries[number]["row"]), 0);
      const total = await stored(read, "quota", "total");
      expect(total).toEqual({ bytes: actual });
      expect(actual).toBe(rows.bytes);
      expect((await requestAsPromise(read.objectStore("blobs").getAllKeys())).length).toBe(1);
      await transactionDone(read);
    } finally {
      db.close();
    }
  });

  test("refuses one byte below the measured encrypted rows without any page or ledger writes", async () => {
    const db = await database();
    try {
      const pid = "q".repeat(64);
      const rows = await sealedRows(pid);
      const ledger = ledgerFor({ maxBytes: rows.bytes - 1, minFreeBytes: 0 });
      const tx = db.transaction(["quota", "blobs", "entries", "meta"], "readwrite");
      const done = transactionDone(tx);
      try {
        await ledger.admitPage(tx, { partitionId: pid, deltaBytes: rows.bytes, freeBytes: 1_000_000 });
        tx.objectStore("blobs").put(rows.blob, rows.blobKey);
        throw new Error("admission unexpectedly succeeded");
      } catch (error) {
        expect(error).toMatchObject({ code: "STORAGE_BUDGET" });
        tx.abort();
      }
      await expect(done).rejects.toThrow();
      const read = db.transaction(["quota", "blobs", "entries", "meta"], "readonly");
      for (const store of ["quota", "blobs", "entries", "meta"]) {
        expect(await requestAsPromise(read.objectStore(store).getAllKeys())).toEqual([]);
      }
      await transactionDone(read);
    } finally {
      db.close();
    }
  });
  test("accounts signed meta replacements and releases erased rows once, even below the free-space floor", async () => {
    const db = await database();
    try {
      const pid = "m".repeat(64);
      const secret = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
      const controls = {
        pid, revision: 1, generation: 1, coverageCode: 2, syncedThroughEpoch: 1,
        keys: 1, contentMissing: 0, tombstones: 0, contentBytes: 12, purged: false, v: 1 as const,
      };
      const first = { ...controls, ...(await seal(secret, new TextEncoder().encode("long sealed metadata"), `meta\u0000${pid}`)), size: 0 };
      first.size = measureSealedRow(pid, first);
      const replacement = { ...controls, revision: 2, ...(await seal(secret, new Uint8Array(), `meta\u0000${pid}`)), size: 0 };
      replacement.size = measureSealedRow(pid, replacement);
      expect(replacement.size).toBeLessThan(first.size);
      const ledger = ledgerFor({ maxBytes: first.size, minFreeBytes: 64 });
      const initial = db.transaction(["quota", "meta"], "readwrite");
      const initialDone = transactionDone(initial);
      await ledger.admitPage(initial, { partitionId: pid, deltaBytes: first.size, freeBytes: 1000 });
      initial.objectStore("meta").put(first, pid);
      await ledger.accountCommit(initial, { partitionId: pid, deltaBytes: first.size });
      await initialDone;

      const replace = db.transaction(["quota", "meta"], "readwrite");
      const replaceDone = transactionDone(replace);
      const deltaBytes = replacement.size - first.size;
      await ledger.admitPage(replace, { partitionId: pid, deltaBytes, freeBytes: 0 });
      replace.objectStore("meta").put(replacement, pid);
      await ledger.accountCommit(replace, { partitionId: pid, deltaBytes });
      await replaceDone;
      const read = db.transaction(["quota", "meta"], "readonly");
      expect(await stored(read, "quota", "total")).toEqual({ bytes: replacement.size });
      expect(measureSealedRow(pid, await stored(read, "meta", pid) as typeof replacement)).toBe(replacement.size);
      await transactionDone(read);

      const erase = db.transaction(["quota", "meta"], "readwrite");
      const eraseDone = transactionDone(erase);
      erase.objectStore("meta").delete(pid);
      await ledger.accountErase(erase, { partitionId: pid, bytes: replacement.size });
      await eraseDone;
      const replay = db.transaction(["quota"], "readwrite");
      const replayDone = transactionDone(replay);
      await ledger.accountErase(replay, { partitionId: pid, bytes: replacement.size });
      await replayDone;
      const after = db.transaction(["quota", "meta"], "readonly");
      expect(await stored(after, "quota", "total")).toEqual({ bytes: 0 });
      expect(await stored(after, "quota", `partition:${pid}`)).toBeUndefined();
      expect(await stored(after, "meta", pid)).toBeUndefined();
      await transactionDone(after);
    } finally {
      db.close();
    }
  });

  test("serializes two partitions against one origin-wide budget", async () => {
    const db = await database();
    try {
      const one = "1".repeat(64);
      const two = "2".repeat(64);
      const ledger = ledgerFor({ maxBytes: 100, minFreeBytes: 0 });
      const first = db.transaction(["quota"], "readwrite");
      const firstDone = transactionDone(first);
      const second = db.transaction(["quota"], "readwrite");
      const secondDone = transactionDone(second);
      await ledger.admitPage(first, { partitionId: one, deltaBytes: 60, freeBytes: 1000 });
      await ledger.accountCommit(first, { partitionId: one, deltaBytes: 60 });
      await firstDone;
      await expect(ledger.admitPage(second, { partitionId: two, deltaBytes: 41, freeBytes: 1000 }))
        .rejects.toMatchObject({ code: "STORAGE_BUDGET" });
      second.abort();
      await expect(secondDone).rejects.toThrow();
      const read = db.transaction(["quota"], "readonly");
      expect(await stored(read, "quota", "total")).toEqual({ bytes: 60 });
      expect(await stored(read, "quota", `partition:${two}`)).toBeUndefined();
      await transactionDone(read);
    } finally {
      db.close();
    }
  });
});
