/**
 * Lifecycle / epoch gate contract (TC-858 Phase 2, CONTRACT.md §2). Types only.
 *
 * One interface, implemented per platform: the browser keeps the gate in the origin database's
 * control stores plus the `localStorage` logout marker; node/CLI keep it in a gate file next to
 * the replicas (`<profile>/replica-gate.json`). `Tx` is the platform's transaction: an
 * `IDBTransaction` in the browser, the guarded-mutation context on node/CLI.
 */

/**
 * Captured once when a session is established (sign-in, or restore of a session persisted under
 * that stamp) and immutable for that session. Persisted next to the SIWE in the session record
 * (sdk-core `PersistedSessionData.replicaStamp`, added by S3). A missing stamp means "not
 * established" and is refused.
 */
export interface ReplicaSessionStamp {
  /** Random id generated when the gate store is created; changes when it is deleted and recreated. */
  readonly incarnation: string;
  /** Non-negative integer; +1 on every sign-out and account switch; never decreases within an incarnation. */
  readonly lifecycleEpoch: number;
}

/** The durable account gate: one per browser origin, one per node/CLI profile. */
export interface ReplicaAccountGate {
  incarnation: string;
  /** Lower-cased principal DID of the active account; null after sign-out. */
  principal: string | null;
  lifecycleEpoch: number;
}

/** What a guarded operation presents to the gate. Access needs stamp AND principal to match. */
export interface ReplicaGateAccess {
  stamp: ReplicaSessionStamp;
  /** Canonical principal of the handle's identity. */
  principal: string;
  /** When set, the operation is also refused while a purge intent covers this partition. */
  partitionId?: string;
}

/** Why the gate refused (`REPLICA_GATED` errors carry this as `gate`). */
export type ReplicaGateReason =
  /** The spec or session carried no stamp. */
  | "not_established"
  /** Incarnation or lifecycleEpoch differs from the gate (signed out, switched, or DB recreated). */
  | "stamp_stale"
  /** The gate's principal is null or another account. */
  | "principal_mismatch"
  /** A purge intent covers the partition, or activation awaits the previous principal's erase. */
  | "purge_pending"
  /** Browser only: the `localStorage` logout marker is set. */
  | "logout_pending"
  /** The gate store itself could not be read; fail closed. */
  | "gate_unavailable";

/** Shape of every gate refusal error: `Error & { code: "REPLICA_GATED"; gate }`. */
export interface ReplicaGatedError extends Error {
  code: "REPLICA_GATED";
  gate: ReplicaGateReason;
}

/** Every partition ever created in this gate's scope. */
export interface ReplicaPartitionIndexEntry {
  partitionId: string;
  /** `replicationIdentityKey(identity)`. */
  identityKey: string;
  principal: string;
  prefix: string;
  deviceDid: string;
  /** ms since epoch. */
  createdAt: number;
}

/** A partition (or an identity's pending-write record) that must be erased before anything reads it. */
export type ReplicaPurgeIntent =
  | { id: string; kind: "partition"; partitionId: string; principal: string; recordedAt: number }
  | { id: string; kind: "pending"; identityKey: string; principal: string; recordedAt: number };

export interface ReplicaDenyInput {
  /** `sign_out` clears the principal; `account_switch` sets `next`. */
  reason: "sign_out" | "account_switch";
  /** Lower-cased principal of the incoming account; required for `account_switch`. */
  next?: string;
}

/** Result of step 1 (deny + intent). Never rejects: sign-out always succeeds in memory. */
export type ReplicaDenyOutcome =
  /** Gate moved and intents recorded in one commit. */
  | { status: "denied"; lifecycleEpoch: number; intents: number }
  /** Browser: deny commit failed; `deleteDatabase` succeeded, so nothing of any account remains. */
  | { status: "deleted" }
  /** Browser: deny and delete failed; logout marker written, delete retried on every load. */
  | { status: "marker"; code: string }
  /** Nothing could be written. Cross-tab denial NOT guaranteed; this tab serves nothing. */
  | { status: "unguarded"; code: string };

