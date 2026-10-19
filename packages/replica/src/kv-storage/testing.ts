/**
 * `@tinycloud/replica/kv-storage/testing`: fault seams for acceptance
 * suites. Never imported by a production entry.
 */
import type { KVReplicaStorage, ReplicaPartitionEraser } from "@tinycloud/sdk-services/kv/replication";

import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import type { DenyFaultPoint } from "./lifecycle.js";
import { denyFaults } from "./lifecycle.js";
import { kvPartitionEraser } from "./schema.js";

/**
 * Construct a lifecycle with a test eraser without exposing fault wiring to the production entry.
 * Test seam: pass `ledger` (ledgerFor()) or denial/erase will not release the device quota bucket; production always injects one.
 */
export { createIndexedDbLifecycle } from "./lifecycle.js";
/** Inspect encrypted raw-row sizes without exposing the sealed codec on the production entry. */
export { measureSealedRow } from "./sealed.js";

/**
 * Terminate the storage's worker as a crash would: in-flight calls reject,
 * and the next call on any handle respawns the worker and reopens its spec.
 */
export function killReplicaWorker(storage: KVReplicaStorage): void {
  const connection: unknown = Reflect.get(storage, "connection");
  if (typeof connection !== "function") throw new TypeError("killReplicaWorker needs a storage from indexedDbReplicaStorage().");
  const active: unknown = connection.call(storage, true);
  if (active === undefined) return;
  if (typeof active !== "object" || active === null) throw new TypeError("killReplicaWorker needs a storage from indexedDbReplicaStorage().");
  const kill: unknown = Reflect.get(active, "kill");
  if (typeof kill !== "function") throw new TypeError("killReplicaWorker needs a storage from indexedDbReplicaStorage().");
  kill.call(active, new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica worker was terminated."));
}

/**
 * An eraser whose `erasePartition` fails (aborting the erase transaction)
 * for the given partitions, or for every partition when none are given,
 * while `remaining()` is above zero. Pass it to the lifecycle gate in place
 * of `kvPartitionEraser`.
 */
export function injectEraseFailure(
  options: { partitionIds?: readonly string[]; times?: number; base?: ReplicaPartitionEraser<IDBTransaction> } = {},
): ReplicaPartitionEraser<IDBTransaction> & { remaining(): number } {
  const base = options.base ?? kvPartitionEraser;
  let remaining = options.times ?? Number.POSITIVE_INFINITY;
  return {
    remaining: () => remaining,
    async erasePartition(tx, partitionId) {
      if (remaining > 0 && (options.partitionIds === undefined || options.partitionIds.includes(partitionId))) {
        remaining -= 1;
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, `Injected erase failure for ${partitionId}.`);
      }
      return base.erasePartition(tx, partitionId);
    },
    eraseIdentityPending: (tx, identityKeyHash) => base.eraseIdentityPending(tx, identityKeyHash),
  };
}

/**
 * Plans a failure at one deny step: `deny_tx` makes the deny transaction fail
 * (forcing the fallback delete), `delete_database` makes the fallback delete
 * fail (forcing the logout marker). `once` (default true) consumes the plan on
 * first use. Returns a disposer that clears the plan.
 */
export function injectDenyFailure(point: DenyFaultPoint, options: { once?: boolean } = {}): () => void {
  denyFaults[point] = { once: options.once ?? true };
  return () => {
    delete denyFaults[point];
  };
}
