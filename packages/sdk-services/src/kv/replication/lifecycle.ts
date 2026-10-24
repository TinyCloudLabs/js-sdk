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
  /** ms since epoch of the last committed deny (browser: preserved across database recreation). */
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
  | "gate_unavailable"
  /** Browser: replication is configured but no wallet provider can prove the connected account. */
  | "wallet_provider_required";

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
   * file cannot commit atomically with the device file, so an ordinary denial deletes it
   * through the identity's pending-intent erase before intent clear. Deferred node sign-out
   * holds that intent and the device file until validated resume (CONTRACT.md §2).
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

/** A deferred sign-out denial: a committed `denied` always carries its resume token. */
export type ProfileReplicaDeferredDenyOutcome =
  | { status: "denied"; lifecycleEpoch: number; intents: number; resumeToken: ProfileReplicaDeferredToken }
  | Exclude<ReplicaDenyOutcome, { status: "denied" }>;

export interface ReplicaEraseReport {
  erased: string[];
  failed: Array<{ id: string; code: string }>;
  /** Intents still outstanding after this pass. */
  remaining: number;
  /**
   * Node/CLI: a durable deferred denial held this pass, so nothing was erased and
   * `remaining` (possibly 0) is not completion; check `deferredErase()`.
   */
  deferred?: true;
  /** Browser startup discovered elapsed consent and durably crypto-shredded the account/gate keys. */
  consentExpired?: boolean;
}

/**
 * The structural guard (browser: one instance per transaction-owning context). Every
 * session-bound transaction reading or writing `meta`, `entries`, `blobs`, `pending` or
 * `device` MUST go through `run`: open, get/list, status, `grant()`, installGrant,
 * page/repair/GC/sync completion and pending reads/updates. Narrow exceptions:
 * purge/erase, pre-transaction key/control `snapshot()` and ungated bounded read-only
 * `inspectStatus` (§1), which rechecks the gate key and reads only opaque numeric controls,
 * never acquiring the account key, decrypting payloads or returning values/list keys.
 */
export interface ReplicaGateTx<
  Tx,
  Access extends ReplicaGateAccess = ReplicaGateAccess,
  Snapshot extends ReplicaGateSnapshot = ReplicaGateSnapshot,
> {
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
   * Snapshot outside any guarded data transaction. Browser callers obtain the
   * nonextractable gate-HMAC key and key ids, derive private hashes asynchronously,
   * take the opaque Web Lock if needed, then `run` rechecks key ids/stamp before data.
   * This control/key read never acquires the account key for ungated inspection.
   * Node callers derive their salted principal hash before guarded work.
   */
  snapshot(): Promise<Snapshot | null>;
  /** Registers a partition in the index, inside the `run` transaction that creates it. Idempotent. */
  indexPartition(tx: Tx, entry: ReplicaPartitionIndexEntry): Promise<void>;
  /** Removes the partition's index entry, inside its erase transaction. Idempotent. */
  unindexPartition(tx: Tx, partitionId: string): Promise<void>;
  /** Removes the intent `id`, in the same transaction as the erase it records (node: after it, see CONTRACT.md §2). */
  clearIntent(tx: Tx, id: string): Promise<void>;
}

/** Browser guard: typed private snapshot and required prehashed/key-bound access. */
export type ReplicaBrowserGateTx<Tx> = ReplicaGateTx<Tx, ReplicaBrowserGateAccess, ReplicaBrowserGateSnapshot>;

/**
 * Erase seam implemented by the storage adapter, driven by the gate (worker-side in the browser).
 * Browser erase and ledger accounting share an exempt IDB transaction with index/intent removal.
 * Node partition erase uses SQLite tombstone/row deletion before unlink and intent clear; node
 * pending identity erase runs under the profile lock over `pending.json` and `device.jwk`, not a
 * SQLite transaction. All replay is idempotent.
 */
