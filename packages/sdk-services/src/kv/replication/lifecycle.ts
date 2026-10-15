/**
 * Lifecycle / epoch gate contract (TC-858 Phase 2, CONTRACT.md §2). Types only.
 *
 * One interface set, implemented per platform. The browser keeps the gate in the origin
 * database's control stores plus the `localStorage` logout marker; node/CLI keep it in a gate file
 * next to the replicas (`<profile>/replica-gate.json`). `Tx` is the platform's transaction: an
 * `IDBTransaction` inside the browser worker; on node/CLI, the SQLite transaction context (under
 * the profile lock for mutations).
 *
 * Construction boundary (browser): `ReplicaGateTx`, `ReplicaPartitionEraser` and
 * `ReplicaQuotaLedger` are constructed INSIDE the worker (`createKvWorkerHost({ gateTx,
 * ledgerFor })`) and never cross postMessage; neither does any `IDBTransaction`.
 * `ReplicaLifecycleGate` is the main-thread facade.
 */
import type { REPLICA_KV_STORES } from "./contractConstants";

/**
 * Bound to one session object for its whole life. Created only by `establishSessionStamp` on a
 * fresh sign-in, persisted next to the SIWE (sdk-core `PersistedSessionData.replicaStamp`, added
 * by S3), and validated, never re-established, by `restoreSessionStamp` on restore. A session
 * without a stamp is "not established" and is refused.
 */
export interface ReplicaSessionStamp {
  /** Random id generated when the gate store is created; changes when it is deleted and recreated. */
  readonly incarnation: string;
  /** Non-negative integer; +1 on every deny; never decreases within an incarnation. */
  readonly lifecycleEpoch: number;
}

/**
 * The durable account gate: one per browser origin, one per node/CLI profile. Holds no plaintext
 * principal: `principalHash` is HMAC-SHA-256(salt, lower-cased principal DID).
 */
export interface ReplicaAccountGate {
  incarnation: string;
  /** Per-incarnation random salt (base64url, ≥ 32 bytes) keying every HMAC in this gate's scope. */
  salt: string;
  /** Active account's principal hash; null after sign-out. */
  principalHash: string | null;
  lifecycleEpoch: number;
  /** ms since epoch of the last committed deny; null if none in this incarnation. */
  deniedAt: number | null;
}

/** What a guarded transaction presents to the gate. Access needs stamp AND principal to match. */
export interface ReplicaGateAccess {
  /** Required: there is no unstamped access when a gate exists. */
  stamp: ReplicaSessionStamp;
  /** Canonical principal of the handle's identity (hashed by the gate, never stored). */
  principal: string;
  /** Refused while a purge intent covers this partition. */
  partitionId?: string;
  /** Pending-store transactions set this: refused while a `pending` intent covers the identity. */
  identityKeyHash?: string;
}

/** Why the gate refused (`REPLICA_GATED` errors carry this as `gate`). */
export type ReplicaGateReason =
  /** No stamp: the session was never established, or a restore had no persisted stamp. */
  | "not_established"
  /** Incarnation or lifecycleEpoch differs from the gate (signed out, switched, or DB recreated). */
  | "stamp_stale"
  /** The gate's principal is null or another account. */
  | "principal_mismatch"
  /** A purge intent covers the partition/identity, or activation awaits the previous principal's erase. */
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

/** Store names a guarded transaction may touch (data stores, plus `device` for owner-device and anchor reads). */
export type ReplicaGuardedStore = (typeof REPLICA_KV_STORES)[
  "meta" | "entries" | "blobs" | "pending" | "device"
];

/** Store set and mode of one guarded transaction. Control stores are always added by `run`. */
export interface ReplicaGateScope {
  stores: readonly ReplicaGuardedStore[];
  mode: "readonly" | "readwrite";
}

/**
 * Every partition ever created in the gate's scope. No plaintext principal, prefix or device:
 * hashes are HMAC-SHA-256 with the gate's per-incarnation salt (node: `identityKeyHash` is the
 * existing unsalted base32 identity directory name, a documented node exposure).
 */
export interface ReplicaPartitionIndexEntry {
  partitionId: string;
  principalHash: string;
  identityKeyHash: string;
  /** ms since epoch. */
  createdAt: number;
}

/** A partition (or an identity's pending-write record) that must be erased before anything reads it. */
export type ReplicaPurgeIntent =
  | { id: string; kind: "partition"; partitionId: string; principalHash: string; recordedAt: number }
  | { id: string; kind: "pending"; identityKeyHash: string; principalHash: string; recordedAt: number };

export interface ReplicaDenyInput {
  /** `sign_out` clears the gate principal; `account_switch` sets it to `next`. */
  reason: "sign_out" | "account_switch";
  /**
   * The caller's own principal. If it doesn't match the gate's principal, the caller is stale: it
   * disables itself in memory and the gate is NOT touched (outcome `stale`).
   */
  principal: string;
  /** Lower-cased principal of the incoming account; required for `account_switch`. */
  next?: string;
}

/**
 * Result of step 1 (deny + intent). Never rejects: sign-out always succeeds in memory. Every
 * outcome has already flipped this tab's/process's in-memory view (so `deliverable` is false)
 * BEFORE `deny`'s first await.
 */
