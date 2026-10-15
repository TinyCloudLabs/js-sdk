/**
 * Quota contract (TC-858 Phase 2, CONTRACT.md §4). Types only.
 *
 * Browser: `maxBytes` is origin-wide across every partition in the origin database; the ledger
 * lives in the `quota` control store and is updated inside the page-commit transaction.
 * Node/CLI: `maxBytes` is per profile (per storage `dir`); the `admit` hook runs inside
 * `applyPage`'s guarded mutation. `minFreeBytes` applies only in the browser.
 */

/** Quota settings forwarded from `ReplicationOptions` to storage through `KVReplicaSpec.quota`. */
export interface ReplicaQuotaSpec {
  /** Byte budget; absent means unbounded (Phase 1 behaviour). */
  maxBytes?: number;
  /** Browser free-space floor; the browser adapter defaults it to `DEFAULT_MIN_FREE_BYTES`. */
  minFreeBytes?: number;
}

/** One page offered for admission, measured before any write. */
export interface ReplicaPageAdmission {
  partitionId: string;
  /** Sum of the page's new blob bytes. */
  blobBytes: number;
  /** Number of entries the page writes (metadata overhead is the ledger's measured per-entry cost). */
  entries: number;
  /** Free bytes read just before the transaction (`freeBytes()`); null when unknown. */
  freeBytes: number | null;
}

/**
 * Browser ledger seam, called by the adapter inside the page or erase transaction (which MUST
 * include the `quota` store). Implementations MUST only await requests on `tx`.
 */
export interface ReplicaQuotaLedger<Tx> {
  /** Read outside any transaction, just before it: `navigator.storage.estimate()` quota − usage. */
  freeBytes(): Promise<number | null>;
  /**
   * Admits the projected size (blob bytes + per-entry overhead + repair headroom) against
   * `maxBytes` and the free-space floor. Rejects with code STORAGE_BUDGET; caller aborts `tx`.
   */
  admitPage(tx: Tx, page: ReplicaPageAdmission): Promise<void>;
  /** Records the committed delta in the same transaction as the page. */
  accountCommit(tx: Tx, o: { partitionId: string; deltaBytes: number }): Promise<void>;
  /** Subtracts erased bytes in the same transaction as the erase. */
  accountErase(tx: Tx, o: { partitionId: string; bytes: number }): Promise<void>;
}

/**
 * Node/CLI admission hook (`admit` on the SQLite store options), run inside `applyPage`'s guarded
 * mutation before any write. Rejects with code STORAGE_BUDGET to refuse the page.
 */
export type ReplicaAdmitHook = (page: ReplicaPageAdmission) => void | Promise<void>;
