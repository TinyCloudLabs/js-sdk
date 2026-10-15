/**
 * Lifecycle / epoch gate contract (TC-858 Phase 2, CONTRACT.md §2). Types only.
 *
 * One interface set, implemented per platform. The browser keeps the gate in the origin
 * database's control stores plus the `localStorage` logout marker and deny tombstone; node/CLI
 * keep it in a gate file next to the replicas (`<profile>/replica-gate.json`). `Tx` is the
 * guarded operation's platform context: `IDBTransaction` in the browser; SQLite transaction
 * context for node replica pages/reads, or file context for node identity-scoped pending JSON
 * under the mandatory profile lock.
 *
 * Construction boundary (browser): a `ReplicaGateTx` is constructed alongside whichever context
 * owns the transaction — the worker for replica open/read/page/repair/GC/erase (with
 * `ReplicaPartitionEraser` and `ReplicaQuotaLedger`, via `createKvWorkerHost({ gateTx, ledgerFor
 * })`), and the main thread for the pending store (its `update(mutate)` closure runs there). Both
 * instances open the same origin database. No `IDBTransaction` and no closure ever crosses
 * postMessage. `ReplicaLifecycleGate` is the main-thread facade.
 */
import type { REPLICA_KV_STORES } from "./contractConstants";
import type { ReplicaConsentAnchor } from "./grantPolicyTypes";

/** Injected millisecond clock shared by controller, browser lifecycle and worker; defaults to Date.now. */
export type ReplicaClock = () => number;

/**
 * Bound to one session object for its whole life. Created only by `establishSessionStamp` on a
 * fresh authenticated session with a verified finite consent anchor, persisted in sdk-core
 * `PersistedSessionData.replicaStamp`, and validated, never re-established, on restore. A session
 * without a stamp is "not established" and is refused.
 */
export interface ReplicaSessionStamp {
  /** Random id generated when the gate store is created; changes when it is deleted and recreated. */
  readonly incarnation: string;
  /** Non-negative integer; +1 on every deny; never decreases within an incarnation. */
  readonly lifecycleEpoch: number;
}

/**
 * One durable account gate per origin or node/CLI profile. No plaintext principal is stored:
 * browser `principalHash` uses a private nonextractable gate-HMAC key with domain separation;
 * node derives its salted hash before entering a guarded transaction.
 */
export interface ReplicaAccountGate {
  incarnation: string;
  /** Node: random base64url salt (≥ 32 bytes). Browser may carry one but MUST use its private
   * gate-HMAC key, never this public value, for replica-owned identifiers. */
  salt: string;
  /** Active account's principal hash; null after sign-out. */
  principalHash: string | null;
  lifecycleEpoch: number;
  /** ms since epoch of the last committed deny; null if none in this incarnation. */
  deniedAt: number | null;
  /** Browser: finite ms, fixed from verified fresh consent at establish; mandatory while active. */
  consentDeadline?: number | null;
}

/**
 * Node/CLI lowercase-hex HMAC-SHA-256, key = base64url-decoded salt, material = UTF-8.
 * Browser identifiers MUST NOT use this public-salt helper.
 */
export type SaltedHash = (salt: string, material: string) => Promise<string>;

/**
 * Browser lowercase-hex HMAC-SHA-256 using a nonextractable gate key over UTF-8
 * `${domain}\0${material}`. Derive outside an IDB transaction; domains separate principals,
 * identities, partitions and owner lookups. The private key is deleted on deny/expiry.
 */
export type ReplicaPrivateGateHash = (
  key: CryptoKey,
  domain: "principal" | "identity" | "partition" | "lookup",
  material: string,
) => Promise<string>;

/** Current gate incarnation, node salt and epoch; browser specialization also carries private key and ids. */
export interface ReplicaGateSnapshot {
  incarnation: string;
  /** Node hashes with this value; browser never uses it for account identifiers. */
  salt: string;
  lifecycleEpoch: number;
}