export interface ReplicaPartitionEraser<Tx> {
  /**
   * Browser: writes a keyless `purged: true` meta tombstone with only opaque pid/numeric
   * controls (so open handles fail RESET_REQUIRED by generation), then removes entries,
   * blobs, grant, config and authority. `bytes` is the old application-encoded rows
   * minus the tombstone; its measured size stays charged until replacement/deletion,
   * and replay returns zero without releasing it twice. Node: a SQLite tombstone
   * fences open handles; its erasure has no browser quota-ledger semantics.
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
   * Node/CLI recovery leaves durably deferred revoke intents and physical files untouched,
   * reporting them as remaining until `ProfileReplicaPurge.resumeDeferredErase`.
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
  /**
   * Browser only. Under the gate lock, erases pending intents and deletes the whole origin
   * database. Deletes only when nothing live is at stake: the gate is denied (null principal),
   * the gate is behind the persisted deny tombstone, or the logout marker is set with a tombstone.
   * A live or other-account gate is `refused` and left untouched. On a failed delete it sets the
   * logout marker (when a tombstone exists) so `recover` finishes the erase on the next load.
   * Never clears the deny tombstone.
   */
  eraseLocalCopy?(o: { signal: AbortSignal }): Promise<ReplicaLocalEraseOutcome>;
}

/** Result of {@link ReplicaLifecycleGate.eraseLocalCopy}. */
export type ReplicaLocalEraseOutcome =
  /** The database is gone and the logout marker (if any) is cleared. */
  | { status: "erased" }
  /** Delete blocked or storage error; a retry can succeed. `marker` is true when the next-load marker is set. */
  | { status: "failed"; code: string; marker: boolean }
  /** The gate does not authorize destruction; nothing was deleted. A retry cannot succeed until the gate is denied. */
  | { status: "refused"; code: string };

/** What triggered a local-copy erase. */
export type ReplicaPurgeTrigger = "sign_out" | "account_switch" | "purge_local_copy";

/** Result of `replication.purgeLocalCopy()`. `retryNow` means a short bounded retry is meaningful. */
export type ReplicaPurgeLocalCopyResult = { ok: true } | { ok: false; retryNow: boolean };

/**
 * Emitted (`on("replica.purge.failed", …)`) when the local copy could not be erased after the
 * bounded retries. The SDK finishes the erase on the next load through the logout marker.
 */
export interface ReplicaPurgeFailedEvent {
  type: "replica.purge.failed";
  trigger: ReplicaPurgeTrigger;
  /** Typed reason: `logout_pending` (marker set, erase retried on next load) or `gate_unavailable`. */
  reason: ReplicaGateReason;
  /** Storage error code of the last attempt. */
  code: string;
  /** True when a short bounded retry is meaningful (delete blocked or storage error). */
  retryNow: boolean;
}

/** Rejection of `signOut()` when the deny itself was `unguarded` and the erase did not complete. */
export interface ReplicaPurgeError extends Error {
  code: "REPLICA_PURGE_FAILED";
  reason: ReplicaGateReason;
  retryNow: boolean;
}

/** Node/CLI profile-local fencing token, not a secret capability; the profile lock remains authoritative. */
export interface ProfileReplicaDeferredToken {
  deniedEpoch: number;
  principalHash: string;
}

/** Profile-relative, JSON-safe identity of a path listed before destructive logout. */
export interface ProfileReplicaUnknownEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  dev: string;
  ino: string;
}

/** Profile-relative directory identity; dev/ino are decimal strings for durable JSON. */
export interface ProfileReplicaRootIdentity {
  path: string;
  dev: string;
  ino: string;
}
/** Exact nonsecret path identity displayed with an inventory confirmation token. */
export interface ProfileReplicaApprovalEntry extends ProfileReplicaRootIdentity {
  kind: ProfileReplicaUnknownEntry["kind"] | "missing";
}

/** Read-only profile-locked inventory, including legacy mirrors and flag-owned roots. */
export interface ProfileReplicaPreflight {
  knownLegacyReplicas: number;
  unknownLegacyPaths: string[];
  unknownPaths: string[];
  unknownEntries: ProfileReplicaUnknownEntry[];
  knownRoots: ProfileReplicaRootIdentity[];
  knownEntries: ProfileReplicaUnknownEntry[];
  missingDatabases: string[];
}

