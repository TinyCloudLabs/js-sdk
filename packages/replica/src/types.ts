/**
 * Replica contracts shared by every host (CLI SQLite store, browser worker).
 * The transport and store interfaces are the frozen TC-18/TC-19 contract.
 */

/** One row of `tinycloud.kv/sync`: a key's latest state. */
export type Change =
  | { key: string; deleted: false; etag: string; metadata: Record<string, string> }
  | { key: string; deleted: true };

/** The node-attested window in which the caller's authority holds (ISO-8601 or null). */
export type AuthorityWindow = {
  notBefore: string | null;
  expiresAt: string | null;
  retainUntil: string | null;
};

export type SyncSource = { nodeDid: string; space: string; prefix: string };

export type SyncPage = {
  changes: Change[];
  more: boolean;
  cursor: string;
  source: SyncSource;
  /** Present on every `kv/sync` response; persisted with the page. */
  authority: AuthorityWindow;
};

export type FetchedContent = { bytes: Uint8Array; etag: string } | { missing: true };

export interface ReplicaTransport {
  /** One `tinycloud.kv/sync` page (`KVService.changes`). */
  syncPage(a: {
    prefix: string;
    cursor?: string;
    limit: number;
    /** CID of a `tinycloud.kv/retain` grant to present with this sync. */
    retentionGrant?: string;
    signal?: AbortSignal;
  }): Promise<SyncPage>;
  /** Current content for `keys` (`batchGet` ≤100; single binary get for oversize values). */
  fetchContent(keys: string[], a?: { signal?: AbortSignal }): Promise<Map<string, FetchedContent>>;
}

export type LocalReadPolicy = "whileGrantValid" | "retainAfterExpiry";

export type ReplicaConfig = {
  name: string;
  replicaId: string;
  /** The source host pinned at creation; never a discovered local node. */
  host: string;
  space: string;
  prefix: string;
  deviceDid: string;
  allowSecrets: boolean;
  localReadPolicy: LocalReadPolicy;
  retentionGrantCid: string | null;
};

/** A signed grant as installed in the store. */
export type GrantRecord = {
  cid: string;
  /** The signed UCAN bytes, exactly as issued. */
  bytes: Uint8Array;
  audience: string;
  issuer: string;
  /** Leaf window (seconds since epoch), an install check and upper bound only. */
  notBefore: number | null;
  expiresAt: number | null;
};

export type Coverage = "empty" | "bootstrapping" | "complete";

export type AuthorityState = "valid" | "expired" | "revoked" | "not-yet-valid";

export type ReplicaState = {
  config: ReplicaConfig;
  grant: GrantRecord | null;
  pendingGrant: GrantRecord | null;
  nodeDid: string | null;
  /** The node-attested window from the last successful sync. */
  authority: AuthorityWindow | null;
  revoked: string | null;
  /** Set when the node reported the retention grant revoked: post-expiry reads raise GRANT_REVOKED. */
  retentionRevoked: string | null;
  /** Why the node refused the pending grant at its last attempt, if it did. */
  pendingGrantError: ReplicaLastError | null;
  cursor: string | null;
  coverage: Coverage;
  generation: number;
  createdAt: string;
  lastSyncAt: string | null;
  lastCompleteAt: string | null;
  lastError: ReplicaLastError | null;
  lastReset: { at: string; reason: string } | null;
};

export type ReplicaLastError = { at: string; code: string; message: string };

export type LeaseToken = { token: number; holder: string };

/** A verified row ready to commit. `hash` is the 64-hex blake3 of the content. */
export type VerifiedChange =
  | { key: string; deleted: false; etag: string; hash: string; metadata: Record<string, string>; content: boolean }
  | { key: string; deleted: true };

export type VerifiedPage = {
  changes: VerifiedChange[];
  /** Verified bytes by hash; written as blobs before the rows commit. */
  blobs: Map<string, Uint8Array>;
  /** The cursor to persist; unchanged for repair-only pages. */
  cursor: string | null;
  source: SyncSource;
  authority: AuthorityWindow | null;
  coverage: Coverage;
  /** Commit time (ISO-8601), recorded as the sync time. */
  at: string;
  /**
   * The effective authority window this page commits under. The store checks
   * it against its own clock inside the commit transaction; outside it
   * nothing commits.
   */
  window: { notBefore: string | null; expiresAt: string | null };
  /** True when this page closes a sync run (`more: false`). */
  complete: boolean;
  /**
   * The pending grant the node just validated for this page: it becomes the
   * active grant. A different grant installed as pending meanwhile stays pending.
   */
  promoteGrant: GrantRecord | null;
};