/** Browser snapshot binds the nonextractable key and both key records to one gate generation. */
export interface ReplicaBrowserGateSnapshot extends ReplicaGateSnapshot {
  keyId: string;
  accountKeyId: string;
  gateHmac: CryptoKey;
}

/**
 * Precomputed, stored opaque ids presented to one guarded operation. Derive principalHash
 * before `run` (browser: private gate-HMAC from snapshot; node: salted hash before the
 * profile-locked check). No raw principal or async WebCrypto computation inside the browser
 * IDB transaction. `run` rechecks the snapshot's incarnation, stamp and stored principal hash.
 */
export interface ReplicaGateAccess {
  /** Required: no unstamped access when a gate exists. */
  stamp: ReplicaSessionStamp;
  incarnation: string;
  principalHash: string;
  /** Stored partition id; refused while a purge intent covers it. */
  partitionId?: string;
  /** Stored identity id; refused while a pending intent covers it. */
  identityKeyHash?: string;
}

/** Browser guard requires both key ids; missing ids cannot silently compile or enter `run`. */
export interface ReplicaBrowserGateAccess extends ReplicaGateAccess {
  keyId: string;
  accountKeyId: string;
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

/** Main-thread synchronous preflight: the controller observes expiry even without a worker read. */
export type ReplicaDeliveryDecision =
  | { status: "allow" }
  | { status: "consent_expired"; code: "CONSENT_EXPIRED" }
  | { status: "gated"; gate: ReplicaGateReason };

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
 * Every partition ever created in the gate's scope. Browser opaque IDs are private
 * gate-HMAC outputs, never plaintext principal, prefix or device. `lookupId` is independent
 * of sealed owner device DID and indexes one or more stored partition ids for ungated
 * inspection/purge while the gate key exists; after deny, erasure uses recorded intents.
 * The key in IDB is NOT protected from a raw browser-profile reader with a valid session.
 * Node identity dirs retain their known unsalted base32 exposure (CONTRACT.md §1).
 */
export interface ReplicaPartitionIndexEntry {
  partitionId: string;
  principalHash: string;
  identityKeyHash: string;
  /** `gateHash(key, "lookup", identityKey + "\n" + prefix)`; nonunique across devices. */
  lookupId: string;
  /** True only when the adapter minted/used its stored owner device (`spec.device` absent). */
  ownerDevice: boolean;
  /** ms since epoch. */
  createdAt: number;
}

/** A partition (or an identity's pending-write record) that must be erased before anything reads it. */
export type ReplicaPurgeIntent =
  | { id: string; kind: "partition"; partitionId: string; principalHash: string; recordedAt: number }
  | { id: string; kind: "pending"; identityKeyHash: string; principalHash: string; recordedAt: number };

export interface ReplicaDenyInput {
  /** Every scoped denial clears the current gate principal, including account switch. */
  reason: "sign_out" | "account_switch" | "consent_expired";
  /**
   * The caller's own principal. If it doesn't match the gate, this stale caller disables only
   * itself in memory, leaving the gate and successor account untouched.
   */
  principal: string;
  /** Intended successor on switch, never stored under the old account/gate HMAC key. */
  next?: string;
}

/**
 * Result of step 1 (deny + intent). Never rejects: sign-out always succeeds in memory. Every
 * outcome has already flipped this tab's/process's in-memory view (so `deliverable` is false)
 * BEFORE `deny`'s first await.
 */
export type ReplicaDenyOutcome =
  /**
   * Gate moved, intents recorded, first-install anchors cleared and pending generations advanced
   * in one commit. Browser: owner device deleted in that same IDB transaction. Node: the gate
   * file cannot commit atomically with the device file, so the device is durably deleted by its
   * identity's pending-intent erase before that intent clears (idempotent replay).
   */
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
  /** Browser startup discovered elapsed consent and durably crypto-shredded the account/gate keys. */
  consentExpired?: boolean;
}

