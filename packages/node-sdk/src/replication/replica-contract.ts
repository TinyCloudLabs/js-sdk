/**
 * The structural contract for `@tinycloud/replica` and
 * `@tinycloud/replica/sqlite`, as the Node adapter (`./sqlite.ts`) uses it.
 *
 * Why this file exists: the monorepo builds node-sdk BEFORE replica's
 * `dist` exists (authority/I0/I1/operations workflows), and this package
 * compiles under `moduleResolution: node`, which cannot read replica's
 * `exports` map at all. An `import type` or a literal `import()` specifier
 * therefore fails the DTS build with TS2307 the moment replica's
 * declarations are absent. The adapter types its lazily loaded modules
 * against these declarations instead — a build-time dependency on
 * replica's build output is gone by construction.
 *
 * The copies below are VERBATIM from the replica sources named in each
 * section so that drift fails cleanly: `replica-contract.test.ts` runs
 * wherever replica IS built and assigns the real modules to
 * `ReplicaRuntime`/`SqliteRuntime` — an incompatible change in replica is a
 * type error there, and the runtime half reports which member is missing.
 */

/* --------------------------------------------------------------------------
 * packages/replica/src/errors.ts
 * ------------------------------------------------------------------------ */

export type ReplicaErrorCode =
  | "REPLICA_BUSY"
  | "REPLICA_NOT_FOUND"
  | "REPLICA_CONFIG_MISMATCH"
  | "RUNTIME_UNSUPPORTED"
  | "REPLICA_INVALID_ARGUMENT"
  | "STORAGE_ERROR"
  | "STORAGE_FULL"
  | "NOT_COVERED"
  | "SECRETS_OPT_IN_REQUIRED"
  | "GRANT_MISSING"
  | "GRANT_INVALID"
  | "GRANT_FORMAT_UNSUPPORTED"
  | "GRANT_AUDIENCE_MISMATCH"
  | "GRANT_NOT_COVERING"
  | "GRANT_NOT_YET_VALID"
  | "GRANT_EXPIRED"
  | "GRANT_REVOKED"
  | "GRANT_UNAUTHORIZED"
  | "RETENTION_GRANT_REFUSED"
  | "NETWORK_ERROR"
  | "NODE_ERROR"
  | "PROTOCOL_ERROR"
  | "RESET_REQUIRED"
  | "SOURCE_CHANGED"
  | "SCOPE_VIOLATION"
  | "CONTENT_MISMATCH"
  | "INTEGRITY_ERROR"
  | "REPLICA_CLOSED";

/** The instance shape of replica's `ReplicaError` class. */
export interface ReplicaError extends Error {
  readonly code: ReplicaErrorCode;
  readonly detail?: Record<string, unknown>;
}

/* --------------------------------------------------------------------------
 * packages/replica/src/types.ts
 * ------------------------------------------------------------------------ */

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
   * The retention grant CID the sync request presented for this page. The
   * store persists the attested `retainUntil` only when the stored
   * `retentionGrantCid` still equals it at commit — a `setRetentionGrant`
   * racing the in-flight page keeps `retainUntil` null instead of
   * re-establishing the previous grant's window under a new CID.
   */
  retentionGrantCid: string | null;
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

/* --------------------------------------------------------------------------
 * packages/replica/src/engine.ts
 * ------------------------------------------------------------------------ */

export type ReadMeta = {
  consistency: "observed";
  source: { host: string; nodeDid: string | null; space: string; prefix: string };
  asOf: string | null;
  coverage: Coverage;
  /** `expired` while reads continue under a node-attested retention. */
  authority: AuthorityState;
};

export type ReplicaReadResult =
  | { status: "present"; key: string; value: Uint8Array; etag: string; metadata: Record<string, string>; meta: ReadMeta }
  | { status: "content_missing"; key: string; etag: string; metadata: Record<string, string>; meta: ReadMeta }
  | { status: "deleted" | "absent"; key: string; meta: ReadMeta }
  | { status: "coverage_incomplete" | "not_covered"; key: string; meta: ReadMeta };

export type ReplicaListEntry = { key: string; etag: string; metadata: Record<string, string>; content: boolean };

export type ReplicaListResult = { entries: ReplicaListEntry[]; meta: ReadMeta };

export type SyncReport = {
  pages: number;
  changes: number;
  deleted: number;
  fetched: number;
  contentMissing: number;
  repaired: number;
  resets: number;
  coverage: Coverage;
  cursorAdvanced: boolean;
  promotedGrant: boolean;
  blobsCollected: number;
};

export type ReplicaOptions = {
  store: ReplicaStore;
  /** One transport for whichever grant the replica syncs under (tests, single-grant hosts). */
  transport?: ReplicaTransport;
  /**
   * A transport that invokes with exactly `grant`. Lets the engine try a
   * pending grant and fall back to the active one if the node refuses it.
   */
  transportFor?: (grant: GrantRecord) => ReplicaTransport;
  now?: () => number;
  leaseTtlMs?: number;
  /**
   * Called after every committed page and repair batch — also those of a sync
   * that later fails. Lets the caller report partial progress immediately.
   */
  onCommit?: () => void;
};

