/**
 * Purge orchestration for `reset({purge:true})` (TC-19): the Web Lock is the
 * cross-tab mutex and the durable lease is the storage fence — the lock is
 * taken first so a busy writer never leaves a leaked lease behind.
 */
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import type { IndexedDbReplicaStore } from "./store.js";

const PURGE_LEASE_TTL_MS = 60_000;

function busy(): ReplicaError {
  return new ReplicaError(ReplicaErrorCode.BUSY, "Another tab is syncing this replica.");
}

/**
 * Permanently delete the replica's database.
 *
 * Order: Web Lock → claim → durable lease → destroy. The lease can only be
 * taken while holding the lock, so `busy` never strands a lease that blocks
 * the current writer's next sync or a later purge. If the destroy fails
 * after the lease was taken, the lease is released so the next writer or
 * purge is not fenced out.
 */
export async function purgeReplicaStore(
  store: IndexedDbReplicaStore,
  options: {
    locks: LockManager | undefined;
    replicaId: string;
    /** Siblings close on `versionchange`; this also reaches our own client. */
    onDeleteBlocked?: () => void;
  },
): Promise<void> {
  const { locks, replicaId, onDeleteBlocked } = options;
  if (locks === undefined) {
    // No cross-tab mutex exists: the durable lease alone orders purges.
    const lease = await store.acquireSyncLease(PURGE_LEASE_TTL_MS);
    if (lease === null) throw busy();
    await destroyReleasing(store, lease, onDeleteBlocked);
    return;
  }
  let outcome: true | { busy: true } = { busy: true };
  await locks.request(`tinycloud-replica:${replicaId}`, { ifAvailable: true }, async (lock) => {
    if (lock === null) return;
    // Under the lock a foreign lease holder is dead or lockless — claim the
    // writer identity and clear its row before taking our own lease.
    await store.claimWriterLock();
    const lease = await store.acquireSyncLease(PURGE_LEASE_TTL_MS);
    if (lease === null) throw busy();
    await destroyReleasing(store, lease, onDeleteBlocked);
    outcome = true;
  });
  if (typeof outcome !== "boolean") throw busy();
}

async function destroyReleasing(
  store: IndexedDbReplicaStore,
  lease: { token: number; holder: string },
  onDeleteBlocked?: () => void,
): Promise<void> {
  try {
    await store.destroy(lease, { onDeleteBlocked });
  } catch (error) {
    // The lease is only released when the destroy actually failed; a stale
    // token is a harmless no-op for a lease we already lost.
    await store.releaseLease(lease).catch(() => undefined);
    throw error;
  }
}
