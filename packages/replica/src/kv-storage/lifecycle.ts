/**
 * The browser `ReplicaLifecycleGate` (CONTRACT.md lifecycle): sign-in stamping, deny with purge
 * intents, ordered erase and startup recovery over the origin database's control stores
 * (`gate`, `partitions`, `purgeIntents`, `device`).
 *
 * Main thread only: `deliverable` and the logout marker live in `localStorage`, which workers
 * don't have. Gate-mutating paths (establish, deny) take the Web Lock `GATE_LOCK`. Every
 * transaction either commits whole or aborts.
 */
import type {
  ReplicaAccountGate,
  ReplicaDenyInput,
  ReplicaDenyOutcome,
  ReplicaEraseReport,
  ReplicaLifecycleGate,
  ReplicaPartitionEraser,
  ReplicaPartitionIndexEntry,
  ReplicaPurgeIntent,
  ReplicaQuotaLedger,
  ReplicaSessionStamp,
} from "@tinycloud/sdk-services/kv/replication";
import { REPLICA_LOGOUT_MARKER } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { gatedError } from "../errors.js";
import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { saltedHash } from "../profile-gate/saltedHash.js";
import { createIndexedDbGateTx, withDatabase } from "./gateTx.js";
import { ERASE_STORES, FIRST_INSTALL_KEY_PREFIX, KV_DATABASE, KV_STORE, kvPartitionEraser, openKvDatabase } from "./schema.js";

type Gate = ReplicaAccountGate;
type Tx = IDBTransaction;
type Stamp = { incarnation: string; lifecycleEpoch: number };
type DeleteOutcome = { status: "deleted" } | { status: "failed"; code: string };

const ACCOUNT = "account";
const DEVICE_KEY = "device";
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

function openKvStore(create: boolean): Promise<IDBDatabase | null> {
  return openKvDatabase({ create });
}

function codeOf(error: unknown): string {
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

function principalOfPending(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("identity" in value)) return undefined;
  const identity = value.identity;
  if (identity === null || typeof identity !== "object" || !("principal" in identity) || typeof identity.principal !== "string") {
    return undefined;
  }
  return identity.principal;
}

