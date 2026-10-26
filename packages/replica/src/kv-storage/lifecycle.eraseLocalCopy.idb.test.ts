/**
 * TC-1888: `eraseLocalCopy` deletes the origin database after a deny, and only when the gate
 * authorizes it. The negative cases pin the authorization rule: a live gate, another account's
 * gate and a marker without a deny tombstone leave the database untouched.
 */
import { mkdtempSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";

// Never touch a real home: every tool home is a temp dir, asserted before any write.
const TEST_HOME = mkdtempSync("/var/tmp/tc1888.");
process.env.HOME = TEST_HOME;
process.env.BUN_INSTALL_CACHE_DIR = TEST_HOME;
if (!process.env.HOME.startsWith("/var/tmp/tc1888.") || process.env.HOME === "/") throw new Error("test home is not a temp dir");

import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { createIndexedDbLifecycle, inspectReplicaKeyPresence } from "./lifecycle.js";
import { KV_DATABASE, KV_STORE, openKvDatabase } from "./schema.js";
import { injectDenyFailure } from "./testing.js";

const principalA = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const principalB = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
const tombstoneKey = "tinycloud-replica:deny-tombstone";
const markerKey = "tinycloud-replica:logout-pending";
const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => { entries.set(key, value); },
  removeItem: (key: string) => { entries.delete(key); },
};
const signal = () => AbortSignal.timeout(5_000);

async function listed(): Promise<boolean> {
  return (await indexedDB.databases()).some((database) => database.name === KV_DATABASE);
}

/** Plants rows only a live copy would hold, so "gone" cannot pass on an empty database. */
async function plantRows(): Promise<void> {
  const db = (await openKvDatabase({ create: false }))!;
  const tx = db.transaction([KV_STORE.entries, KV_STORE.blobs], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(KV_STORE.entries).put({ sealed: "row" }, "planted-entry");
  tx.objectStore(KV_STORE.blobs).put({ sealed: "row" }, "planted-blob");
  await done;
  db.close();
}

async function dataRows(): Promise<number | "absent"> {
  const db = await openKvDatabase({ create: false });
  if (db === null) return "absent";
  const counts = await Promise.all([KV_STORE.entries, KV_STORE.blobs, KV_STORE.meta, KV_STORE.pending].map(
    (name) => requestAsPromise<number>(db.transaction(name).objectStore(name).count()),
  ));
  db.close();
  return counts.reduce((sum, count) => sum + count, 0);
}

const ORIGIN_GLOBALS = ["indexedDB", "IDBKeyRange", "localStorage", "navigator"] as const;
const previousGlobals = new Map(ORIGIN_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

beforeAll(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: fakeIndexedDB });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, writable: true, value: fakeIDBKeyRange });
});

beforeEach(async () => {
  expect(process.env.HOME).toBe(TEST_HOME);
  entries.clear();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: (
      _name: string,
      optionsOrSection: LockOptions | (() => Promise<unknown>),
      section?: () => Promise<unknown>,
    ) => (typeof optionsOrSection === "function" ? optionsOrSection : section!)() } },
  });
  await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

afterAll(async () => {
  await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
  for (const name of ORIGIN_GLOBALS) {
    const descriptor = previousGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe("eraseLocalCopy after a deny", () => {
  test("deletes the database, keeps the deny tombstone, and the next sign-in mints a fresh gate", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: clock.ms - 1_000 } });
    await plantRows();
    expect((await lifecycle.deny({ reason: "sign_out", principal: principalA })).status).toBe("denied");
    expect(await listed()).toBe(true);

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "erased" });

    expect(await listed()).toBe(false);
    expect(await dataRows()).toBe("absent");
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    const tombstone = JSON.parse(entries.get(tombstoneKey)!);
    expect(tombstone.epoch).toBe(stamp.lifecycleEpoch + 1);
    expect(entries.has(markerKey)).toBe(false);
    clock.ms += 10;
    const fresh = await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: clock.ms } });
    expect(fresh.lifecycleEpoch).toBe(tombstone.epoch);
    expect(fresh.incarnation).not.toBe(stamp.incarnation);
  });

  test("an account switch leaves nothing of the old account once the copy is erased", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();
    expect((await lifecycle.deny({ reason: "account_switch", principal: principalA, next: principalB })).status).toBe("denied");

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "erased" });

    expect(await listed()).toBe(false);
    expect(await dataRows()).toBe("absent");
  });

  test("with no database at all the erase is a successful no-op", async () => {
    expect(await createIndexedDbLifecycle().eraseLocalCopy!({ signal: signal() })).toEqual({ status: "erased" });
    expect(await listed()).toBe(false);
  });
});

