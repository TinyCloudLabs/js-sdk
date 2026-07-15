/** Safe projections for diagnostic sinks. */

const REDACTED = "[REDACTED]";
const SAFE_NUMBER_FIELDS = new Set([
  "duration",
  "durationMs",
  "endedAt",
  "startedAt",
  "status",
  "timestamp",
]);
const SAFE_BOOLEAN_FIELDS = new Set(["authenticated", "ok", "persisted"]);

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