function exclusive<T>(name: string, section: () => Promise<T>): Promise<T> {
  return typeof navigator === "undefined" || navigator.locks === undefined ? section() : navigator.locks.request(name, section);
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
    localStorage.setItem(REPLICA_LOGOUT_MARKER, String(Date.now()));
    return true;
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

export function createIndexedDbLifecycle(options: { eraser?: ReplicaPartitionEraser<Tx>; ledger?: Pick<ReplicaQuotaLedger<Tx>, "accountErase"> } = {}): ReplicaLifecycleGate {
  const eraser = options.eraser ?? kvPartitionEraser;
  const ledger = options.ledger;
  const gateTx = createIndexedDbGateTx(openKvStore);
  // This tab's view of the gate. Undefined until established or restored, and after any deny.
  let view: Stamp | undefined;

  function adopt(gate: Gate): ReplicaSessionStamp {
    const stamp = { incarnation: gate.incarnation, lifecycleEpoch: gate.lifecycleEpoch };
    view = stamp;
    return stamp;
  }

  async function readGate(): Promise<Gate | undefined> {
    const found = await withDatabase(openKvStore, false, (db) =>
      requestAsPromise<Gate | undefined>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get(ACCOUNT)),
    );
    return found ?? undefined;
  }

  async function readIntents(): Promise<ReplicaPurgeIntent[]> {
    const found = await withDatabase(openKvStore, false, (db) =>
      requestAsPromise<ReplicaPurgeIntent[]>(db.transaction(KV_STORE.purgeIntents).objectStore(KV_STORE.purgeIntents).getAll()),
    );
    return found ?? [];
  }

  async function writeGate(gate: Gate): Promise<void> {
    const db = await openKvStore(true);
    if (db === null) throw gatedError("gate_unavailable", "The origin database could not be created.");
    try {
      await transact(db, [KV_STORE.gate], "readwrite", async (tx) => {
        tx.objectStore(KV_STORE.gate).put(gate, ACCOUNT);
      });
    } finally {
      db.close();
    }
  }

  async function establishSessionStamp(principal: string, o: { siweIssuedAt: number }): Promise<ReplicaSessionStamp> {
    return exclusive(GATE_LOCK, async () => {
      if (logoutMarkerSet()) throw gatedError("logout_pending", "A logout is still pending on this origin.");
      if ((await readIntents()).length > 0) throw gatedError("purge_pending", "A purge is still pending on this origin.");
      const principalKey = principal.toLowerCase();
      const current = await readGate();
      if (current === undefined) {
        const salt = crypto.randomUUID();
        const created: Gate = {
          incarnation: crypto.randomUUID(),
          salt,
          principalHash: await saltedHash(salt, principalKey),
          lifecycleEpoch: 0,
          deniedAt: null,
        };
        await writeGate(created);
        return adopt(created);
      }
      if (current.deniedAt !== null && o.siweIssuedAt <= current.deniedAt) {
        throw gatedError("stamp_stale", "This sign-in predates the last sign-out.");
      }
      const hash = await saltedHash(current.salt, principalKey);
      if (current.principalHash === null) {
        const next: Gate = { ...current, principalHash: hash };
        await writeGate(next);
        return adopt(next);
      }
      if (current.principalHash !== hash) throw gatedError("principal_mismatch", "The origin is bound to another account.");
      return adopt(current);
    });
  }

  async function restoreSessionStamp(principal: string, persisted: ReplicaSessionStamp | undefined): Promise<ReplicaSessionStamp> {
    const gate = await readGate();
    if (gate === undefined || persisted === undefined) throw gatedError("not_established", "No session stamp is established for this origin.");
    if (persisted.incarnation !== gate.incarnation || persisted.lifecycleEpoch !== gate.lifecycleEpoch) {
      throw gatedError("stamp_stale", "The persisted session stamp is stale.");
    }
    const hash = gate.principalHash === null ? null : await saltedHash(gate.salt, principal.toLowerCase());
    if (hash === null || hash !== gate.principalHash) throw gatedError("principal_mismatch", "The origin is bound to another account.");
    if (logoutMarkerSet()) throw gatedError("logout_pending", "A logout is still pending on this origin.");
    if ((await readIntents()).length > 0) throw gatedError("purge_pending", "A purge is still pending on this origin.");
    return adopt(gate);
  }

  async function activationAllowed(next: string): Promise<boolean> {
    try {
      if (logoutMarkerSet()) return false;
      const gate = await readGate();
      if (gate === undefined || gate.principalHash === null) return false;
      const hash = await saltedHash(gate.salt, next.toLowerCase());
      if (hash !== gate.principalHash) return false;
      return (await readIntents()).every((intent) => intent.principalHash === hash);
    } catch {
      return false;
    }
  }

  function deliverable(stamp: ReplicaSessionStamp): boolean {
    return (
      view !== undefined &&
      view.incarnation === stamp.incarnation &&
      view.lifecycleEpoch === stamp.lifecycleEpoch &&
      !logoutMarkerSet()
    );
  }

  /**
   * One transaction: moves the gate (epoch + 1, `deniedAt`, principal cleared or set to the next
   * account), records an intent per indexed partition and per pending identity of the caller,
   * deletes the owner `device` row and the `firstInstall:` anchors of those identities.
   */
  async function commitDeny(plan: { gate: Gate; callerKey: string; callerHash: string; nextHash: string | null }): Promise<ReplicaDenyOutcome> {
    if (takeFault("deny_tx")) throw new Error("injected deny_tx failure");
    const db = await openKvStore(false);
    if (db === null) return { status: "stale" };
    try {
      return await transact<ReplicaDenyOutcome>(
        db,
        [KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.device, KV_STORE.pending],
        "readwrite",
        async (tx) => {
          const current = await requestAsPromise<Gate | undefined>(tx.objectStore(KV_STORE.gate).get(ACCOUNT));
          if (
            current === undefined ||
            current.incarnation !== plan.gate.incarnation ||
            current.principalHash !== plan.callerHash
          ) {
            return { status: "stale" };
          }
          const now = Date.now();
          const partitions = await requestAsPromise<ReplicaPartitionIndexEntry[]>(tx.objectStore(KV_STORE.partitions).getAll());
          const pendingKeys = await requestAsPromise<IDBValidKey[]>(tx.objectStore(KV_STORE.pending).getAllKeys());
          const pendingValues = await requestAsPromise<unknown[]>(tx.objectStore(KV_STORE.pending).getAll());

          const intents: ReplicaPurgeIntent[] = [];
          const identities = new Set<string>();
          for (const entry of partitions) {
            if (entry.principalHash !== plan.callerHash) continue;
            intents.push({ id: entry.partitionId, kind: "partition", partitionId: entry.partitionId, principalHash: plan.callerHash, recordedAt: now });
            identities.add(entry.identityKeyHash);
          }
          for (const [index, key] of pendingKeys.entries()) {
            if (typeof key === "string" && principalOfPending(pendingValues[index])?.toLowerCase() === plan.callerKey) identities.add(key);
          }
          for (const identityKeyHash of identities) {
            intents.push({ id: `pending:${identityKeyHash}`, kind: "pending", identityKeyHash, principalHash: plan.callerHash, recordedAt: now });
          }

          const purge = tx.objectStore(KV_STORE.purgeIntents);
          for (const intent of intents) purge.put(intent, intent.id);
          const device = tx.objectStore(KV_STORE.device);
          device.delete(DEVICE_KEY);
          for (const identityKeyHash of identities) device.delete(FIRST_INSTALL_KEY_PREFIX + identityKeyHash);

          const next: Gate = {
            ...current,
            principalHash: plan.nextHash,
            lifecycleEpoch: current.lifecycleEpoch + 1,
            deniedAt: now,
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
  async function wipe(): Promise<ReplicaDenyOutcome> {
    const deleted = await deleteKvDatabase();
    if (deleted.status === "deleted") return { status: "deleted" };
    return setLogoutMarker() ? { status: "marker", code: deleted.code } : { status: "unguarded", code: deleted.code };
  }

  async function denyLocked(input: ReplicaDenyInput): Promise<ReplicaDenyOutcome> {
    const gate = await readGate();
    if (gate === undefined || gate.principalHash === null) return { status: "stale" };
    const callerKey = input.principal.toLowerCase();
    const callerHash = await saltedHash(gate.salt, callerKey);
    if (callerHash !== gate.principalHash) return { status: "stale" };
    if (input.reason === "account_switch" && input.next === undefined) {
      throw new Error("account_switch requires the next principal");
    }
    const nextHash = input.next === undefined ? null : await saltedHash(gate.salt, input.next.toLowerCase());
    try {
      return await commitDeny({ gate, callerKey, callerHash, nextHash });
    } catch {
      return wipe();
    }
  }

  async function deny(input: ReplicaDenyInput): Promise<ReplicaDenyOutcome> {
    // The in-memory flip happens before the first await, so this tab stops serving immediately.
    view = undefined;
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

  async function erasePending({ signal }: { signal: AbortSignal }): Promise<ReplicaEraseReport> {
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

  async function recover({ signal }: { signal: AbortSignal }): Promise<ReplicaEraseReport> {
    try {
      const failed: Array<{ id: string; code: string }> = [];
      if (logoutMarkerSet()) {
        const deleted = await deleteKvDatabase();
        if (deleted.status === "deleted") {
          try {
            localStorage.removeItem(REPLICA_LOGOUT_MARKER);
          } catch {
            failed.push({ id: "marker", code: "STORAGE_ERROR" });
          }
        } else {
          failed.push({ id: "database", code: deleted.code });
        }
      }
      const pass = await erasePending({ signal });
      return { erased: pass.erased, failed: [...failed, ...pass.failed], remaining: pass.remaining };
    } catch (error) {
      // Outcome unknown: report one outstanding intent so `purgePending` stays set.
      return { erased: [], failed: [{ id: "recover", code: codeOf(error) }], remaining: 1 };
    }
  }

  return {
    kind: "indexeddb",
    recover,
    establishSessionStamp,
    restoreSessionStamp,
    activationAllowed,
    deliverable,
    deny,
    erasePending,
    pendingPurge: readIntents,
  };
}