describe("eraseLocalCopy authorization (negative cases leave the database untouched)", () => {
  test("a live gate is refused: rows, keys and the gate survive", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "refused", code: "principal_active" });

    expect(await listed()).toBe(true);
    expect(await dataRows()).toBe(2);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    expect(await lifecycle.restoreSessionStamp(principalA, stamp)).toEqual(stamp);
  });

  test("another account's live gate is refused after the first account was denied", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: clock.ms - 1_000 } });
    expect((await lifecycle.deny({ reason: "account_switch", principal: principalA, next: principalB })).status).toBe("denied");
    clock.ms += 10;
    const next = await lifecycle.establishSessionStamp(principalB, { consentAnchor: { source: "siwe", at: clock.ms } });
    await plantRows();

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toMatchObject({ status: "refused" });

    expect(await listed()).toBe(true);
    expect(await dataRows()).toBe(2);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    expect(await lifecycle.restoreSessionStamp(principalB, next)).toEqual(next);
  });

  test("a logout marker without a deny tombstone is refused and the marker stays", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();
    entries.delete(tombstoneKey);
    entries.set(markerKey, "1");

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "refused", code: "gate_unavailable" });

    expect(await listed()).toBe(true);
    expect(await dataRows()).toBe(2);
    expect(entries.has(markerKey)).toBe(true);
  });

  test("an unguarded deny whose tombstone could not be written is refused: nothing is deleted", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: (key: string, value: string) => { if (key !== tombstoneKey) storage.setItem(key, value); } },
    });
    expect((await lifecycle.deny({ reason: "sign_out", principal: principalA })).status).toBe("unguarded");

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toMatchObject({ status: "refused" });

    expect(await listed()).toBe(true);
    expect(await dataRows()).toBe(2);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
  });

  test("an unreadable deny tombstone is refused, not treated as no tombstone", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    entries.set(tombstoneKey, "{broken");

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toMatchObject({ status: "refused", code: "gate_unavailable" });
    expect(await listed()).toBe(true);
  });
});

describe("eraseLocalCopy for deny outcomes that keep the keys", () => {
  test("marker: the erase deletes the database, clears the marker and keeps the tombstone", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();
    const clearTx = injectDenyFailure("deny_tx");
    const clearDelete = injectDenyFailure("delete_database");
    try {
      expect((await lifecycle.deny({ reason: "sign_out", principal: principalA })).status).toBe("marker");
    } finally {
      clearTx();
      clearDelete();
    }
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    expect(entries.has(markerKey)).toBe(true);
    const tombstone = entries.get(tombstoneKey);

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "erased" });

    expect(await listed()).toBe(false);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect(entries.has(markerKey)).toBe(false);
    expect(entries.get(tombstoneKey)).toBe(tombstone);
  });

  test("unguarded with the tombstone already advanced: the erase deletes the keys-kept database", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();
    const clearTx = injectDenyFailure("deny_tx");
    const clearDelete = injectDenyFailure("delete_database");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: (key: string, value: string) => { if (key !== markerKey) storage.setItem(key, value); } },
    });
    try {
      expect((await lifecycle.deny({ reason: "sign_out", principal: principalA })).status).toBe("unguarded");
    } finally {
      clearTx();
      clearDelete();
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    expect(entries.has(tombstoneKey)).toBe(true);

    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "erased" });

    expect(await listed()).toBe(false);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
  });
});

describe("a failed erase is finished on the next load", () => {
  test("a blocked delete reports failed with the marker set; recover then removes the database and clears the marker", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();
    expect((await lifecycle.deny({ reason: "sign_out", principal: principalA })).status).toBe("denied");
    const clearDelete = injectDenyFailure("delete_database", { once: false });
    try {
      expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "failed", code: "STORAGE_ERROR", marker: true });
      expect(await listed()).toBe(true);
      expect(entries.has(markerKey)).toBe(true);
      // The deny already shredded the keys, so the surviving rows are ciphertext without a key.
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    } finally {
      clearDelete();
    }

    // Next load: a fresh lifecycle instance recovers through the pending marker.
    const nextLoad = createIndexedDbLifecycle();
    expect(await nextLoad.recover({ signal: signal() })).toMatchObject({ failed: [], remaining: 0 });

    expect(await listed()).toBe(false);
    expect(await dataRows()).toBe("absent");
    expect(entries.has(markerKey)).toBe(false);
    expect(entries.has(tombstoneKey)).toBe(true);
  });

  test("a readable copy never survives a successful retry (keys-kept marker outcome)", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    await plantRows();
    const clearTx = injectDenyFailure("deny_tx");
    const clearDelete = injectDenyFailure("delete_database");
    try {
      expect((await lifecycle.deny({ reason: "sign_out", principal: principalA })).status).toBe("marker");
    } finally {
      clearTx();
      clearDelete();
    }

    const failing = injectDenyFailure("delete_database", { once: false });
    try {
      // While the delete keeps failing the copy is still readable: keys and rows are there.
      expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toMatchObject({ status: "failed", marker: true });
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
      expect(await dataRows()).toBe(2);
    } finally {
      failing();
    }

    // The retry succeeds: no rows, no keys, no listed database, no marker.
    expect(await lifecycle.eraseLocalCopy!({ signal: signal() })).toEqual({ status: "erased" });
    expect(await listed()).toBe(false);
    expect(await dataRows()).toBe("absent");
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect(entries.has(markerKey)).toBe(false);
  });

  test("an already aborted signal fails without deleting", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principalA, { consentAnchor: { source: "siwe", at: Date.now() - 1_000 } });
    expect((await lifecycle.deny({ reason: "sign_out", principal: principalA })).status).toBe("denied");
    const controller = new AbortController();
    controller.abort();

    expect(await lifecycle.eraseLocalCopy!({ signal: controller.signal })).toMatchObject({ status: "failed" });
    expect(await listed()).toBe(true);
  });
});
