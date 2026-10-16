import type { FetchFunction, FetchResponse, IServiceContext } from "./types";

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

const ATTEMPT_ACTIONS: Readonly<Record<string, true>> = {
  get: true, put: true, delete: true, list: true, batchPut: true, batchGet: true,
  query: true, execute: true, batch: true, create: true, drop: true, describe: true, unknown: true,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_METRIC = Number.MAX_SAFE_INTEGER;

/** Closed, event-specific transport vocabulary; never inspect arbitrary getters. */
export function projectAttemptDiagnostic(event: string, value: unknown): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value);
    const allowed = event === "diagnostic.attempt.start"
      ? ["attempt_id", "service", "action"]
      : event === "diagnostic.attempt.finish"
        ? ["attempt_id", "service", "action", "status", "duration_ms", "outcome"]
        : event === "diagnostic.retry.scheduled"
          ? ["attempt_id", "service", "action", "delay_ms", "ordinal"]
          : [];
    if (Object.keys(fields).some((key) => !allowed.includes(key) || !("value" in fields[key]!))) return undefined;
    const id = fields.attempt_id?.value;
    const service = fields.service?.value;
    const action = fields.action?.value;
    if (typeof id !== "string" || !UUID.test(id) || (service !== "kv" && service !== "sql") || typeof action !== "string" || !Object.prototype.hasOwnProperty.call(ATTEMPT_ACTIONS, action)) return undefined;
    const result: Record<string, unknown> = { attempt_id: id, service, action };
    for (const key of ["status", "duration_ms", "delay_ms", "ordinal"]) {
      if (!fields[key]) continue;
      const n = fields[key]!.value;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_METRIC) return undefined;
      if ((key === "status" && (!Number.isInteger(n) || n < 100 || n > 599)) ||
          (key === "ordinal" && (!Number.isSafeInteger(n) || n < 1))) return undefined;
      result[key] = n;
    }
    if (fields.outcome) {
      if (fields.outcome.value !== "response" && fields.outcome.value !== "error") return undefined;
      result.outcome = fields.outcome.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Observe only this dispatch, not nested context fetch wrappers or response reads. */
export function dispatchDiagnosticFetch(
  context: IServiceContext,
  fetch: FetchFunction,
  service: "kv" | "sql",
  action: string,
  url: Parameters<FetchFunction>[0],
  init: Parameters<FetchFunction>[1],
): Promise<FetchResponse> {
  if (typeof fetch !== "function") throw new TypeError("Fetch transport is not callable");
  if (!context.diagnosticTelemetryEnabled) return fetch(url, init);
  let fields: { attempt_id: string; service: "kv" | "sql"; action: string };
  let started: number;
  try {
    const normalized = action.startsWith("tinycloud.kv/") ? action.slice("tinycloud.kv/".length) : action;
    fields = { attempt_id: globalThis.crypto.randomUUID(), service, action: Object.prototype.hasOwnProperty.call(ATTEMPT_ACTIONS, normalized) ? normalized : "unknown" };
    started = performance.now();
  } catch {
    return fetch(url, init);
  }
  const emit = (event: string, data: unknown): void => {
    try { context.emit(event, data); } catch { /* Diagnostics never steer transport. */ }
  };
  emit("diagnostic.attempt.start", fields);
  const finish = (outcome: "response" | "error", status?: number): void => {
    try {
      emit("diagnostic.attempt.finish", {
        ...fields, outcome, ...(status === undefined ? {} : { status }),
        duration_ms: Math.min(MAX_METRIC, Math.max(0, performance.now() - started)),
      });
    } catch { /* No error content leaves the diagnostic path. */ }
  };
  try {
    return fetch(url, init).then(
      (response) => { finish("response", response.status); return response; },
      (error) => { finish("error"); throw error; },
    );
  } catch (error) {
    finish("error");
    throw error;
  }
}