export type LocalEntry =
  | { key: string; deleted: false; etag: string; hash: string; metadata: Record<string, string>; content: boolean }
  | { key: string; deleted: true };

export type ListOpts = { prefix?: string; after?: string; limit?: number };

export type ReplicaStatus = {
  name: string;
  replicaId: string;
  source: { host: string; nodeDid: string | null; space: string; prefix: string };
  device: {
    did: string;
    delegationCid: string | null;
    pendingDelegationCid: string | null;
    pendingDelegationError: ReplicaLastError | null;
  };
  authority: {
    state: AuthorityState;
    notBefore: string | null;
    expiresAt: string | null;
    retainUntil: string | null;
    localReadPolicy: LocalReadPolicy;
    retentionGrantCid: string | null;
    revokedDetail: string | null;
    retentionRevokedDetail: string | null;
  };
  consistency: "observed";
  coverage: Coverage;
  lastSyncAt: string | null;
  lastCompleteAt: string | null;
  counts: { keys: number; contentMissing: number; tombstones: number };
  bytes: number;
  durability: string;
  syncing: boolean;
  /** A revocation purge has not removed every content file yet; the next open retries it. */
  purgePending: boolean;
  lastError: ReplicaLastError | null;
  lastReset: { at: string; reason: string } | null;
};

export interface ReplicaStore {
  open(): Promise<ReplicaState | null>;
  init(c: ReplicaConfig): Promise<void>;
  /** Stored as pending until a successful sync under it. */
  installGrant(g: GrantRecord): Promise<void>;
  acquireSyncLease(ttlMs: number): Promise<LeaseToken | null>;
  renewLease(t: LeaseToken, ttlMs: number): Promise<void>;
  releaseLease(t: LeaseToken): Promise<void>;
  /** Hashes whose blobs are referenced by a committed entry. */
  hasContent(hashes: string[]): Promise<Set<string>>;
  /** ONE transaction: blob refs + entries + tombstones + cursor + coverage; fenced by a live lease token. */
  applyPage(t: LeaseToken, p: VerifiedPage): Promise<void>;
  /**
   * Clear entries, blobs and cursor; keep config and grants. The nodeDid pin
   * is cleared too unless `keepSource` (an automatic 410 reset keeps it).
   */
  reset(t: LeaseToken, reason: string, options?: { keepSource?: boolean }): Promise<void>;
  /**
   * Purge entries and blobs, keep a minimal blocked status. Invalidates every
   * outstanding lease; later commits, GC and resets refuse.
   */
  markRevoked(detail: string): Promise<void>;
  /**
   * The node revoked the retention grant `cid`: drop it and its retainUntil, so
   * post-expiry reads raise GRANT_REVOKED. A different current grant is kept.
   */
  markRetentionRevoked(cid: string, detail: string): Promise<void>;
  /** The node revoked the pending grant: discard it (the active grant keeps serving). */
  discardPendingGrant(cid: string, detail: string): Promise<void>;
  /** The node refused the pending grant (not a revocation): keep it pending, with the reason. */
  recordPendingGrantError(cid: string, e: ReplicaLastError): Promise<void>;
  recordError(e: ReplicaLastError): Promise<void>;
  get(key: string): Promise<LocalEntry | undefined>;
  list(o: ListOpts): Promise<LocalEntry[]>;
  /** Live entries whose content is missing (pending repairs). */
  pendingRepairs(limit: number): Promise<Array<Extract<LocalEntry, { deleted: false }>>>;
  /** Content bytes of a committed blob, or undefined if absent. */
  readContent(hash: string): Promise<Uint8Array | undefined>;
  /** Fenced blob GC: unlink blobs no entry references, and stale temp files. */
  collectGarbage(t: LeaseToken): Promise<number>;
  /** `now` (ms since epoch) evaluates the authority window; defaults to the wall clock. */
  status(now?: number): Promise<ReplicaStatus>;
  close(): Promise<void>;
}
