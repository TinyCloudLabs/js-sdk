import type { Result, FetchFunction } from "../../types";
import type { KVGetOptions, KVListOptions, KVResponse } from "../types";
import type { ReplicaGateReason, ReplicaLifecycleGate, ReplicaPurgeLocalCopyResult, ReplicaSessionStamp } from "./lifecycle";
import type { ReplicaQuotaSpec } from "./quota";
import type { ReplicaConsentAnchor, ReplicaGrantPolicy } from "./grantPolicyTypes";

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
  /** The signed `exp`, ms since epoch; null when the grant has none. */
  expiresAt: number | null;
  /** Grant lifecycle: pending until confirmed/activated by a successful replica sync. */
  state: "active" | "pending";
  /** Both get and sync in the grant carry no caveats. */
  unconstrained: boolean;
  /**
   * ms since epoch, from the storage clock at the FIRST install of this grant CID, stored keyed
   * by CID and set once. Re-installing the same CID never refreshes it; recompute-at-open uses the
   * stored value.
   */
  installedAt?: number;
  /**
   * min(expiresAt, installedAt + grantTtlMs, consentDeadline), stored with the grant and
   * recomputed at open from the stored `installedAt` and the handle's `spec.grantPolicy`. Serving
   * requires `now < effectiveExpiresAt` with a finite stored value. Otherwise (NaN, ±Infinity,
   * missing) the effective authority is not `valid`, and get/list throw GRANT_EXPIRED inside the
   * read transaction without returning bytes or keys. Present on every Phase 2 grant.
   */
  effectiveExpiresAt?: number;
  /**
   * ms since epoch; consent anchor + CONSENT_WINDOW_MS. Serving and minting require
   * `now < consentDeadline` and a finite value (refusal code CONSENT_EXPIRED).
   */
  consentDeadline?: number;
  /**
   * The resolved consent anchor (finite ms, clamped to ≤ now). A `first_install` anchor is keyed by
   * identity (node: gate file `firstInstall`; browser: `device` store), survives partition reset,
   * purge, revocation and reinstall, and is cleared only by `deny`. An unreadable anchor fails
   * closed (no serving, no mint).
   */
  consentAnchor?: ReplicaConsentAnchor;
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
  /**
   * Browser: result of `navigator.storage.persist()`; null when the API is missing or not yet
   * asked. Node/CLI omit it (disk storage is persistent).
   */
  persisted?: boolean | null;
  /** A purge intent covers this partition (or its identity); it is unreadable until erased. */
  purgePending?: boolean;
}

/**
 * Ungated browser inspection returns only opaque, unsealed numeric controls from the
 * v2 meta row: coverageCode, syncedThroughEpoch, keys/contentMissing/tombstones and
 * contentBytes. It must not acquire the account key or decrypt grant, authority, cursor,
 * errors or KV payload. `redacted: true` distinguishes unknown from absent/revoked.
 */
export interface ReplicaInspectedStatus {
  redacted: true;
  coverage: ReplicaCoverage;
  syncedThroughEpoch: number;
  counts: LocalReplicaStatus["counts"];
  bytes: number;
  persisted?: boolean | null;
  purgePending?: boolean;
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
  /**
   * The session stamp this handle is bound to; immutable for the handle's life. With a `lifecycle`
   * gate (mandatory when replication is on), a spec without it is refused REPLICA_GATED
   * `not_established`, and every guarded transaction runs through `ReplicaGateTx.run` with it.
   * Use {@link ReplicaGatedSpec} where the stamp must be present.
   */
  stamp?: ReplicaSessionStamp;
  /**
   * Grant lifetime policy. Mandatory when replication is on: the controller always sets it, and a
   * Phase 2 adapter rejects `open` without it (REPLICA_INVALID_ARGUMENT). Optional in the type only
   * so Phase 1 callers compile.
   */
  grantPolicy?: ReplicaGrantPolicy;
  /** Quota settings; absent means unbounded. */
  quota?: ReplicaQuotaSpec;
  /** Value download policy for syncs of this handle; absent means `"eager"`. See `ReplicationOptions.contentFetch`. */
  contentFetch?: "eager" | "lazy";
  /**
   * Called when another tab/process commits a sync for this partition (browser: the worker's
   * `committed` BroadcastChannel message). The controller emits `replication.sync` with
   * `trigger: "peer"`, `origin: "peer"`. Must not throw; must not be called for own commits.
   */
  onPeerCommit?(info: ReplicaPeerCommit): void;
}

