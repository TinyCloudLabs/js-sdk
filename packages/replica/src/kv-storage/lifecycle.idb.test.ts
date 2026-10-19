import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { CONSENT_WINDOW_MS } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { SPACE } from "../../test/fixtures.js";
import { gateHash } from "./gateKeys.js";
import { createIndexedDbGateTx } from "./gateTx.js";
import { createIndexedDbLifecycle, inspectReplicaKeyPresence } from "./lifecycle.js";
import { indexedDbReplicaStorage } from "./client.js";
import { DEVICE_QUOTA_PARTITION_ID, ledgerFor } from "./ledger.js";
import { KV_DATABASE, KV_STORE, openKvDatabase } from "./schema.js";
import { injectDenyFailure } from "./testing.js";

const principal = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const tombstoneKey = "tinycloud-replica:deny-tombstone";
const markerKey = "tinycloud-replica:logout-pending";
const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => { entries.set(key, value); },
  removeItem: (key: string) => { entries.delete(key); },
};

beforeAll(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: fakeIndexedDB });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, writable: true, value: fakeIDBKeyRange });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

beforeEach(async () => {
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

describe("origin deny tombstone", () => {
  test("direct establishment preserves a denied v1 floor before upgrading plaintext rows", async () => {
    const deniedAt = Date.now() - 1_000;
    const old = indexedDB.open(KV_DATABASE, 1);
    old.onupgradeneeded = () => {
      old.result.createObjectStore(KV_STORE.gate);
      old.result.createObjectStore(KV_STORE.blobs);
    };
    const legacy = await requestAsPromise(old);
    const tx = legacy.transaction([KV_STORE.gate, KV_STORE.blobs], "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(KV_STORE.gate).put({ lifecycleEpoch: 5, deniedAt }, "account");
    tx.objectStore(KV_STORE.blobs).put({ bytes: "plaintext-secret" }, "old-key");
    await done;
    legacy.close();
    const clock = { ms: deniedAt + 2 };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: deniedAt } }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    const untouched = await requestAsPromise(indexedDB.open(KV_DATABASE));
    expect(untouched.version).toBe(1);
    expect(await requestAsPromise(untouched.transaction(KV_STORE.blobs).objectStore(KV_STORE.blobs).count())).toBe(1);
    untouched.close();
    expect(JSON.parse(entries.get(tombstoneKey)!)).toEqual({ epoch: 5, deniedAt });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    expect(stamp.lifecycleEpoch).toBe(5);
    const upgraded = (await openKvDatabase({ create: false }))!;
    expect(upgraded.version).toBe(2);
    expect(await requestAsPromise(upgraded.transaction(KV_STORE.blobs).objectStore(KV_STORE.blobs).count())).toBe(0);
    upgraded.close();
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
  });

  test("recover preserves the componentwise v1 deny floor before destructive v2 migration", async () => {
    const now = Date.now();
    const legacyDeniedAt = now - 200;
    const externalDeniedAt = now - 100;
    const old = indexedDB.open(KV_DATABASE, 1);
    old.onupgradeneeded = () => {
      old.result.createObjectStore(KV_STORE.gate);
      old.result.createObjectStore(KV_STORE.meta);
    };
    const legacy = await requestAsPromise(old);
    const tx = legacy.transaction([KV_STORE.gate, KV_STORE.meta], "readwrite");
    const committed = transactionDone(tx);
    tx.objectStore(KV_STORE.gate).put({ incarnation: "legacy", lifecycleEpoch: 5, deniedAt: legacyDeniedAt }, "account");
    tx.objectStore(KV_STORE.meta).put({ key: "notes/private", value: "plaintext-secret" }, "old-key");
    await committed;
    legacy.close();
    entries.set(tombstoneKey, JSON.stringify({ epoch: 4, deniedAt: externalDeniedAt }));

    const lifecycle = createIndexedDbLifecycle({ now: () => now });
    expect(await openKvDatabase({ create: false })).toBeNull();
    expect(await lifecycle.recover({ signal: new AbortController().signal }))
      .toMatchObject({ failed: [], remaining: 0 });
    expect(JSON.parse(entries.get(tombstoneKey)!)).toEqual({ epoch: 5, deniedAt: externalDeniedAt });
    const upgraded = (await openKvDatabase({ create: false }))!;
    expect(upgraded.version).toBe(2);
    expect(await requestAsPromise(upgraded.transaction(KV_STORE.meta).objectStore(KV_STORE.meta).count())).toBe(0);
    upgraded.close();

    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: externalDeniedAt } }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    const fresh = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: now } });
    expect(fresh.lifecycleEpoch).toBe(5);
    expect(fresh.incarnation).not.toBe("legacy");
  });

  test("fallback delete retains epoch and rejects a pre-deny SIWE across lifecycle instances", async () => {
    const first = createIndexedDbLifecycle();
    const issuedAt = Date.now() - 1000;
    const stamp = await first.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: issuedAt } });
    const peer = createIndexedDbLifecycle();
    expect(await peer.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: issuedAt } })).toEqual(stamp);
    const dispose = injectDenyFailure("deny_tx", { once: true });
    try {
      expect(await first.deny({ reason: "sign_out", principal })).toEqual({ status: "deleted" });
    } finally {
      dispose();
    }
    const recorded = JSON.parse(entries.get(tombstoneKey) ?? "null");
    expect(recorded.epoch).toBe(stamp.lifecycleEpoch + 1);
    expect(typeof recorded.deniedAt).toBe("number");
    expect(first.deliverable(stamp)).toBe(false);
    expect(peer.deliverable(stamp)).toBe(false);
    expect(peer.checkDelivery(stamp)).toEqual({ status: "gated", gate: "stamp_stale" });
    const second = createIndexedDbLifecycle({ now: () => recorded.deniedAt + 2 });
    await expect(second.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: issuedAt } })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(JSON.parse(entries.get(tombstoneKey) ?? "null")).toEqual(recorded);
    const fresh = await second.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: recorded.deniedAt + 1 } });
    expect(fresh).toMatchObject({ lifecycleEpoch: recorded.epoch });
    expect(fresh.incarnation).not.toBe(stamp.incarnation);
    expect(JSON.parse(entries.get(tombstoneKey) ?? "null")).toEqual(recorded);
  });

  test("first-install and missing consent proof cannot establish a gate", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "first_install", at: Date.now() } }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "not_established" });
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: undefined as never }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "not_established" });
    expect(await openKvDatabase({ create: false })).toBeNull();
  });

  test("clock rollback cannot lower deniedAt or the epoch", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms - 1000 } });
    expect((await lifecycle.deny({ reason: "sign_out", principal })).status).toBe("denied");
    const first = JSON.parse(entries.get(tombstoneKey)!);
    clock.ms = first.deniedAt + 2;
    await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: first.deniedAt + 1 } });
    clock.ms = first.deniedAt - 1000;
    expect((await lifecycle.deny({ reason: "sign_out", principal })).status).toBe("denied");
    const second = JSON.parse(entries.get(tombstoneKey)!);
    expect(second).toEqual({ epoch: first.epoch + 1, deniedAt: first.deniedAt + 1 });
  });

  test("establish persists both nonextractable keys and deny shreds them before purge", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    const db = (await openKvDatabase({ create: false }))!;
    const before = db.transaction([KV_STORE.gate, KV_STORE.device]);
    const gate = await requestAsPromise<{ keyId: string; accountKeyId: string }>(before.objectStore(KV_STORE.gate).get("account"));
    const hash = await requestAsPromise<{ v: number; incarnation: string; keyId: string; hmac: CryptoKey } | undefined>(before.objectStore(KV_STORE.device).get("gateHmac"));
    const account = await requestAsPromise<{ v: number; incarnation: string; keyId: string; aesGcm: CryptoKey; hmac: CryptoKey } | undefined>(before.objectStore(KV_STORE.device).get("accountKey"));
    db.close();
    expect(hash).toMatchObject({ v: 1, incarnation: stamp.incarnation, keyId: gate.keyId });
    expect(account).toMatchObject({ v: 1, incarnation: stamp.incarnation, keyId: gate.accountKeyId });
    expect([hash?.hmac.extractable, account?.aesGcm.extractable, account?.hmac.extractable]).toEqual([false, false, false]);
    expect((await lifecycle.deny({ reason: "sign_out", principal })).status).toBe("denied");
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    const after = (await openKvDatabase({ create: false }))!;
    const afterTx = after.transaction([KV_STORE.device, KV_STORE.gate]);
    const device = afterTx.objectStore(KV_STORE.device);
    expect(await requestAsPromise(device.get("gateHmac"))).toBeUndefined();
    expect(await requestAsPromise(device.get("accountKey"))).toBeUndefined();
    expect(await requestAsPromise(afterTx.objectStore(KV_STORE.gate).get("account")))
      .toMatchObject({ principalHash: null, consentDeadline: null });
    after.close();
  });

  test("denial releases charged owner and install rows from the device bucket atomically", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const db = (await openKvDatabase({ create: false }))!;
    const ledger = ledgerFor();
    const write = db.transaction([KV_STORE.device, KV_STORE.quota], "readwrite");
    const done = transactionDone(write);
    const device = write.objectStore(KV_STORE.device);
    device.put({ size: 13 }, "device");
    device.put({ size: 7 }, "firstInstall:opaque");
    device.put({ size: 11 }, "grantInstall:opaque:cid");
    await ledger.accountRows(write, {
      partitionId: "a".repeat(64),
      partitionDeltaBytes: 0,
      deviceDeltaBytes: 31,
    });
    await done;
    db.close();

    expect((await lifecycle.deny({ reason: "sign_out", principal })).status).toBe("denied");
    const after = (await openKvDatabase({ create: false }))!;
    const read = after.transaction([KV_STORE.device, KV_STORE.quota]);
    const readDone = transactionDone(read);
    expect(await requestAsPromise(read.objectStore(KV_STORE.quota).get("total"))).toEqual({ bytes: 0 });
    expect(await requestAsPromise(read.objectStore(KV_STORE.quota).get(`partition:${DEVICE_QUOTA_PARTITION_ID}`))).toBeUndefined();
    expect(await requestAsPromise(read.objectStore(KV_STORE.device).get("device"))).toBeUndefined();
    expect(await requestAsPromise(read.objectStore(KV_STORE.device).get("firstInstall:opaque"))).toBeUndefined();
    expect(await requestAsPromise(read.objectStore(KV_STORE.device).get("grantInstall:opaque:cid"))).toBeUndefined();
    await readDone;
    after.close();
  });

  test("a same-principal sign-in does not extend the original consent deadline or rotate keys", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const first = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    const initial = (await openKvDatabase({ create: false }))!;
    const gate = await requestAsPromise<{ consentDeadline: number; keyId: string; accountKeyId: string }>(initial.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    initial.close();
    clock.ms += 3 * 24 * 60 * 60_000;
    expect(await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } })).toEqual(first);
    const after = (await openKvDatabase({ create: false }))!;
    const retained = await requestAsPromise<{ consentDeadline: number; keyId: string; accountKeyId: string }>(after.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    after.close();
    expect(retained).toEqual(gate);
    clock.ms = gate.consentDeadline;
    expect((await lifecycle.expireConsent()).status).toBe("denied");
  });

  test("a malformed persisted stamp cannot enable the replica", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const restored = createIndexedDbLifecycle();
    const malformed = { ...stamp, forged: true };
    await expect(restored.restoreSessionStamp(principal, malformed))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(restored.deliverable(stamp)).toBe(false);
  });

  test("a peer's cached deadline cannot authorize mint after another tab denies", async () => {
    const first = createIndexedDbLifecycle();
    const stamp = await first.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const peer = createIndexedDbLifecycle();
    await peer.restoreSessionStamp(principal, stamp);
    expect(peer.consentDeadline(stamp)).not.toBeNull();
    expect((await first.deny({ reason: "sign_out", principal })).status).toBe("denied");
    expect(peer.consentDeadline(stamp)).toBeNull();
  });

  test("seven-day expiry shreds keys at an injected clock and fences old stamps", async () => {
    const clock = { ms: Date.now() };
    const notifications: string[] = [];
    const lifecycle = createIndexedDbLifecycle({
      now: () => clock.ms,
      onConsentExpired: (stamp) => { notifications.push(stamp.incarnation); },
    });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    const db = (await openKvDatabase({ create: false }))!;
    const gate = await requestAsPromise<{ consentDeadline: number }>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    db.close();
    expect(gate.consentDeadline).toBe(clock.ms + CONSENT_WINDOW_MS);
    expect(lifecycle.consentDeadline(stamp)).toBe(gate.consentDeadline);
    clock.ms = gate.consentDeadline;
    expect(lifecycle.checkDelivery(stamp)).toEqual({ status: "consent_expired", code: "CONSENT_EXPIRED" });
    expect(lifecycle.consentDeadline(stamp)).toBeNull();
    expect(lifecycle.deliverable(stamp)).toBe(false);
    expect((await lifecycle.expireConsent()).status).toBe("denied");
    expect((await lifecycle.expireConsent()).status).toBe("stale");
    expect(lifecycle.checkDelivery(stamp)).toEqual({ status: "gated", gate: "stamp_stale" });
    expect(lifecycle.consentDeadline(stamp)).toBeNull();
    expect(notifications).toEqual([stamp.incarnation]);
    expect(JSON.parse(entries.get(tombstoneKey)!)).toEqual({ epoch: stamp.lifecycleEpoch + 1, deniedAt: clock.ms });
    const after = (await openKvDatabase({ create: false }))!;
    const device = after.transaction(KV_STORE.device).objectStore(KV_STORE.device);
    expect(await requestAsPromise(device.get("gateHmac"))).toBeUndefined();
    expect(await requestAsPromise(device.get("accountKey"))).toBeUndefined();
    after.close();
    await expect(lifecycle.restoreSessionStamp(principal, stamp)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("the active consent timer destroys both keys without a read or recovery call", async () => {
    const clock = { ms: Date.now() };
    const expired = Promise.withResolvers<string>();
    const lifecycle = createIndexedDbLifecycle({
      now: () => clock.ms,
      onConsentExpired: (stamp) => expired.resolve(stamp.incarnation),
    });
    const stamp = await lifecycle.establishSessionStamp(principal, {
      consentAnchor: { source: "siwe", at: clock.ms - CONSENT_WINDOW_MS + 20 },
    });
    clock.ms += 20;
    expect(await expired.promise).toBe(stamp.incarnation);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect(lifecycle.deliverable(stamp)).toBe(false);
  });

  test("a fresh open after consent expiry shreds existing keys rather than renewing them", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    clock.ms += CONSENT_WINDOW_MS;
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } }))
      .rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect(lifecycle.deliverable(stamp)).toBe(false);
  });
  test("a failed expiry observer cannot relabel committed key destruction as unguarded", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({
      now: () => clock.ms,
      onConsentExpired: () => { throw new Error("observer failed"); },
    });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    clock.ms += CONSENT_WINDOW_MS;
    expect((await lifecycle.expireConsent()).status).toBe("denied");
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect(lifecycle.deliverable(stamp)).toBe(false);
  });

  test("late subscribers observe only committed expiry, unsubscribe independently, and cannot undo denial", async () => {
    const clock = { ms: Date.now() };
    const legacy: string[] = [];
    const received: string[] = [];
    const lifecycle = createIndexedDbLifecycle({
      now: () => clock.ms,
      onConsentExpired: (stamp) => { legacy.push(stamp.incarnation); },
    });
    const first = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    lifecycle.subscribeConsentExpired(() => { throw new Error("one subscriber failed"); });
    const unsubscribe = lifecycle.subscribeConsentExpired((stamp) => { received.push(stamp.incarnation); });
    clock.ms += CONSENT_WINDOW_MS;
    expect((await lifecycle.expireConsent()).status).toBe("denied");
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect((await lifecycle.expireConsent()).status).toBe("stale");
    expect(received).toEqual([first.incarnation]);
    expect(legacy).toEqual(received);
    unsubscribe();
    clock.ms += 1;
    const second = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    clock.ms += CONSENT_WINDOW_MS;
    expect((await lifecycle.expireConsent()).status).toBe("denied");
    expect(legacy).toEqual([first.incarnation, second.incarnation]);
    expect(received).toEqual([first.incarnation]);
  });

  test("a direct-use adapter recovers an expired closed-browser gate before opening a worker", async () => {
    const clock = { ms: Date.now() };
    const first = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await first.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    clock.ms += CONSENT_WINDOW_MS;
    const resumed = createIndexedDbLifecycle({ now: () => clock.ms });
    const adapter = indexedDbReplicaStorage({
      lifecycle: resumed,
      worker: () => { throw new Error("An expired account must not start a replica worker."); },
    });
    await expect(adapter.open({
      identity: { host: "https://node.example", space: SPACE, principal },
      space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
      grantPolicy: { grantTtlMs: 60_000, consentAnchor: null },
    })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect(JSON.parse(entries.get(tombstoneKey)!)).toEqual({ epoch: stamp.lifecycleEpoch + 1, deniedAt: clock.ms });
  });

  test("direct open abandons a hung recovery without spawning a worker or hiding its gate", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const stalled = {
      ...lifecycle,
      recover: ({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    };
    const adapter = indexedDbReplicaStorage({
      lifecycle: stalled,
      worker: () => { throw new Error("Recovery did not complete; no worker may start."); },
    });
    await expect(adapter.open({
      identity: { host: "https://node.example", space: SPACE, principal },
      space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
      grantPolicy: { grantTtlMs: 60_000, consentAnchor: null },
    })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
  }, 5_000);
  test("startup recovery shreds keys when the browser was closed at the deadline", async () => {
    const clock = { ms: Date.now() };
    const initial = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await initial.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    clock.ms += CONSENT_WINDOW_MS;
    const resumed = createIndexedDbLifecycle({ now: () => clock.ms });
    expect(await resumed.recover({ signal: new AbortController().signal })).toMatchObject({ failed: [], consentExpired: true });
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect(JSON.parse(entries.get(tombstoneKey)!)).toEqual({ epoch: stamp.lifecycleEpoch + 1, deniedAt: clock.ms });
    await expect(resumed.restoreSessionStamp(principal, stamp)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("worker snapshots and guarded reads do not require main-thread localStorage", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const gateTx = createIndexedDbGateTx((create) => openKvDatabase({ create }), { onConsentExpired: () => lifecycle.expireConsent() });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    try {
      const snapshot = (await gateTx.snapshot())!;
      const access = {
        stamp,
        incarnation: snapshot.incarnation,
        keyId: snapshot.keyId,
        accountKeyId: snapshot.accountKeyId,
        principalHash: await gateHash(snapshot.gateHmac, "principal", principal.toLowerCase()),
      };
      expect((await gateTx.readAccountKey(access)).keyId).toBe(snapshot.accountKeyId);
      expect(await gateTx.run({ stores: [KV_STORE.meta], mode: "readonly" }, access, (tx) =>
        requestAsPromise(tx.objectStore(KV_STORE.meta).get("missing")))).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    }
  });

  test("an invalid injected clock cannot authorize delivery or a guarded read", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    const gateTx = createIndexedDbGateTx((create) => openKvDatabase({ create }), { now: () => clock.ms, onConsentExpired: () => lifecycle.expireConsent() });
    const snapshot = (await gateTx.snapshot())!;
    const access = {
      stamp,
      incarnation: snapshot.incarnation,
      keyId: snapshot.keyId,
      accountKeyId: snapshot.accountKeyId,
      principalHash: await gateHash(snapshot.gateHmac, "principal", principal.toLowerCase()),
    };
    clock.ms = Number.NaN;
    expect(lifecycle.checkDelivery(stamp)).toEqual({ status: "gated", gate: "gate_unavailable" });
    expect(lifecycle.deliverable(stamp)).toBe(false);
    let read = false;
    await expect(gateTx.run({ stores: [KV_STORE.meta], mode: "readonly" }, access, async () => {
      read = true;
    })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(read).toBe(false);
  });

  test("a worker clock ahead of main cannot report a false completed crypto-shred", async () => {
    const main = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => main.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: main.ms } });
    const snapshotTx = createIndexedDbGateTx((create) => openKvDatabase({ create }), { onConsentExpired: () => lifecycle.expireConsent() });
    const snapshot = (await snapshotTx.snapshot())!;
    const worker = { ms: main.ms + CONSENT_WINDOW_MS };
    const gateTx = createIndexedDbGateTx(
      (create) => openKvDatabase({ create }),
      { now: () => worker.ms, onConsentExpired: () => lifecycle.expireConsent() },
    );
    const access = {
      stamp,
      incarnation: snapshot.incarnation,
      keyId: snapshot.keyId,
      accountKeyId: snapshot.accountKeyId,
      principalHash: await gateHash(snapshot.gateHmac, "principal", principal.toLowerCase()),
    };
    let read = false;
    await expect(gateTx.run({ stores: [KV_STORE.meta], mode: "readonly" }, access, async () => {
      read = true;
    })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(read).toBe(false);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
  });

  test("stale key ID cannot expire another active gate", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    let expiryCalls = 0;
    const gateTx = createIndexedDbGateTx(
      (create) => openKvDatabase({ create }),
      { now: () => clock.ms, onConsentExpired: () => { expiryCalls++; return lifecycle.expireConsent(); } },
    );
    const snapshot = (await gateTx.snapshot())!;
    clock.ms += CONSENT_WINDOW_MS;
    const stale = {
      stamp,
      incarnation: snapshot.incarnation,
      keyId: snapshot.keyId === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32),
      accountKeyId: snapshot.accountKeyId,
      principalHash: await gateHash(snapshot.gateHmac, "principal", principal.toLowerCase()),
    };
    await expect(gateTx.run({ stores: [KV_STORE.meta], mode: "readonly" }, stale, async () => undefined))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(expiryCalls).toBe(0);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
  });

  test("guarded key read and expired transaction shred before returning any row", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    const gateTx = createIndexedDbGateTx(
      (create) => openKvDatabase({ create }),
      { now: () => clock.ms, onConsentExpired: () => lifecycle.expireConsent() },
    );
    const snapshot = (await gateTx.snapshot())!;
    const access = {
      stamp,
      incarnation: snapshot.incarnation,
      keyId: snapshot.keyId,
      accountKeyId: snapshot.accountKeyId,
      principalHash: await gateHash(snapshot.gateHmac, "principal", principal.toLowerCase()),
    };
    expect((await gateTx.readAccountKey(access)).keyId).toBe(snapshot.accountKeyId);
    let unstampedRead = false;
    await expect(gateTx.run({ stores: [KV_STORE.meta], mode: "readonly" }, { ...access, stamp: undefined as never }, async () => {
      unstampedRead = true;
    })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "not_established" });
    expect(unstampedRead).toBe(false);
    await gateTx.run({ stores: [KV_STORE.meta], mode: "readwrite" }, access, async (tx) => {
      tx.objectStore(KV_STORE.meta).put({ row: "ciphertext" }, "opaque-partition");
    });
    const db = (await openKvDatabase({ create: false }))!;
    const gate = await requestAsPromise<{ consentDeadline: number }>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    db.close();
    clock.ms = gate.consentDeadline;
    let delivered = false;
    await expect(gateTx.run({ stores: [KV_STORE.meta], mode: "readonly" }, access, async (tx) => {
      delivered = true;
      return requestAsPromise(tx.objectStore(KV_STORE.meta).get("opaque-partition"));
    })).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
    expect(delivered).toBe(false);
    expect(lifecycle.deliverable(stamp)).toBe(false);
    const after = (await openKvDatabase({ create: false }))!;
    expect(await requestAsPromise(after.transaction(KV_STORE.device).objectStore(KV_STORE.device).get("accountKey"))).toBeUndefined();
    after.close();
    await expect(gateTx.readAccountKey(access)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("consent expiry thrown inside a write aborts it before denial", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    const gateTx = createIndexedDbGateTx(
      (create) => openKvDatabase({ create }),
      { now: () => clock.ms, onConsentExpired: () => lifecycle.expireConsent() },
    );
    const snapshot = (await gateTx.snapshot())!;
    const access = {
      stamp,
      incarnation: snapshot.incarnation,
      keyId: snapshot.keyId,
      accountKeyId: snapshot.accountKeyId,
      principalHash: await gateHash(snapshot.gateHmac, "principal", principal.toLowerCase()),
    };
    await expect(gateTx.run({ stores: [KV_STORE.meta], mode: "readwrite" }, access, async (tx) => {
      const store = tx.objectStore(KV_STORE.meta);
      store.put({ row: "must-not-commit" }, "opaque-partition");
      await requestAsPromise(store.get("opaque-partition"));
      clock.ms += CONSENT_WINDOW_MS;
      throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "Consent crossed its deadline.");
    })).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
    const db = (await openKvDatabase({ create: false }))!;
    expect(await requestAsPromise(db.transaction(KV_STORE.meta).objectStore(KV_STORE.meta).get("opaque-partition"))).toBeUndefined();
    expect(await requestAsPromise(db.transaction(KV_STORE.device).objectStore(KV_STORE.device).get("accountKey"))).toBeUndefined();
    db.close();
  });

  test("missing active HMAC or account key refuses restore and guarded reads", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const gateTx = createIndexedDbGateTx((create) => openKvDatabase({ create }), { onConsentExpired: () => lifecycle.expireConsent() });
    const snapshot = (await gateTx.snapshot())!;
    const access = {
      stamp,
      incarnation: snapshot.incarnation,
      keyId: snapshot.keyId,
      accountKeyId: snapshot.accountKeyId,
      principalHash: await gateHash(snapshot.gateHmac, "principal", principal.toLowerCase()),
    };
    const db = (await openKvDatabase({ create: false }))!;
    const removeAccount = db.transaction(KV_STORE.device, "readwrite");
    removeAccount.objectStore(KV_STORE.device).delete("accountKey");
    await transactionDone(removeAccount);
    await expect(gateTx.readAccountKey(access)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    await expect(lifecycle.restoreSessionStamp(principal, stamp)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    const removeHash = db.transaction(KV_STORE.device, "readwrite");
    removeHash.objectStore(KV_STORE.device).delete("gateHmac");
    await transactionDone(removeHash);
    db.close();
    await expect(gateTx.snapshot()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
  });

  test("account switch shreds old keys and re-establishes with a new incarnation", async () => {
    const clock = { ms: Date.now() };
    const firstPrincipal = principal;
    const nextPrincipal = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const first = await lifecycle.establishSessionStamp(firstPrincipal, { consentAnchor: { source: "siwe", at: clock.ms } });
    expect((await lifecycle.deny({ reason: "account_switch", principal: firstPrincipal, next: nextPrincipal })).status).toBe("denied");
    const db = (await openKvDatabase({ create: false }))!;
    const oldGate = await requestAsPromise<{ principalHash: string | null }>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    expect(oldGate.principalHash).toBeNull();
    expect(await requestAsPromise(db.transaction(KV_STORE.device).objectStore(KV_STORE.device).get("gateHmac"))).toBeUndefined();
    expect(await requestAsPromise(db.transaction(KV_STORE.device).objectStore(KV_STORE.device).get("accountKey"))).toBeUndefined();
    db.close();
    clock.ms += 2;
    const second = await lifecycle.establishSessionStamp(nextPrincipal, { consentAnchor: { source: "siwe", at: clock.ms } });
    expect(second.incarnation).not.toBe(first.incarnation);
    expect(second.lifecycleEpoch).toBe(first.lifecycleEpoch + 1);
    await expect(lifecycle.restoreSessionStamp(firstPrincipal, first)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(lifecycle.deliverable(second)).toBe(true);
    expect((await lifecycle.deny({ reason: "sign_out", principal: firstPrincipal })).status).toBe("stale");
    expect(lifecycle.deliverable(second)).toBe(true);
  });

  test("deny records every opaque pending key and clears all first/grant-install anchors", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const db = (await openKvDatabase({ create: false }))!;
    const account = await requestAsPromise<{ principalHash: string }>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    const identity = "opaque-identity-a";
    const tx = db.transaction([KV_STORE.partitions, KV_STORE.device, KV_STORE.pending], "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(KV_STORE.partitions).put({ partitionId: "opaque-partition-a", identityKeyHash: identity, principalHash: account.principalHash, lookupId: "opaque-lookup", ownerDevice: true, createdAt: Date.now() }, "opaque-partition-a");
    tx.objectStore(KV_STORE.pending).put({ ciphertext: "not-plaintext-identity" }, "opaque-pending-only");
    tx.objectStore(KV_STORE.device).put(123, `grantInstall:${identity}:cid-a`);
    tx.objectStore(KV_STORE.device).put(124, `grantInstall:${identity}:cid-b`);
    tx.objectStore(KV_STORE.device).put(125, "grantInstall:identity-b:cid-c");
    tx.objectStore(KV_STORE.device).put(126, `firstInstall:${identity}`);
    await done;
    db.close();
    expect((await lifecycle.deny({ reason: "sign_out", principal })).status).toBe("denied");
    const after = (await openKvDatabase({ create: false }))!;
    const keys = await requestAsPromise<IDBValidKey[]>(after.transaction(KV_STORE.device).objectStore(KV_STORE.device).getAllKeys());
    after.close();
    expect(keys.filter((key) => typeof key === "string" && (key.startsWith("firstInstall:") || key.startsWith("grantInstall:")))).toEqual([]);
    expect((await lifecycle.pendingPurge()).map((intent) => intent.id)).toContain("pending:opaque-pending-only");
  });

  test("a missing or corrupt tombstone blocks a previously denied gate and delivery", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    expect((await lifecycle.deny({ reason: "sign_out", principal })).status).toBe("denied");
    clock.ms += 2;
    const fresh = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    expect(lifecycle.deliverable(fresh)).toBe(true);
    entries.delete(tombstoneKey);
    expect(lifecycle.deliverable(fresh)).toBe(false);
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    entries.set(tombstoneKey, "{broken");
    expect(lifecycle.deliverable(fresh)).toBe(false);
    entries.set(markerKey, "1");
    expect(lifecycle.checkDelivery(fresh)).toEqual({ status: "gated", gate: "gate_unavailable" });
    await expect(lifecycle.restoreSessionStamp(principal, stamp)).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
  });

  test("a second tab drops stale replies when deny and delete both fail", async () => {
    const first = createIndexedDbLifecycle();
    const stamp = await first.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    const peer = createIndexedDbLifecycle();
    await peer.restoreSessionStamp(principal, stamp);
    const clearTx = injectDenyFailure("deny_tx");
    const clearDelete = injectDenyFailure("delete_database");
    try {
      expect((await first.deny({ reason: "sign_out", principal })).status).toBe("marker");
    } finally {
      clearTx();
      clearDelete();
    }
    expect(peer.checkDelivery(stamp)).toEqual({ status: "gated", gate: "logout_pending" });
    expect(peer.deliverable(stamp)).toBe(false);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    entries.delete(markerKey);
    expect(peer.checkDelivery(stamp)).toEqual({ status: "gated", gate: "stamp_stale" });
    expect(peer.deliverable(stamp)).toBe(false);
    await expect(createIndexedDbLifecycle().restoreSessionStamp(principal, stamp))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    const db = (await openKvDatabase({ create: false }))!;
    const staleGate = await requestAsPromise<{ lifecycleEpoch: number }>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    db.close();
    expect(staleGate.lifecycleEpoch).toBe(stamp.lifecycleEpoch);
  });

  test("fallback marker recovery deletes the database but not the deny floor", async () => {
    const lifecycle = createIndexedDbLifecycle();
    await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() - 1000 } });
    const clearTx = injectDenyFailure("deny_tx");
    const clearDelete = injectDenyFailure("delete_database");
    try {
      expect((await lifecycle.deny({ reason: "sign_out", principal })).status).toBe("marker");
    } finally {
      clearTx();
      clearDelete();
    }
    const recorded = entries.get(tombstoneKey);
    expect(recorded).toBeDefined();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, removeItem: (key: string) => { if (key !== markerKey) storage.removeItem(key); } },
    });
    expect((await lifecycle.recover({ signal: new AbortController().signal })).failed).toContainEqual({ id: "marker", code: "STORAGE_ERROR" });
    expect(entries.has(markerKey)).toBe(true);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    expect((await lifecycle.recover({ signal: new AbortController().signal })).failed).toEqual([]);
    expect(entries.has(markerKey)).toBe(false);
    expect(entries.get(tombstoneKey)).toBe(recorded);
    await expect(createIndexedDbLifecycle().establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: JSON.parse(recorded!).deniedAt } })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("recovery wipes an interrupted denial whose tombstone is ahead of the gate", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const issuedAt = Date.now() - 1000;
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: issuedAt } });
    const recorded = { epoch: stamp.lifecycleEpoch + 1, deniedAt: Date.now() };
    entries.set(tombstoneKey, JSON.stringify(recorded));
    expect(lifecycle.deliverable(stamp)).toBe(false);
    const recovery = await lifecycle.recover({ signal: new AbortController().signal });
    expect(recovery.failed).toEqual([]);
    expect(await openKvDatabase({ create: false })).toBeNull();
    expect(JSON.parse(entries.get(tombstoneKey)!)).toEqual(recorded);
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: issuedAt } }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("aborting queued recovery leaves the expired gate and keys untouched", async () => {
    const clock = { ms: Date.now() };
    const lifecycle = createIndexedDbLifecycle({ now: () => clock.ms });
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: clock.ms } });
    clock.ms += CONSENT_WINDOW_MS;
    const queued = Promise.withResolvers<void>();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: (_name: string, optionsOrSection: LockOptions | (() => Promise<unknown>)) => {
        queued.resolve();
        if (typeof optionsOrSection === "function") return Promise.reject(new Error("Queued recovery had no abort signal."));
        const signal = optionsOrSection.signal;
        return new Promise<unknown>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } } },
    });
    const controller = new AbortController();
    const recovery = lifecycle.recover({ signal: controller.signal });
    await queued.promise;
    controller.abort(Object.assign(new Error("Recovery was cancelled."), { code: "RECOVERY_ABORTED" }));
    const report = await recovery;
    expect(report).toMatchObject({ erased: [], failed: [{ id: "recover", code: "RECOVERY_ABORTED" }], remaining: 1 });
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    expect(entries.has(tombstoneKey)).toBe(false);
    const db = (await openKvDatabase({ create: false }))!;
    const gate = await requestAsPromise<{ lifecycleEpoch: number; principalHash: string | null }>(
      db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"),
    );
    db.close();
    expect(gate.lifecycleEpoch).toBe(stamp.lifecycleEpoch);
    expect(gate.principalHash).not.toBeNull();
  });

  test("a tombstone write failure does not delete the existing gate", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: () => { throw new Error("storage denied"); } },
    });
    expect(await lifecycle.deny({ reason: "sign_out", principal })).toMatchObject({ status: "unguarded", code: "gate_unavailable" });
    const db = (await openKvDatabase({ create: false }))!;
    const gate = await requestAsPromise<{ lifecycleEpoch: number }>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    db.close();
    expect(gate.lifecycleEpoch).toBe(stamp.lifecycleEpoch);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  });

  test("a storage API that silently drops writes cannot establish or destroy the last gate", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: () => undefined },
    });
    await expect(createIndexedDbLifecycle().establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(await openKvDatabase({ create: false })).toBeNull();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: (key: string, value: string) => { if (key !== tombstoneKey) storage.setItem(key, value); } },
    });
    expect(await lifecycle.deny({ reason: "sign_out", principal })).toMatchObject({ status: "unguarded", code: "gate_unavailable" });
    const db = (await openKvDatabase({ create: false }))!;
    const gate = await requestAsPromise<{ lifecycleEpoch: number }>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
    db.close();
    expect(gate.lifecycleEpoch).toBe(stamp.lifecycleEpoch);
  });

  test("restore refuses a readable but unwritable deny floor", async () => {
    const first = createIndexedDbLifecycle();
    const stamp = await first.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: () => { throw new Error("storage denied"); } },
    });
    const restored = createIndexedDbLifecycle();
    await expect(restored.restoreSessionStamp(principal, stamp))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(restored.deliverable(stamp)).toBe(false);
  });

  test("establish refuses a readable but unwritable tombstone store", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: () => { throw new Error("storage denied"); } },
    });
    await expect(createIndexedDbLifecycle().establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(await openKvDatabase({ create: false })).toBeNull();
  });

  test("corrupt tombstone and unavailable locks fail closed", async () => {
    const lifecycle = createIndexedDbLifecycle();
    entries.set(tombstoneKey, "not-json");
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    entries.clear();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: undefined } });
    await expect(lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    await expect(lifecycle.deny({ reason: "sign_out", principal })).resolves.toMatchObject({ status: "unguarded" });
    await expect(lifecycle.erasePending({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect((await lifecycle.recover({ signal: new AbortController().signal })).failed).toContainEqual({ id: "recover", code: "gate_unavailable" });
  });
});

