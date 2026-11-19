/**
 * The browser `ReplicaLifecycleGate` (CONTRACT.md lifecycle): sign-in stamping, deny with purge
 * intents, ordered erase and startup recovery over the origin database's control stores
 * (`gate`, `partitions`, `purgeIntents`, `device`).
 *
 * Main thread only: `deliverable` and the logout marker/tombstone live in `localStorage`, which
 * workers don't have. Gate-mutating paths (establish, deny, recovery delete) take the Web Lock
 * `GATE_LOCK`; without it no mutation proceeds. Every transaction commits whole or aborts.
 */
import type {
  ReplicaConsentAnchor,
  ReplicaDeliveryDecision,
  ReplicaDenyInput,
  ReplicaDenyOutcome,
  ReplicaEraseReport,
  ReplicaLocalEraseOutcome,
  ReplicaLifecycleGate,
  ReplicaPartitionEraser,
  ReplicaPartitionIndexEntry,
  ReplicaPurgeIntent,
  ReplicaQuotaLedger,
  ReplicaSessionStamp,
} from "@tinycloud/sdk-services/kv/replication";
import { CONSENT_WINDOW_MS, REPLICA_DENY_TOMBSTONE, REPLICA_LOGOUT_MARKER } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { ReplicaError, ReplicaErrorCode, gatedError } from "../errors.js";
import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { ACCOUNT_KEY, GATE_HMAC_KEY, gateHash, newAccountKey, newGateHmac, validAccountKey, validGateHmac, type AccountKeyRecord, type BrowserGate, type GateHmacRecord } from "./gateKeys.js";
import { createIndexedDbGateTx, withDatabase } from "./gateTx.js";
import { ERASE_STORES, FIRST_INSTALL_KEY_PREFIX, KV_DATABASE, KV_STORE, kvPartitionEraser, openKvDatabase } from "./schema.js";

type Gate = BrowserGate;
type Tx = IDBTransaction;
type Stamp = { incarnation: string; lifecycleEpoch: number; consentDeadline: number; principal: string };
type DeleteOutcome = { status: "deleted" } | { status: "failed"; code: string };
type Tombstone = { epoch: number; deniedAt: number };

const ACCOUNT = "account";
const DEVICE_KEY = "device";
const GRANT_INSTALL_KEY_PREFIX = "grantInstall:";
const GATE_LOCK = "tinycloud-replica-kv:gate";
const DELETE_BLOCKED = "DELETE_BLOCKED";


export type DenyFaultPoint = "deny_tx" | "delete_database";

/**
 * Test seam. `@tinycloud/replica/kv-storage/testing` plans a failure here; production leaves it
 * empty. `once` (default true) removes the plan after its first use.
 */
export const denyFaults: Partial<Record<DenyFaultPoint, { once: boolean }>> = {};

function takeFault(point: DenyFaultPoint): boolean {
  const fault = denyFaults[point];
  if (fault === undefined) return false;
  if (fault.once) delete denyFaults[point];
  return true;
}

function billedDeviceBytes(row: unknown): number {
  if (row === undefined || (typeof row === "number" && Number.isSafeInteger(row) && row >= 0)) return 0;
  if (row !== null && typeof row === "object" && "size" in row &&
      typeof row.size === "number" && Number.isSafeInteger(row.size) && row.size >= 0) {
    return row.size;
  }
  throw gatedError("gate_unavailable", "A device quota row has no valid encoded size.");
}

function openKvStore(create: boolean): Promise<IDBDatabase | null> {
  return openKvDatabase({ create });
}

/** Test-only presence probe. Never returns, clones or exports CryptoKey material. */
export async function inspectReplicaKeyPresence(): Promise<{ gateHmac: boolean; accountKey: boolean }> {
  const db = await openKvStore(false);
  if (db === null) return { gateHmac: false, accountKey: false };
  try {
    const device = db.transaction(KV_STORE.device).objectStore(KV_STORE.device);
    const gateHmac = (await requestAsPromise<number>(device.count(GATE_HMAC_KEY))) === 1;
    const accountKey = (await requestAsPromise<number>(device.count(ACCOUNT_KEY))) === 1;
    return { gateHmac, accountKey };
  } finally {
    db.close();
  }
}

interface LegacyGateFloor {
  epoch: number;
  deniedAt: number | null;
}