export interface ReplicaPeerCommit {
  /** ms since epoch of the peer's commit. */
  at: number;
  syncedThroughEpoch: number;
  changes?: number;
  coverage?: ReplicaCoverage;
}

/** A spec as a gated adapter accepts it: stamp and grant policy present. */
export type ReplicaGatedSpec = KVReplicaSpec & {
  stamp: ReplicaSessionStamp;
  grantPolicy: ReplicaGrantPolicy;
};

export interface KVReplicaHandle {
  readonly spec: KVReplicaSpec;
  /** Always equals `spec.device.did` when an explicit device was provided. */
  readonly deviceDid: string;
  /**
   * Opaque partition id for events. Required on Phase 2 `ReplicaGatedHandle`; optional here
   * only for Phase 1 adapters. Browser: private gate-HMAC partition id; node: replica hash.
   * A controller MUST NOT derive one from raw prefix/space or emit a grant event without it.
   */
  readonly replicaId?: string;
  /**
   * Guarded read. Adapters MUST NOT return value bytes unless the effective authority is `valid`
   * (signed exp, effective expiry, consent deadline, node-attested authority, revocation): they
   * throw GRANT_EXPIRED / GRANT_REVOKED / GRANT_NOT_YET_VALID / CONSENT_EXPIRED inside the read
   * transaction, and the controller falls through to the network with the matching reason. An
   * erased partition rejects RESET_REQUIRED (by tombstone/generation, not by unlink).
   */
  get(key: string): Promise<LocalGetResult>;
  /** Guarded read; same authority rule as `get` (no keys unless authority is `valid`). */
  list(o: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<LocalListResult>;
  /** Guarded read (runs through `ReplicaGateTx.run`). */
  grant(): Promise<ReplicaGrantInfo | null>;
  /**
   * Installs a grant after validating audience (the handle's device), `kv/get` + `kv/sync` coverage
   * of the prefix, and no caveats (caveated grants reject GRANT_NOT_COVERING). Stores `installedAt`
   * on first install of the CID and `effectiveExpiresAt`. Guarded: REPLICA_GATED.
   */
  installGrant(ucan: string): Promise<ReplicaGrantInfo>;
  /**
   * The controller supplies syncStartEpoch, captured from this identity's committedEpoch before
   * starting the sync. Every adapter, including the browser worker, MUST persist that exact epoch
   * in the same transaction as the sync's completion marker, only after the whole sync finishes
   * (feed pages, repairs and GC). Failed, aborted and busy syncs, including a failure after the
   * last feed page, MUST leave the prior fence unchanged. A successful result returns that
   * persisted value as syncedThroughEpoch. Aborting `signal` stops at the last complete page;
   * nothing past it commits. Gated: REPLICA_GATED; quota refusal: STORAGE_BUDGET / STORAGE_FULL,
   * keeping committed content.
   */
  sync(o: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult>;
  /** Status reports the durable syncedThroughEpoch, including after reopening this handle. */
  status(): Promise<LocalReplicaStatus>;
  /** Cancels and awaits in-flight syncs before closing. */
  close(): Promise<void>;
}

/** Phase 2 opened handle: immutable stamp/policy and an opaque event identifier. */
export type ReplicaGatedHandle = KVReplicaHandle & {
  readonly spec: ReplicaGatedSpec;
  readonly replicaId: string;
};

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
   * Read an existing replica's durable status without creating/mutating storage or waiting for a
   * mutation guard. Missing replicas return undefined; abort is honored. Ungated (no stamp):
   * browser returns a discriminated, redacted control-only status without acquiring the account
   * key or decrypting data; node/CLI may expose existing grant CIDs/times. Known metadata exposure.
   */
  inspectStatus?(spec: KVReplicaSpec, options: { signal: AbortSignal }): Promise<LocalReplicaStatus | ReplicaInspectedStatus | undefined>;
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
   *
   * With a `lifecycle` gate, the store is bound to `options.stamp` for its whole life (callers
   * cache stores per identity AND stamp). Every `read`, `readExisting` and `update` (append,
   * settle, remove, clear, flush) checks stamp, principal, incarnation and identity intent
   * (plus browser keyId) before touching storage; missing stamps refuse REPLICA_GATED
   * `not_established`. Browser derives private gate-HMAC ids asynchronously from `snapshot()`
   * before an IDB transaction, locks on that opaque identity id, then calls main-thread
   * `ReplicaGateTx.run`, whose first control request verifies the snapshot/keyId. Node's
   * identity-scoped `pending.json` is not SQLite: both reads and mutations take the mandatory
   * profile lock across gate/generation check and file access; mutations durably rename
   * before releasing it.
   * The identity generation advances atomically with a deny intent, so stale stores cannot
   * refill erased pending writes (CONTRACT.md §2). Missing locks fail closed.
   */
  pendingWrites?(
    identity: ReplicationIdentity,
    options?: { stamp?: ReplicaSessionStamp },
  ): PendingWriteStore;
  /**
   * The platform lifecycle gate (browser: origin DB control stores + logout marker; node/CLI:
   * gate file). Mandatory when replication is on: `indexedDbReplicaStorage()` and
   * `sqliteReplicaStorage()` expose it (node's `gateFile` defaults next to `dir`), and the web
   * runtime refuses storage without it with RUNTIME_UNSUPPORTED. Optional in the type only so
   * Phase 1 test doubles compile; use {@link ReplicaGatedStorage} for Phase 2 adapters.
   */
  readonly lifecycle?: ReplicaLifecycleGate;
}

/** A Phase 2 adapter: the unstamped Phase 1 `open` overload is deliberately absent. */
export type ReplicaGatedStorage = Omit<KVReplicaStorage, "open" | "lifecycle"> & {
  readonly lifecycle: ReplicaLifecycleGate;
  open(spec: ReplicaGatedSpec): Promise<ReplicaGatedHandle>;
};

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
  /**
   * Consistent gated snapshot. Browser: guarded IDB read; node/CLI: mandatory profile lock
   * across gate check and pending.json read (not an unlocked atomic-file snapshot).
   */
  read(): Promise<PendingWriteState>;
  /**
   * Read an existing durable snapshot without initializing storage; undefined means no file exists.
   * Gated.
   */
  readExisting?(): Promise<PendingWriteState | undefined>;
  /**
   * Serialized read-modify-write; durable stores persist before resolve. Errors on mismatch/failure.
   * Gated: the assert runs inside the same transaction/guard as the write.
   */
  update<T>(mutate: (s: PendingWriteState) => T): Promise<T>;
}