/**
 * CLI-only durable crash fence. `principalDigest` is a domain-separated
 * SHA-256 owner binding, not a secret or a substitute for the profile lock;
 * v2/v3 never fabricate a scoped gate principal hash. A v1 `lifecycleEpoch`
 * is the pre-denial epoch; `deniedEpoch` is the epoch the v1 denial actually
 * committed, bound once after that denial and compared for equality from then
 * on (CONTRACT.md §2). Remote-pending and remote-abandoned are mutually
 * exclusive durable states.
 */
export type ProfileReplicaLogoutPending = (
  | { v: 1; incarnation: string; lifecycleEpoch: number; principalHash: string; deniedEpoch?: number }
  | { v: 2; scope: "orphan_profile"; nonce: string }
  | { v: 3; scope: "inactive_gate"; incarnation: string; lifecycleEpoch: number }
) & ProfileReplicaRemoteLogoutState & {
  principalDigest: string;
  /** Random durable 16-byte challenge salt as 32 lowercase hex characters. */
  approvalSalt: string;
  discardLocalChanges?: true;
  approvedUnknown: ProfileReplicaUnknownEntry[];
  knownRoots: ProfileReplicaRootIdentity[];
  knownEntries: ProfileReplicaUnknownEntry[];
  missingDatabases: string[];
};

/** A logout marker is remote-pending, remote-abandoned or neither; never both. */
export type ProfileReplicaRemoteLogoutState =
  | { remotePending: true; remoteAbandoned?: never }
  | { remoteAbandoned: true; remotePending?: never }
  | { remotePending?: never; remoteAbandoned?: never };

/**
 * Node/CLI-only lifecycle facade for a profile's replica root. The node-sdk exports
 * `createProfileReplicaPurge({ profileDir, guard })`; `guard` is the caller's
 * mandatory profile lock and MUST be reentrant within one async call chain: the
 * CLI calls the facade while already holding its (reentrant) profile lock. This
 * does not widen the browser `ReplicaLifecycleGate`.
 *
 * While a durable deferred denial is active, `recover` and `erasePending`
 * leave intents and physical files untouched; `pendingPurge` lists the intents.
 * A complete enumeration may have zero intents, so `remaining: 0` does not
 * prove completion: `deferredErase()` is the authoritative marker check, and
 * `LocalReplicaStatus.purgePending` / `ReplicaInspectedStatus.purgePending`
 * are true while the deferred marker or any intent remains. All guarded reads
 * and new establishment remain refused. Deferred intents leave that state only
 * through a validated resume (CONTRACT.md §2); there is no account-switch or
 * consent-expiry override. The facade never denies or erases a gate,
 * partition, pending state or device record whose active principal is not
 * the caller's ("Logout by another account", CONTRACT.md §2).
 */