/** Versionless, readonly v1 probe; no data row is read and a missing DB is never created. */
async function readLegacyGateFloor(): Promise<LegacyGateFloor | null> {
  const { promise, resolve, reject } = Promise.withResolvers<LegacyGateFloor | null>();
  const request = indexedDB.open(KV_DATABASE);
  let absent = false;
  request.onupgradeneeded = () => {
    absent = true;
    request.transaction?.abort();
  };
  request.onsuccess = async () => {
    const db = request.result;
    try {
      if (db.version !== 1) return resolve(null);
      if (!db.objectStoreNames.contains(KV_STORE.gate)) return resolve({ epoch: 0, deniedAt: null });
      const value = await requestAsPromise<unknown>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get(ACCOUNT));
      if (value === undefined) return resolve({ epoch: 0, deniedAt: null });
      if (value === null || typeof value !== "object" || !("lifecycleEpoch" in value) || !("deniedAt" in value) ||
          typeof value.lifecycleEpoch !== "number" || !Number.isSafeInteger(value.lifecycleEpoch) || value.lifecycleEpoch < 0 ||
          (value.deniedAt !== null && (typeof value.deniedAt !== "number" || !Number.isSafeInteger(value.deniedAt) || value.deniedAt < 0)) ||
          (value.lifecycleEpoch === 0) !== (value.deniedAt === null)) {
        throw gatedError("gate_unavailable", "The legacy gate deny floor is invalid.");
      }
      resolve({ epoch: value.lifecycleEpoch, deniedAt: value.deniedAt });
    } catch (error) {
      reject(error);
    } finally {
      db.close();
    }
  };
  request.onerror = (event) => {
    if (absent) {
      event.preventDefault();
      resolve(null);
    } else {
      reject(gatedError("gate_unavailable", "The legacy gate deny floor cannot be read."));
    }
  };
  request.onblocked = () => reject(gatedError("gate_unavailable", "The legacy gate read is blocked."));
  return promise;
}

/** Preserve a legacy denial outside the store before v2 versionchange can destroy its gate. */
function preserveLegacyFloor(legacy: LegacyGateFloor | null, tombstone: Tombstone | null): { tombstone: Tombstone | null; advanced: boolean } {
  if (legacy?.deniedAt === null || legacy === null) return { tombstone, advanced: false };
  const floor = {
    epoch: Math.max(legacy.epoch, tombstone?.epoch ?? 0),
    deniedAt: Math.max(legacy.deniedAt, tombstone?.deniedAt ?? 0),
  };
  if (tombstone !== null && tombstone.epoch >= floor.epoch && tombstone.deniedAt >= floor.deniedAt) {
    return { tombstone, advanced: false };
  }
  writeTombstone(floor);
  return { tombstone: floor, advanced: true };
}

function codeOf(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error && error.code === "REPLICA_GATED" && "gate" in error && typeof error.gate === "string") return error.gate;
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "STORAGE_ERROR";
}

/** Fail closed: no readable `localStorage` means no proof the logout completed. */
function logoutMarkerSet(): boolean {
  try {
    return localStorage.getItem(REPLICA_LOGOUT_MARKER) !== null;
  } catch {
    return true;
  }
}

/** Missing is valid only before the first deny. Corruption or denied storage is not. */
function readTombstone(): Tombstone | null {
  try {
    const stored = localStorage.getItem(REPLICA_DENY_TOMBSTONE);
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    if (
      value === null || typeof value !== "object" ||
      !("epoch" in value) || typeof value.epoch !== "number" || !Number.isSafeInteger(value.epoch) || value.epoch < 1 ||
      !("deniedAt" in value) || typeof value.deniedAt !== "number" || !Number.isSafeInteger(value.deniedAt) || value.deniedAt < 0 ||
      Object.keys(value).length !== 2
    ) throw new Error("Invalid deny tombstone.");
    return value as Tombstone;
  } catch {
    throw gatedError("gate_unavailable", "The origin deny tombstone cannot be read.");
  }
}

function writeTombstone(value: Tombstone): void {
  try {
    const serialized = JSON.stringify(value);
    localStorage.setItem(REPLICA_DENY_TOMBSTONE, serialized);
    if (localStorage.getItem(REPLICA_DENY_TOMBSTONE) !== serialized) throw new Error("The deny tombstone was not persisted.");
  } catch {
    throw gatedError("gate_unavailable", "The origin deny tombstone cannot be written.");
  }
}

/** A readable but read-only origin must not establish a session it could not later deny. */
function assertTombstoneWritable(): void {
  try {
    const stored = localStorage.getItem(REPLICA_DENY_TOMBSTONE);
    if (stored === null) {
      const probe = `${REPLICA_DENY_TOMBSTONE}:probe`;
      localStorage.setItem(probe, "1");
      if (localStorage.getItem(probe) !== "1") throw new Error("The deny tombstone probe was not persisted.");
      localStorage.removeItem(probe);
    } else {
      localStorage.setItem(REPLICA_DENY_TOMBSTONE, stored);
      if (localStorage.getItem(REPLICA_DENY_TOMBSTONE) !== stored) throw new Error("The deny tombstone was not persisted.");
    }
  } catch {
    throw gatedError("gate_unavailable", "The origin deny tombstone cannot be written.");
  }
}