/** The instance shape of replica's `Replica` engine class (the members the adapter calls). */
export interface Replica {
  get(key: string, options?: { verify?: boolean }): Promise<ReplicaReadResult>;
  list(options?: ListOpts): Promise<ReplicaListResult>;
  status(): Promise<ReplicaStatus>;
  sync(options?: { limit?: number; signal?: AbortSignal }): Promise<SyncReport>;
}

/* --------------------------------------------------------------------------
 * packages/replica/src/grant.ts
 * ------------------------------------------------------------------------ */

export type ParsedUcanGrant = GrantRecord & {
  /** The signed attenuation: resource → ability → caveats. */
  att: Record<string, Record<string, unknown>>;
  /** Signed proof CIDs. */
  prf: string[];
  /** The compact JWT, without any `Bearer ` prefix. */
  jwt: string;
};

/* --------------------------------------------------------------------------
 * packages/replica/src/transport.ts
 * ------------------------------------------------------------------------ */

/** The sdk-services `ServiceError` fields the transport reads. */
type ServiceError = { code: string; message: string; meta?: Record<string, unknown> };
type Result<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

type KVChangesResponse = {
  changes: Change[];
  more: boolean;
  cursor: string;
  source: { nodeDid: string; space: string; prefix: string };
  authority: AuthorityWindow;
};

type KVValue = { data: unknown; headers: { etag?: string } };

/**
 * The slice of sdk-services `KVService` a replica needs: the `tinycloud.kv/sync`
 * feed (`changes`, TC-736) and binary reads. Typed structurally so this
 * package never imports an SDK entry point (web-sdk defines custom elements
 * on load; node-sdk pulls in Node-only code).
 */
export interface KVSyncClient {
  changes(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
    retentionGrant?: string;
    signal?: AbortSignal;
  }): Promise<Result<KVChangesResponse>>;
  get(key: string, options: { binary: true; signal?: AbortSignal }): Promise<Result<KVValue>>;
  batchGet(
    keys: string[],
    options: { binary: true; signal?: AbortSignal },
  ): Promise<Result<{ results: Array<{ key: string; result: Result<KVValue> }> }>>;
}

/* --------------------------------------------------------------------------
 * packages/replica/src/sqlite/store.ts
 * ------------------------------------------------------------------------ */

export type MutationGuard = <T>(section: () => Promise<T>) => Promise<T>;

export type SqliteReplicaStoreOptions = {
  /** Create the replica directory and database if missing (else REPLICA_NOT_FOUND). */
  create: boolean;
  /** Clock for leases and status (ms since epoch). */
  now?: () => number;
  guard?: MutationGuard;
};

/**
 * The instance shape of replica's `SqliteReplicaStore` class: the full
 * `ReplicaStore` contract plus the class-only members the adapter calls
 * (`destroy` removes the replica directory under a live lease).
 */
export interface SqliteReplicaStore extends ReplicaStore {
  destroy(t: LeaseToken): Promise<void>;
}

/* --------------------------------------------------------------------------
 * The lazily loaded module namespaces.
 * ------------------------------------------------------------------------ */

/** The members of `@tinycloud/replica` the adapter uses, as a value-level contract. */
export interface ReplicaRuntime {
  Replica: new (options: ReplicaOptions) => Replica;
  ReplicaError: new (
    code: ReplicaErrorCode,
    message: string,
    detail?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) => ReplicaError;
  ReplicaErrorCode: {
    BUSY: ReplicaErrorCode;
    NOT_FOUND: ReplicaErrorCode;
    CLOSED: ReplicaErrorCode;
    CONFIG_MISMATCH: ReplicaErrorCode;
    SECRETS_OPT_IN_REQUIRED: ReplicaErrorCode;
    GRANT_NOT_COVERING: ReplicaErrorCode;
    RESET_REQUIRED: ReplicaErrorCode;
  };
  isReplicaError(error: unknown, code?: ReplicaErrorCode): error is ReplicaError;
  parseUcanGrant(input: Uint8Array | string): ParsedUcanGrant;
  assertGrantInstallable(
    grant: ParsedUcanGrant,
    input: { deviceDid: string; space: string; prefix: string; now: number },
  ): void;
  kvSyncTransport(kv: KVSyncClient): ReplicaTransport;
}

/** The members of `@tinycloud/replica/sqlite` the adapter uses. */
export interface SqliteRuntime {
  SqliteReplicaStore: {
    open(dir: string, options: SqliteReplicaStoreOptions): Promise<SqliteReplicaStore>;
    inspect(dir: string, options?: { now?: () => number; signal?: AbortSignal }): Promise<{ state: ReplicaState; status: ReplicaStatus } | null>;
  };
}