/**
 * The structural guard (browser: one instance per transaction-owning context). Every transaction that reads or writes a data
 * store (`meta`, `entries`, `blobs`, `pending`, and `device`) MUST go through `run`: open, get,
 * list, status, `grant()`, installGrant, every page commit, repair batch, GC pass, sync completion,
 * and every pending-store read/readExisting/update. Only purge/erase transactions are exempt.
 */
export interface ReplicaGateTx<Tx, Access extends ReplicaGateAccess = ReplicaGateAccess> {
  /**
   * Opens the guarded operation. Browser: spans `scope.stores` plus all control stores
   * (`gate`, `partitions`, `purgeIntents`, `quota`, `device`). The FIRST IDB request reads
   * the gate; following control requests verify both stored nonextractable key records
   * and intents **before any data request**. Compare snapshot incarnation/keyIds, stamp,
   * principalHash and consent deadline; mismatch aborts before `fn` or writes. No WebCrypto
   * await occurs inside the transaction. On active browser expiry, abort/read completion
   * precedes an awaited main-thread deny/key-shred RPC; failed denial fails closed.
   * `fn` awaits IDB requests only; readwrite uses strict durability and `run` resolves
   * on IDB `oncomplete`.
   *
   * Node SQLite mutations hold the mandatory profile lock across rechecked gate and commit;
   * reads check the gate and partition tombstone inside a SQLite read transaction. Node
   * identity-scoped `pending.json` is not SQLite: reads/writes hold the profile lock across
   * gate, intent, generation and file access (CONTRACT.md §2). Refusal rejects with
   * {@link ReplicaGatedError}; an active browser deadline reports CONSENT_EXPIRED first.
   */
  run<T>(scope: ReplicaGateScope, access: Access, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Snapshot outside any data transaction. Browser callers asynchronously derive private
   * gate-HMAC ids, take the opaque Web Lock if needed, then `run` rechecks key ids and stamp
   * before data access. Node callers derive their salted principal hash before guarded work.
   */
  snapshot(): Promise<ReplicaGateSnapshot | null>;
  /** Registers a partition in the index, inside the `run` transaction that creates it. Idempotent. */
  indexPartition(tx: Tx, entry: ReplicaPartitionIndexEntry): Promise<void>;
  /** Removes the partition's index entry, inside its erase transaction. Idempotent. */
  unindexPartition(tx: Tx, partitionId: string): Promise<void>;
  /** Removes the intent `id`, in the same transaction as the erase it records (node: after it, see CONTRACT.md §2). */
  clearIntent(tx: Tx, id: string): Promise<void>;
}

/**
 * Erase seam implemented by the storage adapter, driven by the gate (worker-side in the browser).
 * Browser erase and ledger accounting share an exempt IDB transaction with index/intent removal.
 * Node partition erase uses SQLite tombstone/row deletion before unlink and intent clear; node
 * pending identity erase runs under the profile lock over `pending.json` and `device.jwk`, not a
 * SQLite transaction. All replay is idempotent.
 */
export interface ReplicaPartitionEraser<Tx> {
  /**
   * Writes the partition's tombstone (so open handles fail RESET_REQUIRED by generation, not by
   * unlink) and removes entries, blobs, grant, config and authority. Returns bytes released.
   */
  erasePartition(tx: Tx, partitionId: string): Promise<{ bytes: number }>;
  /** Removes identity pending state (node: also `device.jwk`) durably before intent clear. */
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
   * Startup recovery before anything binds: browser checks the durable consent deadline and,
   * if expired, denies and crypto-shreds keys before any replica access; it also retries a
   * pending `deleteDatabase` marker and erases intents. Failures remain gated and visible via
   * `pendingPurge()` / `purgePending`; a browser closed at expiry catches it on its next load.
   */
  recover(o: { signal: AbortSignal }): Promise<ReplicaEraseReport>;
  /**
   * Fresh interactive sign-in ONLY. `consentAnchor` comes from independently validated
   * signed owner SIWE with finite `expirationTime`, verified `issuedAt` and an exact-full-
   * space uncaveated KV get+sync witness, or (for a compact-only session) the signed
   * `iat`/`nbf` of the oldest independently verified owner-authorizing proof. A child
   * leaf freshly minted under an old owner grant does not refresh consent; leaf
   * signature/CID/audience alone do not prove it. An invalid/expirationless SIWE
   * session does NOT fall through to a compact leaf or `first_install`. The anchor
   * must be finite ms, clamped to now at capture and strictly newer than the last
   * deny (browser: also the origin tombstone). Missing proof or non-finite anchors
   * cannot establish (`not_established`); network sign-in/restore remain unaffected.
   * Older anchors reject `stamp_stale`. Rejects
   * `logout_pending` / `purge_pending` before mutation. Null principal → set it; matching
   * principal → current stamp; another account → `principal_mismatch`.
   */
  establishSessionStamp(principal: string, o: { consentAnchor: ReplicaConsentAnchor }): Promise<ReplicaSessionStamp>;
  /**
   * Restore ONLY; never mutates the gate. Returns `persisted` when it equals the gate's stamp and
   * principal. Rejects `not_established` (no persisted stamp), `stamp_stale`, `principal_mismatch`,
   * `logout_pending`, `purge_pending`.
   */
  restoreSessionStamp(principal: string, persisted: ReplicaSessionStamp | undefined): Promise<ReplicaSessionStamp>;
  /** True only for a matching non-null gate principal, with no old intent or marker. A null principal first establishes a fresh session. */
  activationAllowed(next: string): Promise<boolean>;
  /**
   * Synchronous, reason-bearing preflight before open, installGrant, get/list, sync or
   * replica-derived event delivery. An elapsed browser deadline returns `consent_expired`
   * before grant-expiry checks; the controller starts scoped denial and emits one grant
   * deadline event per **opened** handle with a known opaque replicaId. Pre-open denial has
   * no fabricated replica id and uses a lifecycle event/recovery report instead. A timer
   * that already denied returns `gated` (`stamp_stale`). This does not mutate the gate.
   */
  checkDelivery(stamp: ReplicaSessionStamp): ReplicaDeliveryDecision;
  /**
   * Finite, immutable deadline from the persisted gate for this matching active stamp,
   * synchronously available to the main-thread scheduler even when a restored compact
   * session has no consent anchor. Null if stale, unavailable or not established; never
   * derive a new deadline from `first_install` or the current session's leaf token.
   * Browser timers call `checkDelivery` again before notifying/denying; gate checks on
   * startup/open/read are mandatory independently of whether a timer ran. Node may
   * return null when its gate has no persisted consent deadline.
   */
  consentDeadline(stamp: ReplicaSessionStamp): number | null;
  /**
   * Browser-only post-commit consent expiry observer. Fires only after deny/delete
   * destroys the origin account keys; a subscriber failure cannot undo denial.
   * Controllers register after binding so events use their opened opaque replica IDs.
   */
  subscribeConsentExpired?(listener: (stamp: ReplicaSessionStamp) => void): () => void;
  /**
   * Synchronous main-thread delivery check before replica-served values/list keys/event fields,
   * and before open, installGrant and sync. Browser checks marker, origin deny tombstone,
   * durable consent deadline against the same injected clock, and this tab's gate view; node
   * checks its process view. No stamp means not deliverable.
   */
  deliverable(stamp: ReplicaSessionStamp): boolean;
  /**
   * Step 1. Flips the in-memory view before the first await. If the caller principal matches,
   * one commit bumps epoch and deniedAt, records intents, advances pending generations and
   * clears first-install anchors. Browser also deletes account AES-GCM and gate-HMAC keys, plus
   * owner device, in that deny transaction BEFORE background erase; `consent_expired` uses this
   * same path. Node deletes the device through the identity intent (CONTRACT.md §2). A stale
   * principal disables only its own process/tab; the gate is untouched.
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