export type ReplicaDenyOutcome =
  /** Gate moved, intents recorded, first-install anchors and the owner device removed, in one commit. */
  | { status: "denied"; lifecycleEpoch: number; intents: number }
  /** The caller's principal didn't match the gate: disabled in memory only; gate untouched. */
  | { status: "stale" }
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
 * The structural guard (worker-side in the browser). Every transaction that reads or writes a data
 * store (`meta`, `entries`, `blobs`, `pending`, and `device`) MUST go through `run`: open, get,
 * list, status, `grant()`, installGrant, every page commit, repair batch, GC pass, sync completion,
 * and every pending-store read/readExisting/update. Only purge/erase transactions are exempt.
 */
export interface ReplicaGateTx<Tx> {
  /**
   * Opens the transaction itself over `scope.stores` PLUS every control store (`gate`,
   * `partitions`, `purgeIntents`, `quota`), asserts `access` as its first step, then runs `fn`.
   * A refusal rejects {@link ReplicaGatedError} and aborts the transaction; `fn` never runs.
   * `fn` MUST only await requests on `tx`.
   *
   * Node/CLI: `readwrite` takes the profile lock across the gate check and the SQLite commit.
   * `readonly` takes no profile lock; it runs in a SQLite read transaction that checks the gate
   * (gate-file stat of mtime/size/inode, re-read on change) and the partition's tombstone row. A
   * read that began before the tombstone commit linearises before the deny.
   */
  run<T>(scope: ReplicaGateScope, access: ReplicaGateAccess, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Registers a partition in the index, inside the `run` transaction that creates it. Idempotent. */
  indexPartition(tx: Tx, entry: ReplicaPartitionIndexEntry): Promise<void>;
  /** Removes the partition's index entry, inside its erase transaction. Idempotent. */
  unindexPartition(tx: Tx, partitionId: string): Promise<void>;
  /** Removes the intent `id`, in the same transaction as the erase it records (node: after it, see CONTRACT.md §2). */
  clearIntent(tx: Tx, id: string): Promise<void>;
}

/**
 * Erase seam implemented by the storage adapter (it owns the data layout), driven by the gate
 * (worker-side in the browser). Each call runs inside an exempt erase transaction together with
 * `unindexPartition`, `ReplicaQuotaLedger.accountErase` and `clearIntent`. Replay is idempotent:
 * erasing a missing or tombstoned partition succeeds.
 */
export interface ReplicaPartitionEraser<Tx> {
  /**
   * Writes the partition's tombstone (so open handles fail RESET_REQUIRED by generation, not by
   * unlink) and removes entries, blobs, grant, config and authority. Returns bytes released.
   */
  erasePartition(tx: Tx, partitionId: string): Promise<{ bytes: number }>;
  /** Removes the identity's pending-write state (node: also its `device.jwk`). */
  eraseIdentityPending(tx: Tx, identityKeyHash: string): Promise<void>;
}

/**
 * Main-thread facade over the platform gate, exposed as `KVReplicaStorage.lifecycle`. With
 * replication on, storage MUST expose it (browser: the web runtime refuses storage without it with
 * RUNTIME_UNSUPPORTED; node: `sqliteReplicaStorage` exposes it by default).
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
   * Fresh sign-in ONLY. Rejects `logout_pending` / `purge_pending` before any gate mutation, and
   * `stamp_stale` when `siweIssuedAt` (ms) is not after `gate.deniedAt`. Then: gate principal null
   * → set to `principal` (no epoch bump; deny already bumped); equal → current stamp (tabs of one
   * account share it); another account → reject `principal_mismatch` (caller runs
   * `deny({ reason: "account_switch", principal: <own>, next })` first, or is stale).
   */
  establishSessionStamp(principal: string, o: { siweIssuedAt: number }): Promise<ReplicaSessionStamp>;
  /**
   * Restore ONLY; never mutates the gate. Returns `persisted` when it equals the gate's stamp and
   * principal. Rejects `not_established` (no persisted stamp), `stamp_stale`, `principal_mismatch`,
   * `logout_pending`, `purge_pending`.
   */
  restoreSessionStamp(principal: string, persisted: ReplicaSessionStamp | undefined): Promise<ReplicaSessionStamp>;
  /** True only when `gate.principalHash` matches `next`, no intent of a previous principal remains, and no marker is set. */
  activationAllowed(next: string): Promise<boolean>;
  /**
   * Synchronous main-thread delivery check, run before handing ANY replica-served value (get
   * values, list keys, replica-derived event fields) to a caller and before every open,
   * installGrant and sync request. Browser: `localStorage` marker + this tab's gate view. Node/CLI:
   * this process's gate view. The stamp is required; `if (stamp && !deliverable(stamp))` is wrong:
   * no stamp means not deliverable.
   */
  deliverable(stamp: ReplicaSessionStamp): boolean;
  /**
   * Step 1. Flips the in-memory view before its first await. If `input.principal` matches the gate:
   * one commit moves the gate (epoch + 1, `deniedAt`), records intents for every indexed partition
   * and pending record of that principal, clears its `first_install` anchors, and deletes the
   * owner device record (rotated on next activation). Otherwise outcome `stale`.
   */
  deny(input: ReplicaDenyInput): Promise<ReplicaDenyOutcome>;
  /** Step 3: erase each outstanding intent in its own exempt transaction. */
  erasePending(o: { signal: AbortSignal }): Promise<ReplicaEraseReport>;
  /** Outstanding intents; non-empty means status `purgePending: true`. */
  pendingPurge(): Promise<ReplicaPurgeIntent[]>;
}

/** Worker replies that carry replica-served data are stamped; a reply without a stamp is dropped. */
export interface ReplicaStampedReply {
  stamp: ReplicaSessionStamp;
}
