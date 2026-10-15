/**
 * Frozen constants of the shared replica contract (TC-858 Phase 2, see CONTRACT.md).
 *
 * Exported from `@tinycloud/sdk-services/kv/replication` only, never from the package root,
 * so web bundles that don't replicate never carry them.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Error codes the contract adds or gives new meaning. Values equal keys. */
export const ReplicaContractCode = {
  /**
   * The lifecycle gate refused the operation: the handle's session stamp or principal no longer
   * matches the gate, a purge intent covers the partition, or the logout marker is set. The error
   * carries `gate: ReplicaGateReason`. Read-through answers from the network; nothing is erased.
   */
  REPLICA_GATED: "REPLICA_GATED",
  /**
   * Reserved for handles whose partition was erased (purge or revocation) after they opened. The
   * gate check runs first, so a handle that is both gated and erased reports REPLICA_GATED.
   */
  RESET_REQUIRED: "RESET_REQUIRED",
  /** A page was refused by quota admission (`maxBytes` or the free-space floor). Nothing committed. */
  STORAGE_BUDGET: "STORAGE_BUDGET",
  /** The platform store refused the write (IndexedDB `QuotaExceededError`, ENOSPC). Nothing committed. */
  STORAGE_FULL: "STORAGE_FULL",
  /** The consent deadline has passed: no grant may be minted, renewed or served until re-consent. */
  CONSENT_EXPIRED: "CONSENT_EXPIRED",
  /** The installed grant's effective expiry (not necessarily its signed `exp`) has passed. */
  GRANT_EXPIRED: "GRANT_EXPIRED",
} as const;
export type ReplicaContractCode = (typeof ReplicaContractCode)[keyof typeof ReplicaContractCode];

/** Default device-grant lifetime from install (24 h). All durations are milliseconds. */
export const DEFAULT_GRANT_TTL_MS = DAY_MS;
/** `grantTtlMs` above this (7 d) is a config error: TypeError at construction. */
export const MAX_GRANT_TTL_MS = 7 * DAY_MS;
/** Consent deadline = consent anchor + this window (7 d). */
export const CONSENT_WINDOW_MS = 7 * DAY_MS;
/** Silent renewal starts when remaining effective lifetime < this fraction of the effective lifetime. */
export const RENEW_BELOW_FRACTION = 0.25;
/** Browser free-space floor in bytes (64 MiB, `navigator.storage.estimate()`); not applied on node/CLI. */
export const DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024;

/** The single per-origin IndexedDB database of the browser `KVReplicaStorage` adapter. */
export const REPLICA_KV_DATABASE = "tinycloud-replica-kv";

/**
 * Object-store names in {@link REPLICA_KV_DATABASE}. Every store uses out-of-line keys (no
 * `keyPath`, no autoIncrement) so the schema upgrade can create control stores without knowing
 * their record shapes. Data stores are owned by the adapter (S1); control stores by the lifecycle
 * gate (S3) and quota ledger (S5).
 */
export const REPLICA_KV_STORES = {
  /** Data: partition meta, key `partitionId`. */
  meta: "meta",
  /** Data: entries, key `[partitionId, key]`. */
  entries: "entries",
  /** Data: content blobs, key `[partitionId, blake3Hex]`. */
  blobs: "blobs",
  /** Data: identity-scoped `PendingWriteState`, key `identityKeyHash`. */
  pending: "pending",
  /** Data: owner-minted device per origin, key `"device"`. */
  device: "device",
  /** Control: the account gate, singleton key `"account"`, value `ReplicaAccountGate`. */
  gate: "gate",
  /** Control: partition index, key `partitionId`, value `ReplicaPartitionIndexEntry`. */
  partitions: "partitions",
  /** Control: purge intents, key `ReplicaPurgeIntent.id`, value `ReplicaPurgeIntent`. */
  purgeIntents: "purgeIntents",
  /** Control: quota ledger, keys owned by the ledger (S5). */
  quota: "quota",
} as const;

/** Synchronous, cross-tab `localStorage` marker set when the deny transaction and fallback delete both failed. */
export const REPLICA_LOGOUT_MARKER = "tinycloud-replica:logout-pending";

/** Origin-wide deny floor outside the deletable replica database; JSON `{ epoch, deniedAt }`. */
export const REPLICA_DENY_TOMBSTONE = "tinycloud-replica:deny-tombstone";

/** BroadcastChannel name used for lifecycle nudges and peer-commit notifications. */
export const REPLICA_KV_CHANNEL = "tinycloud-replica-kv";

/** Web Lock name prefix for pending-write read-modify-write; suffix is the identity key hash. */
export const REPLICA_PENDING_LOCK_PREFIX = "tinycloud-replica-kv:pending:";

/** Node/CLI gate file name. CLI places it at `<profile>/replica-gate.json`. */
export const REPLICA_GATE_FILE = "replica-gate.json";