function denyFloor(gate: Gate | undefined, tombstone: Tombstone | null): { epoch: number; deniedAt: number | null } {
  if (gate !== undefined && tombstone === null && (gate.lifecycleEpoch > 0 || gate.deniedAt !== null)) {
    throw gatedError("gate_unavailable", "A denied gate has no origin deny tombstone.");
  }
  if (gate !== undefined && tombstone !== null && gate.lifecycleEpoch < tombstone.epoch) {
    throw gatedError("gate_unavailable", "The gate is behind the origin deny tombstone.");
  }
  return {
    epoch: Math.max(gate?.lifecycleEpoch ?? 0, tombstone?.epoch ?? 0),
    deniedAt: gate?.deniedAt === null || gate?.deniedAt === undefined
      ? tombstone?.deniedAt ?? null
      : Math.max(gate.deniedAt, tombstone?.deniedAt ?? 0),
  };
}


function exclusive<T>(name: string, section: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function") {
    return Promise.reject(gatedError("gate_unavailable", "The origin Web Lock is unavailable."));
  }
  return signal === undefined
    ? navigator.locks.request(name, section)
    : navigator.locks.request(name, { signal }, section);
}

function deleteKvDatabase(): Promise<DeleteOutcome> {
  const { promise, resolve } = Promise.withResolvers<DeleteOutcome>();
  if (takeFault("delete_database")) {
    resolve({ status: "failed", code: "STORAGE_ERROR" });
    return promise;
  }
  const request = indexedDB.deleteDatabase(KV_DATABASE);
  request.onsuccess = () => resolve({ status: "deleted" });
  request.onerror = () => resolve({ status: "failed", code: "STORAGE_ERROR" });
  // The request stays queued and may still complete later; the marker covers that until a retry
  // confirms the delete.
  request.onblocked = () => resolve({ status: "failed", code: DELETE_BLOCKED });
  return promise;
}

function setLogoutMarker(): boolean {
  try {
    const marker = String(Date.now());
    localStorage.setItem(REPLICA_LOGOUT_MARKER, marker);
    return localStorage.getItem(REPLICA_LOGOUT_MARKER) === marker;
  } catch {
    return false;
  }
}

/**
 * Runs `use` in one transaction. `use` may only await requests on `tx`. A throw aborts the
 * transaction so nothing partial commits, then rethrows. Resolves only after `oncomplete`.
 */
async function transact<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, use: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = db.transaction(stores, mode, { durability: "strict" });
  const done = transactionDone(tx);
  let value: T;
  try {
    value = await use(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished.
    }
    await done.catch(() => undefined);
    throw error;
  }
  await done;
  return value;
}

export interface BrowserReplicaLifecycle extends ReplicaLifecycleGate {
  consentDeadline(stamp: ReplicaSessionStamp): number | null;
  subscribeConsentExpired(listener: (stamp: ReplicaSessionStamp) => void): () => void;
  expireConsent(): Promise<ReplicaDenyOutcome>;
}

