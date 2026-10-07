/**
 * Purge orchestration for `reset({purge:true})` (TC-19): the Web Lock is the
 * cross-tab mutex and the durable lease is the storage fence — the lock is
 * taken first so a busy writer never leaves a leaked lease behind.
 *
 * Wipe in place (round 4): there is no `deleteDatabase` anywhere. Purge is
 * one readwrite transaction that clears the replica and stamps the durable
 * `purged` marker at `generation + 1`; every later transaction fences on
 * the marker/generation, and `init` reinitializes the same database under
 * the next generation. Nothing physical can hang, queue, or be lost.
 */
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import type { IndexedDbReplicaStore } from "./store.js";

const PURGE_LEASE_TTL_MS = 60_000;

/** The reset result: the wipe commit is the whole purge — nothing follows. */
export type PurgeResult = { purged: true };

function busy(): ReplicaError {
  return new ReplicaError(ReplicaErrorCode.BUSY, "Another tab is syncing this replica.");
}

/**
 * Permanently erase the replica's contents in place.
 *
 * Order: Web Lock → claim → durable lease → one erase commit → broadcast.
 * `store.destroy` runs the commit: it clears the data, drops the grant and
 * authority, releases the lease, and stamps `{purged, generation+1}` — the
 * point of no return, after which the result is fixed `{ purged: true }` and
 * a failure is impossible. `onPurged` runs after the commit so the caller
 * can broadcast once; its own errors are swallowed inside `destroy`.
 *
 * A BUSY or failure *before* that commit leaves the replica untouched: the
 * lease taken under the lock is released on the still-open connection, and
 * a release failure surfaces (never swallowed) so a stranded lease is
 * visible.
 */
export async function purgeReplicaStore(
  store: IndexedDbReplicaStore,
  options: {
    locks: LockManager | undefined;
    replicaId: string;
    /** Runs once, after the erase commit lands. */
    onPurged?: () => void;
  },
): Promise<PurgeResult> {
  const { locks, replicaId, onPurged } = options;
  const drive = async (lease: { token: number; holder: string }): Promise<void> => {
    try {
      await store.destroy(lease, { onPurged });
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
    await drive(lease);
    return { purged: true };
  }
  let outcome: PurgeResult | { busy: true } = { busy: true };
  await locks.request(`tinycloud-replica:${replicaId}`, { ifAvailable: true }, async (lock) => {
    if (lock === null) return;
    // Under the lock a foreign lease holder is dead or lockless — claim the
    // writer identity and clear its row before taking our own lease.
    await store.claimWriterLock();
    const lease = await store.acquireSyncLease(PURGE_LEASE_TTL_MS);
    if (lease === null) throw busy();
    await drive(lease);
    outcome = { purged: true };
  });
  if ("busy" in outcome) throw busy();
  return outcome;
}
