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

function projectUrl(value: unknown): unknown {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    return url.origin;
  } catch {
    return REDACTED;
  }
}

/** Return only stable, non-sensitive error diagnostics. */
export function projectDiagnosticError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};

  try {
    const status = finiteNumber((error as { status?: unknown }).status);
    return status !== undefined && status >= 100 && status <= 599 ? { status } : {};
  } catch {
    return {};
  }
}

/**
 * Copy only fixed scalar metrics and URL origins. Diagnostic payloads can be
 * supplied by applications and nodes, so strings, nested values, and unknown
 * fields are never projected to debug or telemetry sinks.
 */
export function projectDiagnosticData(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return REDACTED;
  if (value instanceof Error) return projectDiagnosticError(value);
  if (Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return REDACTED;
  }

  const projected: Record<string, unknown> = {};
  for (const key of SAFE_NUMBER_FIELDS) {
    try {
      const number = finiteNumber((value as Record<string, unknown>)[key]);
      if (number !== undefined) projected[key] = number;
    } catch {
      // Diagnostic projection must not let exotic objects break SDK behavior.
    }
  }
  for (const key of SAFE_BOOLEAN_FIELDS) {
    try {
      const boolean = (value as Record<string, unknown>)[key];
      if (typeof boolean === "boolean") projected[key] = boolean;
    } catch {
      // Diagnostic projection must not let exotic objects break SDK behavior.
    }
  }
  try {
    const url = (value as Record<string, unknown>).url;
    if (url !== undefined) projected.url = projectUrl(url);
  } catch {
    projected.url = REDACTED;
  }
  try {
    const error = (value as Record<string, unknown>).error;
    if (error !== undefined) projected.error = projectDiagnosticError(error);
  } catch {
    projected.error = {};
  }
  return projected;
}