export function createIndexedDbLifecycle(options: {
  eraser?: ReplicaPartitionEraser<Tx>;
  ledger?: Pick<ReplicaQuotaLedger<Tx>, "accountErase">;
  now?: () => number;
  onConsentExpired?: (stamp: ReplicaSessionStamp) => void;
} = {}): BrowserReplicaLifecycle {
  const eraser = options.eraser ?? kvPartitionEraser;
  const ledger = options.ledger;
  const now = options.now ?? Date.now;
  function checkedNow(): number {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw gatedError("gate_unavailable", "The replica clock is unavailable.");
    return at;
  }

  function deadlineOf(gate: Gate): number {
    const deadline = gate.consentDeadline;
    if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < 0) {
      throw gatedError("gate_unavailable", "The account gate has no valid consent deadline.");
    }
    return deadline;
  }

  const gateTx = createIndexedDbGateTx(openKvStore, { now, onConsentExpired: expireConsent });
  let view: Stamp | undefined;
  let expiryTimer: Parameters<typeof clearTimeout>[0];
  const expiryObservers = new Set<(stamp: ReplicaSessionStamp) => void>();

  function adopt(gate: Gate, principal: string): ReplicaSessionStamp {
    const stamp = { incarnation: gate.incarnation, lifecycleEpoch: gate.lifecycleEpoch };
    view = { ...stamp, consentDeadline: deadlineOf(gate), principal: principal.toLowerCase() };
    clearTimeout(expiryTimer);
    armExpiryTimer();
    return stamp;
  }

  function armExpiryTimer(): void {
    if (view === undefined) return;
    const delay = Math.max(0, Math.min(view.consentDeadline - checkedNow(), 2_147_483_647));
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (view === undefined) return;
      try {
        if (checkedNow() < view.consentDeadline) armExpiryTimer();
        else void expireConsent();
      } catch {
        view = undefined;
      }
    }, delay);
  }

  async function readGate(): Promise<Gate | undefined> {
    const found = await withDatabase(openKvStore, false, (db) =>
      requestAsPromise<Gate | undefined>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get(ACCOUNT)),
    );
    return found ?? undefined;
  }

  async function activeKeys(gate: Gate): Promise<{ hash: GateHmacRecord; account: AccountKeyRecord }> {
    const records = await withDatabase(openKvStore, false, async (db) => {
      const device = db.transaction(KV_STORE.device).objectStore(KV_STORE.device);
      const hash = await requestAsPromise<GateHmacRecord | undefined>(device.get(GATE_HMAC_KEY));
      const account = await requestAsPromise<AccountKeyRecord | undefined>(device.get(ACCOUNT_KEY));
      return { hash, account };
    });
    if (records === null || !validGateHmac(records.hash, gate) || !validAccountKey(records.account, gate)) {
      throw gatedError("gate_unavailable", "The account gate encryption keys are missing or mismatched.");
    }
    return { hash: records.hash, account: records.account };
  }

  async function readIntents(): Promise<ReplicaPurgeIntent[]> {
    const found = await withDatabase(openKvStore, false, (db) =>
      requestAsPromise<ReplicaPurgeIntent[]>(db.transaction(KV_STORE.purgeIntents).objectStore(KV_STORE.purgeIntents).getAll()),
    );
    return found ?? [];
  }

  async function writeGate(gate: Gate, previous: Gate | undefined, keys: { hash: GateHmacRecord; account: AccountKeyRecord }): Promise<void> {
    const db = await openKvStore(true);
    if (db === null) throw gatedError("gate_unavailable", "The origin database could not be created.");
    try {
      await transact(db, [KV_STORE.gate, KV_STORE.device], "readwrite", async (tx) => {
        const current = await requestAsPromise<Gate | undefined>(tx.objectStore(KV_STORE.gate).get(ACCOUNT));
        if (current?.incarnation !== previous?.incarnation || current?.lifecycleEpoch !== previous?.lifecycleEpoch || current?.principalHash !== previous?.principalHash) {
          throw gatedError("stamp_stale", "The origin gate changed during establishment.");
        }
        const device = tx.objectStore(KV_STORE.device);
        device.put(keys.hash, GATE_HMAC_KEY);
        device.put(keys.account, ACCOUNT_KEY);
        tx.objectStore(KV_STORE.gate).put(gate, ACCOUNT);
      });
    } finally {
      db.close();
    }
  }

  async function establishSessionStamp(principal: string, o: { consentAnchor: ReplicaConsentAnchor }): Promise<ReplicaSessionStamp> {
    return exclusive(GATE_LOCK, async () => {
      const tombstone = readTombstone();
      if (logoutMarkerSet()) throw gatedError("logout_pending", "A logout is still pending on this origin.");
      const anchor = o.consentAnchor;
      if (anchor === undefined ||
          (anchor.source !== "siwe" && anchor.source !== "delegation_iat" && anchor.source !== "delegation_nbf") ||
          !Number.isSafeInteger(anchor.at) || anchor.at < 0) {
        throw gatedError("not_established", "A verified finite consent anchor is required.");
      }
      const issuedAt = Math.min(anchor.at, checkedNow());
      if ((await readIntents()).length > 0) throw gatedError("purge_pending", "A purge is still pending on this origin.");
      const current = await readGate();
      const legacy = current === undefined ? await readLegacyGateFloor() : null;
      const preserved = preserveLegacyFloor(legacy, tombstone);
      const floor = denyFloor(current, preserved.tombstone);
      if (preserved.advanced) throw gatedError("stamp_stale", "The legacy deny floor was preserved; a new consent proof is required.");
      if (floor.deniedAt !== null && issuedAt <= floor.deniedAt) {
        throw gatedError("stamp_stale", "This sign-in predates the last sign-out.");
      }
      assertTombstoneWritable();
      if (current === undefined || current.principalHash === null) {
        const incarnation = crypto.randomUUID();
        const hash = await newGateHmac(incarnation);
        const principalHash = await gateHash(hash.hmac, "principal", principal.toLowerCase());
        const account = await newAccountKey(incarnation, floor.epoch, principalHash);
        const created: Gate = {
          incarnation,
          salt: crypto.randomUUID(),
          principalHash,
          lifecycleEpoch: floor.epoch,
          deniedAt: floor.deniedAt,
          keyId: hash.keyId,
          accountKeyId: account.keyId,
          consentDeadline: issuedAt + CONSENT_WINDOW_MS,
        };
        if (!Number.isSafeInteger(created.consentDeadline)) throw gatedError("not_established", "The consent deadline is invalid.");
        await writeGate(created, current, { hash, account });
        return adopt(created, principal);
      }
      const keys = await activeKeys(current);
      const principalHash = await gateHash(keys.hash.hmac, "principal", principal.toLowerCase());
      if (current.principalHash !== principalHash) throw gatedError("principal_mismatch", "The origin is bound to another account.");
      if (checkedNow() >= deadlineOf(current)) {
        await expireConsentLocked();
        throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "The account consent has expired.");
      }
      return adopt(current, principal);
    });
  }

  async function restoreSessionStamp(principal: string, persisted: ReplicaSessionStamp | undefined): Promise<ReplicaSessionStamp> {
    const gate = await readGate();
    denyFloor(gate, readTombstone());
    if (gate === undefined || persisted === undefined) throw gatedError("not_established", "No session stamp is established for this origin.");
    if (
      typeof persisted !== "object" || persisted === null || Array.isArray(persisted) ||
      Object.keys(persisted).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(persisted, "incarnation") ||
      !Object.prototype.hasOwnProperty.call(persisted, "lifecycleEpoch") ||
      typeof persisted.incarnation !== "string" || persisted.incarnation.length === 0 ||
      !Number.isSafeInteger(persisted.lifecycleEpoch) || persisted.lifecycleEpoch < 0
    ) {
      throw gatedError("stamp_stale", "The persisted replica stamp is malformed.");
    }
    if (persisted.incarnation !== gate.incarnation || persisted.lifecycleEpoch !== gate.lifecycleEpoch) {
      throw gatedError("stamp_stale", "The persisted session stamp is stale.");
    }
    if (gate.principalHash === null) throw gatedError("principal_mismatch", "The origin has no active account.");
    const keys = await activeKeys(gate);
    const hash = await gateHash(keys.hash.hmac, "principal", principal.toLowerCase());
    if (hash !== gate.principalHash) throw gatedError("principal_mismatch", "The origin is bound to another account.");
    if (logoutMarkerSet()) throw gatedError("logout_pending", "A logout is still pending on this origin.");
    if ((await readIntents()).length > 0) throw gatedError("purge_pending", "A purge is still pending on this origin.");
    assertTombstoneWritable();
    if (checkedNow() >= deadlineOf(gate)) {
      await expireConsent();
      throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "The account consent has expired.");
    }
    return adopt(gate, principal);
  }

  async function activationAllowed(next: string): Promise<boolean> {
    try {
      if (logoutMarkerSet()) return false;
      const gate = await readGate();
      denyFloor(gate, readTombstone());
      if (gate === undefined || gate.principalHash === null) return false;
      if (checkedNow() >= deadlineOf(gate)) {
        await expireConsent();
        return false;
      }
      const keys = await activeKeys(gate);
      const hash = await gateHash(keys.hash.hmac, "principal", next.toLowerCase());
      if (hash !== gate.principalHash) return false;
      return (await readIntents()).every((intent) => intent.principalHash === hash);
    } catch {
      return false;
    }
  }

  function checkDelivery(stamp: ReplicaSessionStamp): ReplicaDeliveryDecision {
    if (stamp === undefined) return { status: "gated", gate: "not_established" };
    if (view === undefined) return { status: "gated", gate: "stamp_stale" };
    if (view.incarnation !== stamp.incarnation || view.lifecycleEpoch !== stamp.lifecycleEpoch) {
      return { status: "gated", gate: "stamp_stale" };
    }
    try {
      const tombstone = readTombstone();
      if (logoutMarkerSet()) return { status: "gated", gate: "logout_pending" };
      if (tombstone === null && stamp.lifecycleEpoch !== 0) return { status: "gated", gate: "gate_unavailable" };
      if (tombstone !== null && stamp.lifecycleEpoch < tombstone.epoch) return { status: "gated", gate: "stamp_stale" };
      if (checkedNow() >= view.consentDeadline) return { status: "consent_expired", code: "CONSENT_EXPIRED" };
      return { status: "allow" };
    } catch {
      return { status: "gated", gate: "gate_unavailable" };
    }
  }

  function consentDeadline(stamp: ReplicaSessionStamp): number | null {
    return view !== undefined && checkDelivery(stamp).status === "allow"
      ? view.consentDeadline
      : null;
  }

  function deliverable(stamp: ReplicaSessionStamp): boolean {
    return checkDelivery(stamp).status === "allow";
  }

  /**
   * One transaction: moves the gate to the already persisted origin deny floor, records intents
   * for the caller, and removes its device, first-install and durable grant-install anchors.
   */
  async function commitDeny(plan: { gate: Gate; callerHash: string; tombstone: Tombstone }): Promise<ReplicaDenyOutcome> {
    if (takeFault("deny_tx")) throw new Error("injected deny_tx failure");
    const db = await openKvStore(false);
    if (db === null) return { status: "stale" };
    try {
      return await transact<ReplicaDenyOutcome>(
        db,
        [KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.device, KV_STORE.pending, KV_STORE.quota],
        "readwrite",
        async (tx) => {
          const current = await requestAsPromise<Gate | undefined>(tx.objectStore(KV_STORE.gate).get(ACCOUNT));
          if (
            current === undefined ||
            current.incarnation !== plan.gate.incarnation ||
            current.principalHash !== plan.callerHash ||
            current.lifecycleEpoch !== plan.gate.lifecycleEpoch ||
            current.keyId !== plan.gate.keyId ||
            current.accountKeyId !== plan.gate.accountKeyId
          ) {
            return { status: "stale" };
          }
          const now = plan.tombstone.deniedAt;
          const partitions = await requestAsPromise<ReplicaPartitionIndexEntry[]>(tx.objectStore(KV_STORE.partitions).getAll());
          const pendingKeys = await requestAsPromise<IDBValidKey[]>(tx.objectStore(KV_STORE.pending).getAllKeys());

          const intents: ReplicaPurgeIntent[] = [];
          const identities = new Set<string>();
          for (const entry of partitions) {
            if (entry.principalHash !== plan.callerHash) continue;
            intents.push({ id: entry.partitionId, kind: "partition", partitionId: entry.partitionId, principalHash: plan.callerHash, recordedAt: now });
            identities.add(entry.identityKeyHash);
          }
          // Activation never admits another principal while old purge intents remain.
          // Pending values may be sealed; only the opaque keys are needed for erase.
          for (const key of pendingKeys) {
            if (typeof key === "string") identities.add(key);
          }
          for (const identityKeyHash of identities) {
            intents.push({ id: `pending:${identityKeyHash}`, kind: "pending", identityKeyHash, principalHash: plan.callerHash, recordedAt: now });
          }

          const purge = tx.objectStore(KV_STORE.purgeIntents);
          for (const intent of intents) purge.put(intent, intent.id);
          const device = tx.objectStore(KV_STORE.device);
          let deviceBytes = billedDeviceBytes(await requestAsPromise<unknown>(device.get(DEVICE_KEY)));
          device.delete(DEVICE_KEY);
          device.delete(ACCOUNT_KEY);
          device.delete(GATE_HMAC_KEY);
          for (const prefix of [FIRST_INSTALL_KEY_PREFIX, GRANT_INSTALL_KEY_PREFIX]) {
            const keys = await requestAsPromise<IDBValidKey[]>(device.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
            for (const key of keys) {
              deviceBytes += billedDeviceBytes(await requestAsPromise<unknown>(device.get(key)));
              if (!Number.isSafeInteger(deviceBytes)) throw gatedError("gate_unavailable", "Device quota bytes overflow.");
              device.delete(key);
            }
          }
          await ledger?.accountErase(tx, { partitionId: "device", bytes: deviceBytes });

          const next: Gate = {
            ...current,
            principalHash: null,
            consentDeadline: null,
            lifecycleEpoch: plan.tombstone.epoch,
            deniedAt: plan.tombstone.deniedAt,
          };
          tx.objectStore(KV_STORE.gate).put(next, ACCOUNT);
          return { status: "denied", lifecycleEpoch: next.lifecycleEpoch, intents: intents.length };
        },
      );
    } finally {
      db.close();
    }
  }

  /** Commit failed: delete the whole origin database. Blocked or failed delete: set the marker. */
  async function wipe(): Promise<Extract<ReplicaDenyOutcome, { status: "deleted" | "marker" | "unguarded" }>> {
    const deleted = await deleteKvDatabase();
    if (deleted.status === "deleted") return { status: "deleted" };
    return setLogoutMarker() ? { status: "marker", code: deleted.code } : { status: "unguarded", code: deleted.code };
  }

  async function advanceDeny(gate: Gate, floor: { epoch: number; deniedAt: number | null }): Promise<ReplicaDenyOutcome> {
    const callerHash = gate.principalHash;
    if (callerHash === null) return { status: "stale" };
    const tombstone = { epoch: floor.epoch + 1, deniedAt: Math.max(checkedNow(), (floor.deniedAt ?? -1) + 1) };
    if (!Number.isSafeInteger(tombstone.epoch) || !Number.isSafeInteger(tombstone.deniedAt)) {
      throw gatedError("gate_unavailable", "The origin deny tombstone cannot advance.");
    }
    writeTombstone(tombstone);
    try {
      return await commitDeny({ gate, callerHash, tombstone });
    } catch {
      return wipe();
    }
  }

  async function denyLocked(input: ReplicaDenyInput): Promise<ReplicaDenyOutcome> {
    const gate = await readGate();
    const floor = denyFloor(gate, readTombstone());
    if (gate === undefined || gate.principalHash === null) return { status: "stale" };
    const keys = await activeKeys(gate);
    const callerHash = await gateHash(keys.hash.hmac, "principal", input.principal.toLowerCase());
    if (callerHash !== gate.principalHash) return { status: "stale" };
    if (input.reason === "account_switch" && input.next === undefined) {
      throw new Error("account_switch requires the next principal");
    }
    return advanceDeny(gate, floor);
  }

  async function expireConsentLocked(): Promise<ReplicaDenyOutcome> {
    const gate = await readGate();
    const floor = denyFloor(gate, readTombstone());
    if (gate === undefined || gate.principalHash === null) return { status: "stale" };
    if (checkedNow() < deadlineOf(gate)) return { status: "stale" };
    const stamp = { incarnation: gate.incarnation, lifecycleEpoch: gate.lifecycleEpoch };
    view = undefined;
    clearTimeout(expiryTimer);
    const result = await advanceDeny(gate, floor);
    if (result.status === "denied" || result.status === "deleted") {
      try {
        options.onConsentExpired?.(stamp);
      } catch {
        // An observer cannot undo a committed denial or relabel it as an unguarded gate.
      }
      for (const observer of expiryObservers) {
        try {
          observer(stamp);
        } catch {
          // Other subscribers still observe this committed denial.
        }
      }
    }
    return result;
  }

  async function expireConsent(): Promise<ReplicaDenyOutcome> {
    try {
      return await exclusive(GATE_LOCK, expireConsentLocked);
    } catch (error) {
      return { status: "unguarded", code: codeOf(error) };
    }
  }

  async function deny(input: ReplicaDenyInput): Promise<ReplicaDenyOutcome> {
    // Disable this tab before the first await, but never clear a successor's view
    // when a delayed sign-out from a previous account arrives.
    if (view?.principal === input.principal.toLowerCase()) {
      view = undefined;
      clearTimeout(expiryTimer);
    }
    try {
      return await exclusive(GATE_LOCK, () => denyLocked(input));
    } catch (error) {
      return { status: "unguarded", code: codeOf(error) };
    }
  }

  /** One exempt transaction per intent. A thrown error aborts it, so nothing partial commits. */
  async function eraseIntent(intent: ReplicaPurgeIntent): Promise<void> {
    const db = await openKvStore(false);
    if (db === null) return;
    try {
      await transact(db, [...ERASE_STORES, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.quota], "readwrite", async (tx) => {
        if (intent.kind === "partition") {
          const { bytes } = await eraser.erasePartition(tx, intent.partitionId);
          await gateTx.unindexPartition(tx, intent.partitionId);
          await ledger?.accountErase(tx, { partitionId: intent.partitionId, bytes });
        } else {
          await eraser.eraseIdentityPending(tx, intent.identityKeyHash);
        }
        await gateTx.clearIntent(tx, intent.id);
      });
    } finally {
      db.close();
    }
  }

  async function erasePendingLocked({ signal }: { signal: AbortSignal }): Promise<ReplicaEraseReport> {
    const erased: string[] = [];
    const failed: Array<{ id: string; code: string }> = [];
    for (const intent of await readIntents()) {
      if (signal.aborted) break;
      try {
        await eraseIntent(intent);
        erased.push(intent.id);
      } catch (error) {
        failed.push({ id: intent.id, code: codeOf(error) });
      }
    }
    return { erased, failed, remaining: (await readIntents()).length };
  }

  function erasePending(o: { signal: AbortSignal }): Promise<ReplicaEraseReport> {
    return exclusive(GATE_LOCK, () => erasePendingLocked(o));
  }

  /**
   * Deletes the whole origin database, only when nothing live is at stake: a denied gate (null
   * principal), a gate behind the persisted deny tombstone (commit crashed after the tombstone),
   * or a set logout marker WITH a tombstone. A live or other-account gate, or a marker without a
   * tombstone, is refused and the database is untouched. A failed delete sets the marker (with a
   * tombstone) so `recover` finishes it on the next load. Never clears the deny tombstone.
   */
  async function eraseLocalCopyLocked({ signal }: { signal: AbortSignal }): Promise<ReplicaLocalEraseOutcome> {
    const marker = logoutMarkerSet();
    const tombstone = readTombstone();
    if (marker && tombstone === null) {
      return { status: "refused", code: "gate_unavailable" };
    }
    if (!marker) {
      const gate = await readGate();
      const denied = gate === undefined || gate.principalHash === null ||
        (tombstone !== null && gate.lifecycleEpoch < tombstone.epoch);
      if (!denied) return { status: "refused", code: "principal_active" };
      // Rows go first so a blocked delete still leaves no readable data behind.
      if (gate !== undefined && gate.principalHash === null) {
        try { await erasePendingLocked({ signal }); } catch { /* the delete below covers it */ }
      }
    }
    if (signal.aborted) return { status: "failed", code: "ABORTED", marker: logoutMarkerSet() };
    const deleted = await deleteKvDatabase();
    if (deleted.status !== "deleted") {
      return { status: "failed", code: deleted.code, marker: marker || (tombstone !== null && setLogoutMarker()) };
    }
    if (marker) {
      try {
        localStorage.removeItem(REPLICA_LOGOUT_MARKER);
        if (localStorage.getItem(REPLICA_LOGOUT_MARKER) !== null) throw new Error("The logout marker was not cleared.");
      } catch {
        return { status: "failed", code: "STORAGE_ERROR", marker: true };
      }
    }
    return { status: "erased" };
  }

  async function eraseLocalCopy(o: { signal: AbortSignal }): Promise<ReplicaLocalEraseOutcome> {
    try {
      return await exclusive(GATE_LOCK, () => eraseLocalCopyLocked(o), o.signal);
    } catch (error) {
      const code = codeOf(error);
      return error !== null && typeof error === "object" && "code" in error && error.code === "REPLICA_GATED"
        ? { status: "refused", code }
        : { status: "failed", code, marker: logoutMarkerSet() };
    }
  }

  async function recover({ signal }: { signal: AbortSignal }): Promise<ReplicaEraseReport> {
    try {
      return await exclusive(GATE_LOCK, async () => {
        const failed: Array<{ id: string; code: string }> = [];
        if (logoutMarkerSet()) {
          // A marker without a durable deny floor cannot authorize destruction of the last gate.
          if (readTombstone() === null) throw gatedError("gate_unavailable", "The pending logout has no deny tombstone.");
          const deleted = await deleteKvDatabase();
          if (deleted.status === "deleted") {
            try {
              localStorage.removeItem(REPLICA_LOGOUT_MARKER);
              if (localStorage.getItem(REPLICA_LOGOUT_MARKER) !== null) throw new Error("The logout marker was not cleared.");
            } catch {
              failed.push({ id: "marker", code: "STORAGE_ERROR" });
            }
          } else {
            failed.push({ id: "database", code: deleted.code });
          }
        }
        if (failed.length > 0) return { erased: [], failed, remaining: 1 };
        // A crash between persisting the tombstone and committing the denial leaves
        // an older gate behind. The external floor already authorizes a full wipe.
        const gate = await readGate();
        const tombstone = readTombstone();
        if (gate !== undefined && tombstone !== null && gate.lifecycleEpoch < tombstone.epoch) {
          const wiped = await wipe();
          if (wiped.status !== "deleted") {
            return { erased: [], failed: [{ id: "database", code: wiped.code }], remaining: 1 };
          }
        }
        const legacy = await readLegacyGateFloor();
        if (legacy !== null) {
          const tombstone = readTombstone();
          preserveLegacyFloor(legacy, tombstone);
          assertTombstoneWritable();
          const db = await openKvStore(true);
          if (db === null) throw gatedError("gate_unavailable", "The legacy origin could not be migrated.");
          db.close();
        }
        const expiry = await expireConsentLocked();
        if (expiry.status === "marker" || expiry.status === "unguarded") {
          return { erased: [], failed: [{ id: "expiry", code: expiry.code }], remaining: 1 };
        }
        const pass = await erasePendingLocked({ signal });
        return { erased: pass.erased, failed: [...failed, ...pass.failed], remaining: pass.remaining, consentExpired: expiry.status === "denied" || expiry.status === "deleted" };
      }, signal);
    } catch (error) {
      // Outcome unknown: report one outstanding intent so `purgePending` stays set.
      return { erased: [], failed: [{ id: "recover", code: codeOf(error) }], remaining: 1 };
    }
  }

  function subscribeConsentExpired(listener: (stamp: ReplicaSessionStamp) => void): () => void {
    expiryObservers.add(listener);
    return () => { expiryObservers.delete(listener); };
  }

  return {
    kind: "indexeddb",
    recover,
    expireConsent,
    checkDelivery,
    consentDeadline,
    subscribeConsentExpired,
    establishSessionStamp,
    restoreSessionStamp,
    activationAllowed,
    deliverable,
    deny,
    erasePending,
    eraseLocalCopy,
    pendingPurge: readIntents,
  };
}