export interface ReplicaEraseReport {
  erased: string[];
  failed: Array<{ id: string; code: string }>;
  /** Intents still outstanding after this pass. */
  remaining: number;
}

/**
 * Transaction-level seam. The storage adapter calls these inside its own transactions, which MUST
 * include the gate's control stores. Implementations MUST only await requests on `tx`.
 */
export interface ReplicaGateTx<Tx> {
  /**
   * First call in every guarded transaction (open, read, grant install, page commit, sync
   * completion). Rejects with {@link ReplicaGatedError}; the caller aborts the transaction.
   */
  assert(tx: Tx, access: ReplicaGateAccess): Promise<void>;
  /** Registers a partition in the index, in the transaction that creates it. Idempotent. */
  indexPartition(tx: Tx, entry: ReplicaPartitionIndexEntry): Promise<void>;
  /** Removes the intent `id`, in the same transaction as the erase it records. */
  clearIntent(tx: Tx, id: string): Promise<void>;
}

/**
 * Erase seam implemented by the storage adapter (it owns the data layout) and driven by the gate.
 * Each call runs inside the transaction that also clears the intent and releases quota.
 */
export interface ReplicaPartitionEraser<Tx> {
  /**
   * Removes entries, blobs, grant, config and authority of `partitionId`, leaving only a
   * contentless tombstone. Returns the bytes released (for `ReplicaQuotaLedger.accountErase`).
   */
  erasePartition(tx: Tx, partitionId: string): Promise<{ bytes: number }>;
  /** Removes the identity's pending-write state. */
  eraseIdentityPending(tx: Tx, identityKey: string): Promise<void>;
}

/**
 * Platform lifecycle gate. Exposed as `KVReplicaStorage.lifecycle`; the runtime drives it on
 * sign-in, sign-out, account switch and startup.
 */
export interface ReplicaLifecycleGate {
  readonly kind: "indexeddb" | "file";
  /**
   * Startup recovery, before anything binds: browser retries a pending `deleteDatabase` when the
   * marker is set (clearing the marker only on success), then erases outstanding intents. Never
   * rejects; failures stay visible via `pendingPurge()` and `purgePending` status.
   */
  recover(o: { signal: AbortSignal }): Promise<ReplicaEraseReport>;
  /**
   * Returns the stamp for a newly established session of `principal`. When the gate's principal
   * is null it is set to `principal` without bumping the epoch; when it already equals `principal`
   * the current stamp is returned (tabs of one account share it). Rejects REPLICA_GATED
   * `principal_mismatch` when another account is active (caller runs the switch sequence first)
   * and `purge_pending` while `activationAllowed(principal)` is false.
   */
  captureSessionStamp(principal: string): Promise<ReplicaSessionStamp>;
  /** False while any intent of a previous principal remains, or the marker is set. */
  activationAllowed(principal: string): Promise<boolean>;
  /**
   * Synchronous main-thread delivery check, run before handing any replica-served value to a caller
   * and before every sync request. Browser: `localStorage` marker + this tab's gate view (updated
   * synchronously by `deny`). Node/CLI: this process's gate view.
   */
  deliverable(stamp: ReplicaSessionStamp): boolean;
  /** Step 1: one commit moves the gate (epoch + 1) and records intents for every indexed partition and pending record of the old principal. */
  deny(input: ReplicaDenyInput): Promise<ReplicaDenyOutcome>;
  /** Step 3: erase each outstanding intent in its own transaction (erase + clearIntent + accountErase). */
  erasePending(o: { signal: AbortSignal }): Promise<ReplicaEraseReport>;
  /** Outstanding intents; non-empty means status `purgePending: true`. */
  pendingPurge(): Promise<ReplicaPurgeIntent[]>;
}
