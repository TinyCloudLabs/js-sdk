/**
 * `@tinycloud/replica/kv-storage/testing`: fault seams for acceptance
 * suites. Never imported by a production entry.
 */
import type { KVReplicaStorage, ReplicaPartitionEraser } from "@tinycloud/sdk-services/kv/replication";

import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { KILL_WORKER } from "./client.js";
import { kvPartitionEraser } from "./schema.js";

/**
 * Terminate the storage's worker as a crash would: in-flight calls reject,
 * and the next call on any handle respawns the worker and reopens its spec.
 */
export function killReplicaWorker(storage: KVReplicaStorage): void {
  const kill: unknown = Reflect.get(storage, KILL_WORKER);
  if (typeof kill !== "function") throw new TypeError("killReplicaWorker needs a storage from indexedDbReplicaStorage().");
  kill.call(storage);
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
