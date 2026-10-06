/**
 * Typed replica errors. Every failure a caller can act on has its own code;
 * hosts (CLI, worker) map codes to their own exit codes or UI states.
 */
export const ReplicaErrorCode = {
  /** Another process holds the sync lease. */
  BUSY: "REPLICA_BUSY",
  /** No replica with this name exists. */
  NOT_FOUND: "REPLICA_NOT_FOUND",
  /** The replica exists but its stored configuration differs from the request. */
  CONFIG_MISMATCH: "REPLICA_CONFIG_MISMATCH",
  /** The runtime has no supported durable store (e.g. Node < 22.13). */
  RUNTIME_UNSUPPORTED: "RUNTIME_UNSUPPORTED",
  /** A required open() argument is missing or malformed (e.g. `principal`). */
  INVALID_ARGUMENT: "REPLICA_INVALID_ARGUMENT",
  /** The local store failed (I/O, corruption, schema). */
  STORAGE_ERROR: "STORAGE_ERROR",
  /** The local disk is full. */
  STORAGE_FULL: "STORAGE_FULL",
  /** The key is outside the replica's prefix. */
  NOT_COVERED: "NOT_COVERED",
  /** Syncing the secrets space or the vault namespace needs an explicit opt-in. */
  SECRETS_OPT_IN_REQUIRED: "SECRETS_OPT_IN_REQUIRED",
  /** No grant is installed, or none covers the requested scope. */
  GRANT_MISSING: "GRANT_MISSING",
  /** The grant bytes are not a verifiable UCAN, or its signature is wrong. */
  GRANT_INVALID: "GRANT_INVALID",
  /** SIWE/CACAO and other non-UCAN grants cannot be used for a replica. */
  GRANT_FORMAT_UNSUPPORTED: "GRANT_FORMAT_UNSUPPORTED",
  /** The grant was issued to a different device. */
  GRANT_AUDIENCE_MISMATCH: "GRANT_AUDIENCE_MISMATCH",
  /** The grant lacks `tinycloud.kv/sync` or `tinycloud.kv/get` on the prefix. */
  GRANT_NOT_COVERING: "GRANT_NOT_COVERING",
  GRANT_NOT_YET_VALID: "GRANT_NOT_YET_VALID",
  GRANT_EXPIRED: "GRANT_EXPIRED",
  GRANT_REVOKED: "GRANT_REVOKED",
  /** The node refused the invocation for a reason other than revocation. */
  GRANT_UNAUTHORIZED: "GRANT_UNAUTHORIZED",
  /** The node refused the retention grant. */
  RETENTION_GRANT_REFUSED: "RETENTION_GRANT_REFUSED",
  /** The node could not be reached. */
  NETWORK_ERROR: "NETWORK_ERROR",
  /** The node answered with an unexpected status. */
  NODE_ERROR: "NODE_ERROR",
  /** The node's answer violates the wire contract. */
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
  /** The node asked for a fresh bootstrap (410). Handled inside sync. */
  RESET_REQUIRED: "RESET_REQUIRED",
  /** The feed now comes from a different node than the one pinned. */
  SOURCE_CHANGED: "SOURCE_CHANGED",
  /** The feed delivered a key outside the replica's prefix. */
  SCOPE_VIOLATION: "SCOPE_VIOLATION",
  /** Fetched bytes do not hash to the ETag the node attested for them. */
  CONTENT_MISMATCH: "CONTENT_MISMATCH",
  /** A stored blob no longer hashes to its name. */
  INTEGRITY_ERROR: "INTEGRITY_ERROR",
  /** The replica handle was closed; in-flight calls settle with this code. */
  CLOSED: "REPLICA_CLOSED",
} as const;

export type ReplicaErrorCode = (typeof ReplicaErrorCode)[keyof typeof ReplicaErrorCode];

/**
 * The package ships separate entry bundles (`.`, `./sqlite`), each with its own
 * copy of this class, so identity is a registered symbol, not `instanceof`.
 */
const REPLICA_ERROR = Symbol.for("tinycloud.replica.error");

export class ReplicaError extends Error {
  readonly [REPLICA_ERROR] = true;
  readonly code: ReplicaErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: ReplicaErrorCode, message: string, detail?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReplicaError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function isReplicaError(error: unknown, code?: ReplicaErrorCode): error is ReplicaError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [REPLICA_ERROR]?: unknown })[REPLICA_ERROR] === true &&
    (code === undefined || (error as ReplicaError).code === code)
  );
}
