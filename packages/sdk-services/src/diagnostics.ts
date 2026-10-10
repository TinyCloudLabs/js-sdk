/** Safe projections for diagnostic sinks. */

const REDACTED = "[REDACTED]";
const SAFE_NUMBER_FIELDS = new Set([
  "duration",
  "durationMs",
  "endedAt",
  "startedAt",
  "status",
  "timestamp",
  "latencyMs",
  "stalenessMs",
  "count",
  "changes",
  "deleted",
  "fetched",
  "pages",
  "lagMs",
  "pendingCleared",
]);
const SAFE_BOOLEAN_FIELDS = new Set(["authenticated", "ok", "persisted"]);
const SAFE_REPLICATION_FIELDS: Record<string, readonly string[]> = {
  source: ["replica", "network", "none"],
  reason: ["hit", "absent", "deleted", "content_missing", "coverage_incomplete", "not_covered", "pending_write", "grant_missing", "grant_expired", "grant_revoked", "grant_not_yet_valid", "stale", "replica_error", "runtime_unsupported", "replica_unavailable", "unsupported_option", "network_cursor", "cursor_restart", "aborted", "REPLICA_BEHIND_OWN_WRITES", "REPLICA_UNPROVEN_SINCE_START", "NETWORK_REQUESTED"],
  op: ["get", "list", "put", "delete", "batchPut"],
  trigger: ["start", "interval", "stale_read", "manual"],
  outcome: ["found", "not_found", "error", "committed", "failed", "ambiguous", "ok", "busy", "aborted"],
  class: ["offline", "authority", "storage", "node"],
  state: ["opened", "grant_installed", "grant_missing", "runtime_unsupported", "unavailable", "revoked", "recreated", "purged", "purge_failed", "pending_store_error", "pinned", "pending_cleared", "closed", "idle", "ready"],
  kind: ["value", "missing_local", "extra_local", "keys", "order"],
  coverage: ["empty", "bootstrapping", "complete"],
  authority: ["valid", "expired", "revoked", "not-yet-valid"],
  code: ["NETWORK_ERROR", "TIMEOUT", "ABORTED", "REPLICA_BUSY", "REPLICA_BEHIND_OWN_WRITES", "REPLICA_UNPROVEN_SINCE_START", "NETWORK_REQUESTED", "INTEGRITY_ERROR", "STORAGE_ERROR", "REPLICA_CLOSED", "RUNTIME_UNSUPPORTED", "GRANT_EXPIRED", "GRANT_REVOKED", "GRANT_NOT_YET_VALID", "GRANT_MISSING", "GRANT_INVALID", "SOURCE_CHANGED", "PROTOCOL_ERROR", "SCOPE_VIOLATION", "NODE_ERROR", "CONTENT_MISMATCH", "STORAGE_FULL"],
  pendingState: ["in_flight", "committed", "ambiguous"],
  strategy: ["session", "minted", "installed"],
  verify: ["match", "diverged", "error", "aborted"],
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isBinaryData(value: object): boolean {
  try {
    return (
      Array.isArray(value) ||
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer
    );
  } catch {
    // A revoked Proxy can throw while checking its shape. It is not diagnostic
    // data and must not prevent the SDK operation that emitted it.
    return true;
  }
}

function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return REDACTED;
  }
}

/** Return only stable, non-sensitive error diagnostics. */
export function projectDiagnosticError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};

  const status = finiteNumber(read(error, "status"));
  return status !== undefined && status >= 100 && status <= 599 ? { status } : {};
}

/**
 * Copy only fixed scalar metrics and URL origins. Diagnostic payloads can be
 * supplied by applications and nodes, so strings, nested values, and unknown
 * fields are never projected to debug or telemetry sinks.
 */
export function projectDiagnosticData(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return REDACTED;

  try {
    if (isBinaryData(value)) return REDACTED;

    const projected: Record<string, unknown> = {};
    for (const key of SAFE_NUMBER_FIELDS) {
      const number = finiteNumber(read(value, key));
      if (number !== undefined) projected[key] = number;
    }
    for (const key of SAFE_BOOLEAN_FIELDS) {
      const boolean = read(value, key);
      if (typeof boolean === "boolean") projected[key] = boolean;
    }
    for (const [key, allowed] of Object.entries(SAFE_REPLICATION_FIELDS)) {
      const candidate = read(value, key);
      if (typeof candidate === "string" && allowed.includes(candidate)) {
        projected[key] = candidate;
      }
    }


    // URLs, like every other string-bearing value, are never projected. Even
    // an origin can encode user-controlled data in a hostname.
    const url = read(value, "url");
    if (url !== undefined) projected.url = REDACTED;

    const error = read(value, "error");
    if (error !== undefined) projected.error = projectDiagnosticError(error);

    return projected;
  } catch {
    // Projection is best-effort only. Hostile Proxy traps and exotic objects
    // must never block telemetry, debug logging, or ordinary subscribers.
    return REDACTED;
  }
}
