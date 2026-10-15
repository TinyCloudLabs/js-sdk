/**
 * Quota contract (TC-858 Phase 2, CONTRACT.md §4). Types only.
 *
 * Browser: `maxBytes` is origin-wide across every partition in the origin database; the ledger
 * lives in the `quota` control store, is constructed inside the worker (`ledgerFor`), and is
 * called inside `ReplicaGateTx.run` page-commit transactions and exempt erase transactions.
 * `accountErase` is idempotent once the partition's entry is gone (crash replay is safe).
 * Node/CLI: `maxBytes` is per profile (per storage `dir`); there is no ledger — usage is derived
 * from stored content, so erase replay is safe — and the `admit` hook runs inside `applyPage`'s
 * guarded mutation (profile lock held). `minFreeBytes` applies only in the browser.
 */

/** Quota settings forwarded from `ReplicationOptions` to storage through `KVReplicaSpec.quota`. */
export interface ReplicaQuotaSpec {
  /** Byte budget; absent means unbounded (Phase 1 behaviour). */
  maxBytes?: number;
  /** Browser free-space floor; the browser adapter defaults it to `DEFAULT_MIN_FREE_BYTES`. */
  minFreeBytes?: number;
}

/** Node/CLI page admission keeps its existing blob/entry interpretation. */
export interface ReplicaPageAdmission {
  partitionId: string;
  /** Sum of the page's new blob bytes (node admission hook's existing metric). */
  blobBytes: number;
  /** Number of entry writes; not the browser ciphertext-row accounting metric. */
  entries: number;
  /** Optional caller-supplied free bytes; node's browser-only floor is not applied. */
  freeBytes: number | null;
}

/**
 * Browser admission uses the exact signed net application-encoded byte change of persisted
 * ciphertext entries, blobs and meta. New rows are sealed before opening the transaction;
 * old stored rows are measured inside it before any mutation. Replacements/GC may release space.
 */
export interface ReplicaBrowserPageAdmission {
  partitionId: string;
  deltaBytes: number;
  /** Free bytes read before opening the transaction; null when unknown. */
  freeBytes: number | null;
}

/**
 * Browser ledger seam, called by the adapter in guarded write or exempt erase transactions
 * that include the `quota` store. Every sealed meta mutation (including lease/status) uses
 * the same ledger as page/repair/GC. Implementations MUST only await requests on `tx`.
 */
export interface ReplicaQuotaLedger<Tx> {
  /** Read outside any transaction, just before it: `navigator.storage.estimate()` quota − usage. */
  freeBytes(): Promise<number | null>;
  /**
   * Admits the exact projected application-encoded persisted ciphertext-row delta, including
   * sealed value/IV/tag plus persisted key/index fields and envelope framing. IDB engine/page
   * overhead is unobservable and excluded. The adapter uses the same measured delta for
   * `accountCommit`; never admits plaintext lengths or a per-entry estimate. On
   * STORAGE_BUDGET it aborts `tx` before any page write.
   */
  admitPage(tx: Tx, page: ReplicaBrowserPageAdmission): Promise<void>;
  /** Records the same measured signed delta in the page/repair/GC/meta transaction. */
  accountCommit(tx: Tx, o: { partitionId: string; deltaBytes: number }): Promise<void>;
  /** Subtracts the exact encoded bytes removed in the erase transaction, idempotently. */
  accountErase(tx: Tx, o: { partitionId: string; bytes: number }): Promise<void>;
}

/**
 * Node/CLI admission hook (`admit` on the SQLite store options), run inside `applyPage`'s guarded
 * mutation before any write. Rejects with code STORAGE_BUDGET to refuse the page.
 */
export type ReplicaAdmitHook = (page: ReplicaPageAdmission) => void | Promise<void>;