export type AuthorityRefusal = {
  refused: "NOT_COVERED" | "CAVEATED_AUTHORITY" | "SESSION_EXPIRING";
};
export interface ReplicationAuthority {
  /**
   * Compact delegated/session-only authority: never consult `plan`, mint or silently renew.
   * A matching persisted stamp and independently verified, active installed grant are not
   * enough to serve locally: the CURRENT session must also have uncaveated get authority
   * for each requested key/list prefix. If `sessionGrant(prefix)` refuses NOT_COVERED,
   * CAVEATED_AUTHORITY or SESSION_EXPIRING, use network KV even while that stored grant
   * remains active. A stored grant never establishes fresh consent or replaces the
   * current session's own authority.
   */
  sessionOnly?: boolean;
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
    /**
     * `expiryMs` is a DURATION from now (forwarded as `delegateTo(…, { expiry: expiryMs })`), from
     * `mintRemainingMs`. Absent means Phase 1 behaviour (session-tier default). `renewalOnly`
     * requires the authority to recheck a session-key parent at mint time; an initial runtime
     * parent mint leaves it unset.
     */
    options?: { expiryMs?: number; renewalOnly?: boolean },
  ): Promise<{ ucan: string; parentCid: string; expiresAt: number }>;
  /**
   * Finite consent anchor from an independently validated signed owner SIWE `issuedAt`
   * with finite signed `expirationTime` and an exact-full-space verified, uncaveated KV
   * get+sync witness, or the independently verified **oldest owner-authorizing** compact
   * proof's signed `iat`/`nbf` (never its child leaf). Null when owner proof bytes,
   * KV witness, finite SIWE expiration or proof timestamp are unavailable: arbitrary
   * did:key/empty-prf leaves and compact leaf CID/prf alone are insufficient even with
   * finite leaf `iat`/`nbf`. Storage may use `first_install` only to bound expiry;
   * null cannot establish a fresh session stamp.
   */
  consentAnchor?(): ReplicaConsentAnchor | null;
  /** True only for verified owner session-key derivation. Compact delegated / sessionOnly cannot silently renew. */
  readonly canRenew?: boolean;
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
  /** Node `/info` features discovered on sign-in for protocol gating. */
  nodeFeatures?: readonly string[];
  /**
   * This session's stamp; forwarded into every `KVReplicaSpec.stamp` and pending store. With
   * `storage.lifecycle` present, a missing stamp makes the controller `gated` (`not_established`)
   * and it never opens. A controller is never rebound with a new stamp for an existing session
   * object: a new stamp requires a new session.
   */
  stamp?: ReplicaSessionStamp;
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
    conditional?: boolean;
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
  /**
   * Internal browser gate observer: invoked only after the stamped durable consent-expiry
   * denial/deletion commits. Records opened opaque grant transitions even if the gate's own
   * timer wins before this controller's timer; does not issue a second deny.
   */
  observeConsentExpired(stamp: ReplicaSessionStamp): void;
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
  /**
   * Browser: erases the whole local copy (the IndexedDB database) once the account has been
   * denied by sign-out or account switch; `signOut()` and account switch already do this. Retries
   * a few times when the delete is blocked. `{ ok: false, retryNow: true }`: the copy is still
   * there and a short bounded retry is meaningful (the deny outcome kept the keys, or the delete
   * is blocked); the SDK also finishes the erase on the next load. `retryNow: false`: nothing is
   * erasable now (a session is live, or the storage has no browser database). Never rejects.
   */
  purgeLocalCopy(): Promise<ReplicaPurgeLocalCopyResult>;
  close(): Promise<void>;
}