export interface ProfileReplicaPurge extends Pick<ReplicaLifecycleGate, "recover" | "erasePending" | "pendingPurge"> {
  /**
   * `deferErase: true` is valid only for `reason: "sign_out"`; other reasons throw
   * TypeError before any mutation. A successful deferred `denied` outcome MUST carry
   * `resumeToken`; stale or unguarded outcomes do not authorize a retryable revoke.
   * Step 1 atomically denies, records every opaque partition/pending intent and
   * pending generation, and persists the deferred marker. Physical files remain
   * until `resumeDeferredErase`, even across process restart.
   */
  deny(input: ReplicaDenyInput & { reason: "sign_out" }, options: { deferErase: true }): Promise<ProfileReplicaDeferredDenyOutcome>;
  deny(input: ReplicaDenyInput, options?: { deferErase?: false }): Promise<ReplicaDenyOutcome>;
  /** Returns the persisted active token across restart, even with zero intents; null only after the marker clears. */
  deferredErase(): Promise<ProfileReplicaDeferredToken | null>;
  /**
   * Under the profile lock, require the exact denied epoch and principal hash and a
   * null gate principal; otherwise throw `REPLICA_GATED`/`stamp_stale` without erasure.
   * Clear the deferred marker durably before idempotent erase. A crash after clearing
   * is completed by ordinary recovery. Repeating the same token is safe only while
   * the same denied epoch/hash persists; a successor establishment fences it.
   */
  resumeDeferredErase(token: ProfileReplicaDeferredToken, options: { signal: AbortSignal }): Promise<ReplicaEraseReport>;
  /**
   * Read-only profile-locked inventory BEFORE marker, denial or remote call.
   * Report exact profile-relative unknown paths, kinds and dev/ino plus all
   * known roots/entries. Unknown/indeterminate data refuses unless explicit
   * discard consent was supplied; the CLI displays the inventory before acting.
   * A prior inventory is not a wildcard authorization for later new paths.
   */
  preflightLogout(input: { principal: string; discardLocalChanges?: boolean }): Promise<ProfileReplicaPreflight>;
  /**
   * Re-inspect and compare the complete approved inventory under the profile
   * lock, then atomically fsync a scoped v1, orphan v2 or inactive v3 marker.
   * `approval` is required: the CLI passes its just-displayed preflight even
   * when it contains no unknown paths. With `remotePending`, the marker fences
   * replica reads but forbids credential cleanup or erasure until
   * `completeRemoteLogout` after all exact-CID revokes. Only approved
   * path/type/dev/ino identities and the explicit discard bit survive; changed
   * paths refuse pre-action. V1 active remote logout additionally requires a
   * committed deferred denial/token before online revoke; v2 orphan and v3
   * inactive markers instead use their version-specific gate-absence/epoch
   * fences.
   *
   * An existing marker is never rewritten here: the same owner, fence,
   * `remotePending` state and approved inventory return it unchanged; anything
   * else refuses without mutation. When the gate's active principal is the
   * caller's, it always yields a v1 marker, even with no replica roots or
   * intents; another account's active gate yields null and is never denied.
   * Null otherwise means there is no active principal and no replica-owned
   * work, not completed logout.
   *
   * A missing flag pending index, unrecognized child, nonempty pending state
   * or corrupt gate requires explicit discard. The CLI still fsyncs
   * authSignedOut then unlinks and fsyncs both credentials. CLI-bound reads
   * and ordinary network restore refuse any marker; an explicit remote-revoke
   * retry may use the retained key/session while `remotePending` without
   * delivering replica data.
   */
  prepareLogoutPending(input: {
    principal: string;
    approval: ProfileReplicaPreflight;
    discardLocalChanges?: boolean;
    remotePending?: true;
  }): Promise<ProfileReplicaLogoutPending | null>;
  /**
   * After every authoritative exact-CID revoke succeeds, revalidate the
   * marker's principal and version-specific fence under the profile lock:
   * v1 `deniedEpoch`/hash, v2 no replacement gate, or v3 exact inactive
   * epoch/null principal. Then durably remove `remotePending`. A marker that is
   * not remote-pending (remote-abandoned or already cleanup-ready) refuses
   * without mutation. A failed/partial remote sequence never calls this.
   */
  completeRemoteLogout(input: { principal: string }): Promise<ProfileReplicaLogoutPending>;
  /**
   * Under the profile lock, report whether this principal's marker is still
   * remote-pending and its v1 deferred gate, v2 orphan or v3 inactive gate
   * fence still matches. False only when the marker is absent/completed;
   * a mismatched principal or stale gate refuses. This permits an explicit
   * network-only revoke retry, never replica delivery.
   */
  remotePendingLogout(input: { principal: string }): Promise<boolean>;
  /**
   * First explicit PLAIN logout attempt after unfinished remote revoke:
   * compare the original durable approved inventory with the current
   * path/type/dev/ino set under the profile lock. Any change refuses with
   * `REPLICA_GATED`/`gate_unavailable`, prints every token-bound
   * `ProfileReplicaApprovalEntry`, exposes the same complete set as
   * `error.inventoryApprovalEntries` plus a nonsecret 32-hex-character
   * `error.inventoryApprovalToken`, and mutates nothing even when `approval`
   * contains the new paths or `discardLocalChanges` is true. With the
   * original inventory intact, validate the fresh approval and the marker's
   * version-specific owner/gate fence (a v1 marker is classified by its gate
   * and checked exactly one way, CONTRACT.md §2), then atomically replace
   * `remotePending` with `remoteAbandoned: true`.
   * This is not an online-success receipt and makes no further node call.
   */
  abandonRemoteLogout(input: {
    principal: string;
    approval: ProfileReplicaPreflight;
    discardLocalChanges?: boolean;
  }): Promise<ProfileReplicaLogoutPending>;
  /**
   * Only a separate explicit CLI command with
   * `--discard-local-changes --approve-inventory <token>` may approve a
   * changed remote-pending inventory. Under the profile lock, require the
   * same owner and version-specific gate fence, original-to-current inventory
   * mismatch, exact fresh preflight and matching displayed 32-hex-character
   * token. Commit the newly approved identities with `remoteAbandoned: true`,
   * never a remote receipt. Missing, stale or reused tokens fail without
   * mutation; there is no same-command fallback from `abandonRemoteLogout`.
   */
  approveChangedPlainLogout(input: {
    principal: string;
    approval: ProfileReplicaPreflight;
    discardLocalChanges: true;
    inventoryApprovalToken: string;
  }): Promise<ProfileReplicaLogoutPending>;
  /**
   * After a completed remote sequence, an inventory mismatch leaves the
   * marker and signed-out state in place. A fresh explicit listing/ack under
   * the profile lock replaces only the approved inventory; remote revokes
   * are not repeated, and a still-pending remote sequence cannot reapprove.
   */
  reapproveLogoutPending(input: {
    principal: string;
    approval: ProfileReplicaPreflight;
  }): Promise<ProfileReplicaLogoutPending>;
  /**
   * CLI startup/logout recovery under the same profile lock. A `remotePending`
   * marker returns failure with no credential or file deletion. For a
   * cleanup-ready active-v1 marker, validate the gate and durably commit
   * generation-fenced denial with complete partition/pending intents
   * BEFORE calling `clearCredentials`; denial failure leaves the marker,
   * both credentials and replica files intact and reports nonzero failure.
   * An already-deferred v1 validates its exact denial; v3 validates its
   * inactive epoch and v2 its orphan/no-replacement-gate fence without
   * inventing scoped intents. Only then does `clearCredentials` atomically
   * fsync CLI authSignedOut before unlinking and fsyncing both session.json
   * and key.json. Recheck durable approved identities before each unlink;
   * mismatch stops with marker, remaining files and nonzero failure.
   * Post-success credentials remain shredded. The callback erases only its
   * approved inventory under the profile lock (never recursive legacy
   * deletion). In-repo CLI code owns the signed-out postcondition; the
   * facade verifies credential absence before erasure. A missing marker
   * with corrupt/unreadable gate reports failure and nonzero remaining,
   * without invoking callbacks or fabricating successful completion.
   */
  recoverLogoutPending(options: {
    signal: AbortSignal;
    clearCredentials: () => Promise<void>;
    eraseLegacyReplicas: (options: {
      discardLocalChanges: boolean;
      approvedUnknown: readonly ProfileReplicaUnknownEntry[];
      knownRoots: readonly ProfileReplicaRootIdentity[];
      knownEntries: readonly ProfileReplicaUnknownEntry[];
      missingDatabases: readonly string[];
    }) => Promise<void>;
  }): Promise<ReplicaEraseReport>;
}

/** Worker replies that carry replica-served data are stamped; a reply without a stamp is dropped. */
export interface ReplicaStampedReply {
  stamp: ReplicaSessionStamp;
}