// #548 correctness review P2: a worker that cannot start must fail its calls, not leave them hanging.
describe("worker start-up failure", () => {
  test("open rejects promptly when the worker reports that it could not start", async () => {
    const lifecycle = createIndexedDbLifecycle();
    const stamp = await lifecycle.establishSessionStamp(principal, { consentAnchor: { source: "siwe", at: Date.now() } });
    let terminated = false;
    // Like a real Worker whose start-up failed: reportError surfaces as an error event once the main thread listens.
    const worker = {
      onmessage: null as ((message: MessageEvent) => void) | null,
      set onerror(listener: (event: ErrorEvent) => void) {
        queueMicrotask(() => listener({ message: "Uncaught Error: WebAssembly is blocked by CSP" } as ErrorEvent));
      },
      postMessage() {},
      terminate() { terminated = true; },
    };
    const adapter = indexedDbReplicaStorage({ lifecycle, worker: () => worker as unknown as Worker });
    await expect(adapter.open({
      identity: { host: "https://node.example", space: SPACE, principal },
      space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
      grantPolicy: { grantTtlMs: 60_000, consentAnchor: null },
    })).rejects.toMatchObject({ code: "STORAGE_ERROR", message: expect.stringContaining("WebAssembly is blocked by CSP") });
    expect(terminated).toBe(true);
  }, 5_000);
});