export interface ReplicationOptions {
  enabled: boolean;
  /** Non-empty list of folder prefixes ending in `/`, or `/` for the whole space. */
  prefixes: string[];
  /** Required for prefixes/spaces where requiresSecretsOptIn returns true. */
  allowSecrets?: boolean;
  /** Sign-in asks for kv/sync on each declared prefix only and never widens to a root entry that covers them. */
  syncScope?: "prefixes";
  /**
   * `"eager"` (default) downloads each changed value while syncing. `"lazy"` syncs entry names
   * without downloading values; a read of a value the replica does not hold goes to the network.
   */
  contentFetch?: "eager" | "lazy";
  /** Background interval; default 60 seconds. */
  syncIntervalMs?: number;
  maxStalenessMs?: number;
  staleSyncTimeoutMs?: number;
  verify?: boolean;
  onEvent?: (event: ReplicationEvent) => void;
  /**
   * Device-grant lifetime from install; default DEFAULT_GRANT_TTL_MS (24 h). Values ≤ 0 or above
   * MAX_GRANT_TTL_MS (7 d) are a TypeError at construction.
   */
  grantTtlMs?: number;
  /**
   * Replica byte budget; absent means unbounded. Browser: origin-wide across every partition.
   * Node/CLI: per profile (per storage dir). Forwarded to storage via `KVReplicaSpec.quota`.
   * Node/CLI bounds the COMMITTED replica blob content only; the database, WAL, rows and the
   * pending store are not counted. During a page commit the previous blobs of replaced entries
   * stay until the commit completes, so on-disk bytes can transiently reach `maxBytes` plus the
   * bytes that page replaces. Orphaned blobs left by a crash are counted until collected on open.
   */
  maxBytes?: number;
  /** Browser free-space floor; default DEFAULT_MIN_FREE_BYTES (64 MiB). Ignored on node/CLI. */
  minFreeBytes?: number;
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
  /** True when only opaque, ungated durable controls were inspected; no authority is known. */
  redacted?: boolean;
  prefix: string;
  state: ReplicaState;
  reason?: ReplicationReason;
  /** Set while state is `gated`. */
  gate?: ReplicaGateReason;
  errorCode?: string;
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
  /** The lifecycle gate refuses this session (REPLICA_GATED); reads use the network. */
  | "gated"
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
  /** A revoked grant, including a stale-read sync refusal; read-through uses network with code GRANT_REVOKED. */
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
  | "NETWORK_REQUESTED"
  /** The lifecycle gate refused (REPLICA_GATED); the read went to the network. */
  | "replica_gated";

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
      /** `peer`: another tab/process committed (via `KVReplicaSpec.onPeerCommit`); no local work ran. */
      trigger: "start" | "interval" | "stale_read" | "manual" | "peer";
      /** Present and `peer` only for peer-commit notifications. */
      origin?: "peer";
      outcome: "ok" | "busy" | "error" | "aborted";
      class?: "offline" | "authority" | "storage" | "node" | "lifecycle";
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
      /**
       * Grant lifetime and renewal (CONTRACT.md §3). Carries no raw account fields (`space`,
       * prefix or principal). This does not claim confidentiality against a raw browser-profile
       * reader who also has the persisted signed-in session.
       */
      type: "replication.grant";
      at: string;
      /** Opaque id from an opened `ReplicaGatedHandle`, never inferred from raw space/prefix. */
      replicaId: string;
      action:
        | "minted"
        | "renewed"
        /** The node or authority refused renewal; current grant serves until effective expiry. */
        | "renewal_refused"
        /** Offline or the authority can't derive; retried on the next trigger. */
        | "renewal_deferred"
        /** An overlong session/restored grant was capped locally or replaced by a derived grant. */
        | "capped"
        | "expired"
        | "consent_deadline_reached";
      code?: string;
      /** ISO instants. */
      effectiveExpiresAt?: string;
      consentDeadline?: string;
      /** Duration passed to `mint` (`expiryMs`). */
      expiryMs?: number;
    }
  | {
      /** Sign-out / switch / consent-expiry lifecycle (CONTRACT.md §2). No raw account fields. */
      type: "replication.lifecycle";
      at: string;
      /** Replica id when the step concerns one partition (same scheme as `replication.grant`). */
      replicaId?: string;
      action:
        | "denied"
        /** A stale caller's deny: disabled in memory only; gate untouched. */
        | "deny_stale"
        | "deny_failed"
        | "database_deleted"
        | "marker_set"
        | "marker_cleared"
        | "unguarded"
        | "drained"
        | "erased"
        | "erase_failed"
        | "activation_blocked"
        | "activated"
        | "recovered";
      reason?: "sign_out" | "account_switch" | "consent_expired" | "startup";
      gate?: ReplicaGateReason;
      /** Partitions/intents affected by this step. */
      partitions?: number;
      /** Intents still outstanding after this step. */
      remaining?: number;
      code?: string;
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
