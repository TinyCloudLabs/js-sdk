import type { Result, FetchFunction } from "../../types";
import type { KVGetOptions, KVListOptions, KVResponse } from "../types";

export interface ReplicationIdentity {
  /** Canonical HTTP(S) URL: origin + path without trailing slash; no credentials/query/fragment. */
  host: string;
  /** Full TinyCloud space id; only the EIP-155 address segment is lower-cased. */
  space: string;
  /** Principal `did:pkh:eip155:…`; only the EIP-155 address segment is lower-cased. */
  principal: string;
}

export type ReplicaCoverage = "empty" | "bootstrapping" | "complete";
export type ReplicaAuthorityState =
  | "valid"
  | "expired"
  | "revoked"
  | "not-yet-valid";
export interface LocalReadMeta {
  asOf: string | null;
  coverage: ReplicaCoverage;
  authority: ReplicaAuthorityState;
  /** Durable identity commit epoch captured before the last successful sync began. */
  syncedThroughEpoch: number;
}

export type LocalGetResult =
  | {
      status: "present";
      key: string;
      value: Uint8Array;
      etag: string;
      metadata: Record<string, string>;
      meta: LocalReadMeta;
    }
  | {
      status: "content_missing";
      key: string;
      etag: string;
      metadata: Record<string, string>;
      meta: LocalReadMeta;
    }
  | {
      status: "deleted" | "absent" | "coverage_incomplete" | "not_covered";
      key: string;
      meta: LocalReadMeta;
    };

/** Live keys under a plain `startsWith` prefix, after-exclusive UTF-8 byte ordering, at most limit. */
export interface LocalListResult {
  keys: string[];
  meta: LocalReadMeta;
}

export type LocalSyncResult =
  | {
      status: "synced";
      pages: number;
      changes: number;
      deleted: number;
      fetched: number;
      contentMissing: number;
      coverage: ReplicaCoverage;
      /** The input syncStartEpoch, persisted atomically only when this sync succeeds. */
      syncedThroughEpoch: number;
    }
  | { status: "busy" };

export interface ReplicaGrantInfo {
  cid: string;
  parentCid: string | null;
  expiresAt: number | null;
  /** Grant lifecycle: pending until confirmed/activated by a successful replica sync. */
  state: "active" | "pending";
  /** Both get and sync in the grant carry no caveats. */
  unconstrained: boolean;
}

export interface LocalReplicaStatus {
  coverage: ReplicaCoverage;
  lastSyncAt: string | null;
  /** Durable identity commit epoch captured before the last successful sync began. */
  syncedThroughEpoch: number;
  authority: { state: ReplicaAuthorityState; expiresAt: string | null };
  grant: ReplicaGrantInfo | null;
  counts: { keys: number; contentMissing: number; tombstones: number };
  bytes: number;
  lastError: { at: string; code: string; message: string } | null;
}

export interface ReplicaDevice {
  did: string;
  jwk: object;
}

/** Identity is canonical; `space` is the session's verbatim space id for replica calls. */
export interface KVReplicaSpec {
  identity: ReplicationIdentity;
  space: string;
  prefix: string;
  allowSecrets: boolean;
  /**
   * When present, adapters MUST use this device for partition naming, grant audience checks,
   * and signing sync requests; they MUST NOT load or create their own device key for this handle.
   */
  device?: ReplicaDevice;
  /** Graph-scoped fetch for main-thread adapters; worker adapters ignore it. */
  fetch?: FetchFunction;
}

