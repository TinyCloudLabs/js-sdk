/**
 * Purge orchestration for `reset({purge:true})` (TC-19): the Web Lock is the
 * cross-tab mutex and the durable lease is the storage fence — the lock is
 * taken first so a busy writer never leaves a leaked lease behind.
 */
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import type { DeletionOutcome, IndexedDbReplicaStore } from "./store.js";

const PURGE_LEASE_TTL_MS = 60_000;

/** The reset result: `deletion` reports the file delete's bounded outcome. */
export type PurgeResult = { purged: true; deletion: DeletionOutcome };

function busy(): ReplicaError {
  return new ReplicaError(ReplicaErrorCode.BUSY, "Another tab is syncing this replica.");
}

/**
 * Permanently delete the replica's database.
 *
 * Order: Web Lock → claim → durable lease → one erase commit → broadcast →
 * bounded file deletion. The erase transaction (inside `store.destroy`) is
 * the point of no return: it clears the data, stamps the durable `purged`
 * marker and releases the lease, so after it commits the purge can never
 * report BUSY — `deletion` is reported truthfully instead, and a queued or
 * failed file delete is finished by the next open (`finishPurgeIfPending`)
 * or by the queued request itself. A BUSY or failure *before* that commit
 * leaves the replica untouched with nothing queued.
 *
 * `onPurged` runs between the commit and the delete so the caller can tell
 * siblings early — their `versionchange`/reset handling is what unblocks
 * the delete — and `onDeleteBlocked` fires if the delete still queues.
 */
export async function purgeReplicaStore(
  store: IndexedDbReplicaStore,
  options: {
    locks: LockManager | undefined;
    replicaId: string;
    /** Runs once the erase commit lands; the purge is irreversible then. */
    onPurged?: () => void;
    /** Runs when the file delete queues behind another connection. */
    onDeleteBlocked?: () => void;
  },
): Promise<PurgeResult> {
  const { locks, replicaId, onPurged, onDeleteBlocked } = options;
  const drive = async (lease: { token: number; holder: string }): Promise<DeletionOutcome> => {
    try {
      return await store.destroy(lease, { onPurged, onDeleteBlocked });
    } catch (error) {
      // destroy only fails before its erase commit — the marker path cannot
      // throw. The lease the purge took may therefore still be live; hand it
      // back on the open connection, and surface a cleanup failure (never
      // swallow it) so a stranded lease is visible.
      try {
        await store.releaseLease(lease);
      } catch (cleanup) {
        throw new ReplicaError(
          ReplicaErrorCode.STORAGE_ERROR,
          `The purge failed and releasing its lease failed too: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
          undefined,
          { cause: cleanup },
        );
      }
      throw error;
    }
  };
  if (locks === undefined) {
    // No cross-tab mutex exists: the durable lease alone orders purges.
    const lease = await store.acquireSyncLease(PURGE_LEASE_TTL_MS);
    if (lease === null) throw busy();
    const deletion = await drive(lease);
    return { purged: true, deletion };
  }
  let outcome: PurgeResult | { busy: true } = { busy: true };
  await locks.request(`tinycloud-replica:${replicaId}`, { ifAvailable: true }, async (lock) => {
    if (lock === null) return;
    // Under the lock a foreign lease holder is dead or lockless — claim the
    // writer identity and clear its row before taking our own lease.
    await store.claimWriterLock();
    const lease = await store.acquireSyncLease(PURGE_LEASE_TTL_MS);
    if (lease === null) throw busy();
    const deletion = await drive(lease);
    outcome = { purged: true, deletion };
  });
  if ("busy" in outcome) throw busy();
  return outcome;
}