export interface KVReplicaHandle {
  readonly spec: KVReplicaSpec;
  /** Always equals `spec.device.did` when an explicit device was provided. */
  readonly deviceDid: string;
  get(key: string): Promise<LocalGetResult>;
  list(o: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<LocalListResult>;
  grant(): Promise<ReplicaGrantInfo | null>;
  installGrant(ucan: string): Promise<ReplicaGrantInfo>;
  /**
   * The controller supplies syncStartEpoch, captured from this identity's committedEpoch before
   * starting the sync. Every adapter, including the browser worker, MUST persist that exact epoch
   * atomically with the successful replica sync; failed and busy syncs MUST leave the prior fence
   * unchanged. A successful result returns that persisted value as syncedThroughEpoch.
   */
  sync(o: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult>;
  /** Status reports the durable syncedThroughEpoch, including after reopening this handle. */
  status(): Promise<LocalReplicaStatus>;
  /** Cancels and awaits in-flight syncs before closing. */
  close(): Promise<void>;
}

export interface PurgeTarget {
  identity: ReplicationIdentity;
  /** Verbatim session space id used by the corresponding replica handle. */
  space: string;
  prefix: string;
  /** Session device in delegate posture, when one is used. */
  sessionDeviceDid?: string;
}

/**
 * Replica persistence adapters. B-node's Node/CLI adapter MUST provide durable pending state.
 * If that state cannot be opened (for example, a file-store failure), it MUST surface the
 * unavailable/error to the controller; the controller MUST fail closed to network reads and
 * MUST NOT silently substitute memory.
 */
export interface KVReplicaStorage {
  readonly kind: "sqlite" | "indexeddb";
  open(spec: KVReplicaSpec): Promise<KVReplicaHandle>;
  /**
   * Erases replicas for the identity and prefix across the deduplicated union of the adapter's
   * stored device (if any) and `sessionDeviceDid`. A missing stored device never skips the
   * session-device purge. Does not open, mint, or sync. Erasure removes entries, blobs, grant,
   * config, and authority; earlier handles reject with RESET_REQUIRED. A contentless tombstone
   * may remain. Rejects with an error carrying `code` on failure.
   */
  purge(target: PurgeTarget): Promise<void>;
  /**
   * Optional only for volatile runtimes. Omission means an in-memory store with `durable: false`.
   * B-node's Node/CLI adapter MUST provide a durable store and surface open failures, never
   * silently fall back to memory.
   */
  pendingWrites?(identity: ReplicationIdentity): PendingWriteStore;
}

export interface PendingWriteRecord {
  opId: string;
  seq: number;
  key: string;
  op: "put" | "delete";
  state: "in_flight" | "committed" | "ambiguous";
  epoch: number | null;
  at: string;
  settledAt: string | null;
  code?: string;
}

/** One identity-scoped pending state, with a monotonically increasing commit epoch and sequence. */
export interface PendingWriteState {
  v: 2;
  identity: ReplicationIdentity;
  committedEpoch: number;
  seq: number;
  records: PendingWriteRecord[];
}

/** Identity-scoped pending state and its restart-durability guarantee. */
export interface PendingWriteStore {
  /**
   * True only when committedEpoch and all records survive process restarts; false for memory or
   * other volatile stores.
   */
  readonly durable: boolean;
  readonly identity: ReplicationIdentity;
  /** Consistent lock-free snapshot, e.g. a read of an atomic file replacement. */
  read(): Promise<PendingWriteState>;
  /** Serialized read-modify-write; durable stores persist before resolve. Errors on mismatch/failure. */
  update<T>(mutate: (s: PendingWriteState) => T): Promise<T>;
}

export type AuthorityRefusal = {
  refused: "NOT_COVERED" | "CAVEATED_AUTHORITY" | "SESSION_EXPIRING";
};
export interface ReplicationAuthority {
  sessionGrant(
    prefix: string,
  ): { ucan: string; device: ReplicaDevice } | AuthorityRefusal;
  plan(
    prefix: string,
  ):
    | { path: "session" | "runtime"; parentCid: string; expiresAt: number }
    | AuthorityRefusal;
  mint(
    deviceDid: string,
    prefix: string,
    signal: AbortSignal,
  ): Promise<{ ucan: string; parentCid: string; expiresAt: number }>;
}

export interface ReplicationScheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

export interface KVReplicationDeps {
  options: ResolvedReplicationOptions;
  mode: "background" | "foreground";
  storage: KVReplicaStorage;
  identity: ReplicationIdentity;
  session: { id: string; did: string; space: string };
  authority: ReplicationAuthority;
  /**
   * The controller MUST enforce the catch-up trust invariant. With durable pending state,
   * committedEpoch and records survive restarts, so the syncedThroughEpoch fence applies normally.
   * With non-durable state, a replica may serve local reads only after a successful sync that
   * started in this process after this store was created. Until then, every read MUST use the
   * network with REPLICA_UNPROVEN_SINCE_START; an older durable syncedThroughEpoch is not proof
   * after restart. Pending-state failures also fail closed to network reads.
   */
  pending: PendingWriteStore;
  scheduler: ReplicationScheduler;
  emit(event: ReplicationEvent): void;
  fetch?: FetchFunction;
  previous?: Promise<void>;
}

export interface KVListPage {
  keys: string[];
  truncated?: boolean;
  nextCursor?: string;
}

export interface KVReadThrough {
  /** The callback executes the complete existing network implementation under the caller's signal. */
  get<T>(r: {
    space: string;
    key: string;
    path: string;
    options: KVGetOptions | undefined;
    signal: AbortSignal;
    network: () => Promise<Result<KVResponse<T>>>;
  }): Promise<Result<KVResponse<T>>>;
  list(r: {
    space: string;
    listPath: string;
    options: KVListOptions | undefined;
    signal: AbortSignal;
    network: () => Promise<Result<KVListPage>>;
  }): Promise<Result<KVListPage>>;
  write<T>(r: {
    op: "put" | "delete" | "batchPut";
    space: string;
    entries: ReadonlyArray<{ path: string; body?: Blob | string }>;
    signal: AbortSignal;
    network: () => Promise<Result<T>>;
  }): Promise<Result<T>>;
  /**
   * Best-effort observation for a caller-forced network read, invoked after it settles. This
   * synchronous event hook MUST NOT read replica storage or start a sync. KVService catches and
   * ignores thrown errors so the observation cannot change the network read.
   */
  observeNetworkRequested(r: {
    op: "get" | "list";
    space: string;
    /** Absolute get path, or the fully resolved list path. */
    path: string;
    reason: "NETWORK_REQUESTED";
    outcome: "found" | "not_found" | "error";
    latencyMs: number;
  }): void;
}
export interface KVReplicationController extends KVReadThrough {
  status(): Promise<ReplicaStatusEntry[]>;
  sync(o?: { prefix?: string; signal?: AbortSignal }): Promise<void>;
  /** Not async: synchronously stops timers/syncs and blocks new local opens before returning its promise. */
  purge(o?: { timeoutMs?: number }): Promise<ReplicationPurgeReport>;
  clearPending(): Promise<number>;
  /** Synchronously aborts syncs; resolves after settlement and handle closure. */
  close(): Promise<void>;
}
export declare function createKVReplication(
  deps: KVReplicationDeps,
): KVReplicationController;
export interface ReplicationControl {
  status(): Promise<ReplicaStatusEntry[]>;
  sync(o?: { prefix?: string }): Promise<void>;
  /**
   * Synchronous stop phase; promise never rejects. Awaits aborted syncs (bounded by timeout),
   * closes handles, purges every configured prefix of the bound/last identity, and clears only
   * records beneath successfully purged prefixes. Failures are returned and emitted.
   */
  purge(o?: { timeoutMs?: number }): Promise<ReplicationPurgeReport>;
  /**
   * Removes all ambiguous records and in-flight records older than ten minutes; younger in-flight
   * and committed records remain. Exposed callers MUST show CLEAR_PENDING_WARNING first.
   */
  clearPending(): Promise<number>;
  close(): Promise<void>;
}

export interface ReplicationOptions {
  enabled: boolean;
  /** Non-empty primary-space prefixes; none empty or overlapping. Prefer no trailing slash. */
  prefixes: string[];
  /** Required for prefixes/spaces where requiresSecretsOptIn returns true. */
  allowSecrets?: boolean;
  /** Background interval; default 60 seconds. */
  syncIntervalMs?: number;
  maxStalenessMs?: number;
  staleSyncTimeoutMs?: number;
  verify?: boolean;
  onEvent?: (event: ReplicationEvent) => void;
}
export interface ResolvedReplicationOptions extends ReplicationOptions {
  syncIntervalMs: number;
  maxStalenessMs: number;
  staleSyncTimeoutMs: number;
  allowSecrets: boolean;
  verify: boolean;
}
export interface ReplicationPurgeReport {
  purged: string[];
  failed: Array<{ prefix: string; code: string }>;
}
export interface PinnedKey {
  key: string;
  state: "in_flight" | "ambiguous";
  op: "put" | "delete";
  since: string;
  code?: string;
  likelyOrphaned: boolean;
}
export interface ReplicaStatusEntry extends Partial<LocalReplicaStatus> {
  prefix: string;
  state: ReplicaState;
  reason?: ReplicationReason;
  pending: { inFlight: number; committed: number; ambiguous: number };
  pinned: PinnedKey[];
  lagMs: number | null;
}
export type ReplicaState =
  | "idle"
  | "ready"
  | "grant_missing"
  | "runtime_unsupported"
  | "unavailable"
  | "revoked"
  | "closed";

export type ReplicationReason =
  | "hit"
  | "absent"
  | "deleted"
  | "content_missing"
  | "coverage_incomplete"
  | "not_covered"
  | "pending_write"
  | "grant_missing"
  | "grant_expired"
  | "grant_revoked"
  | "grant_not_yet_valid"
  | "stale"
  | "replica_error"
  | "runtime_unsupported"
  | "replica_unavailable"
  | "unsupported_option"
  | "network_cursor"
  | "cursor_restart"
  | "aborted"
  | "REPLICA_BEHIND_OWN_WRITES"
  | "REPLICA_UNPROVEN_SINCE_START"
  | "NETWORK_REQUESTED";

export type ReplicationEvent =
  | {
      type: "replication.read";
      at: string;
      op: "get" | "list";
      space: string;
      key: string;
      replica: string | null;
      source: "replica" | "network" | "none";
      reason: ReplicationReason;
      outcome: "found" | "not_found" | "error";
      latencyMs: number;
      stalenessMs: number | null;
      coverage: ReplicaCoverage | null;
      authority: ReplicaAuthorityState | null;
      code?: string;
      syncError?: string;
      syncedBeforeRead?: boolean;
      pendingState?: "in_flight" | "committed" | "ambiguous";
      verify?: "match" | "diverged" | "error" | "aborted";
      count?: number;
    }
  | {
      type: "replication.write";
      at: string;
      op: "put" | "delete" | "batchPut";
      space: string;
      keys: string[];
      outcome: "committed" | "failed" | "ambiguous";
      code?: string;
      latencyMs: number;
    }
  | {
      type: "replication.sync";
      at: string;
      space: string;
      replica: string;
      trigger: "start" | "interval" | "stale_read" | "manual";
      outcome: "ok" | "busy" | "error" | "aborted";
      class?: "offline" | "authority" | "storage" | "node";
      code?: string;
      durationMs: number;
      lagMs: number | null;
      pendingCleared?: number;
      pages?: number;
      changes?: number;
      deleted?: number;
      fetched?: number;
      contentMissing?: number;
      coverage?: ReplicaCoverage;
    }
  | {
      type: "replication.state";
      at: string;
      space?: string;
      replica?: string;
      state:
        | "opened"
        | "grant_installed"
        | "grant_missing"
        | "runtime_unsupported"
        | "unavailable"
        | "revoked"
        | "recreated"
        | "purged"
        | "purge_failed"
        | "pending_store_error"
        | "pinned"
        | "pending_cleared"
        | "closed";
      code?: string;
      strategy?: "session" | "minted" | "installed";
      count?: number;
      keys?: string[];
    }
  | {
      type: "replication.divergence";
      at: string;
      op: "get" | "list";
      space: string;
      key: string;
      replica: string;
      kind: "value" | "missing_local" | "extra_local" | "keys" | "order";
      localEtag?: string | null;
      networkEtag?: string | null;
      localOnly?: string[];
      networkOnly?: string[];
      stalenessMs: number | null;
    };
