/** Safe projections for diagnostic sinks. */

const REDACTED = "[REDACTED]";
const SENSITIVE_FIELD =
  /authorization|delegation|token|secret|password|body|envelope|plaintext|ciphertext|payload|response|request|header|key|jwk|signature|proof|message|cause|meta|data/i;
const SAFE_STRING_FIELD = /^(service|action|span|method|event)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function primitiveValue(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

function projectUrl(value: unknown): unknown {
  if (typeof value !== "string") return projectDiagnosticData(value);
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?", 1)[0] ?? value;
  }
}

/** Return only stable, non-sensitive error diagnostics. */
export function projectDiagnosticError(error: unknown): Record<string, unknown> {
  if (!isRecord(error)) return { code: "ERROR" };

  const projected: Record<string, unknown> = {};
  const code = primitiveValue(error.code);
  const service = primitiveValue(error.service);
  const status = primitiveValue(error.status) ??
    (isRecord(error.meta) ? primitiveValue(error.meta.status) : undefined);

  if (typeof code === "string") projected.code = code;
  if (typeof service === "string") projected.service = service;
  if (typeof status === "number") projected.status = status;
  return Object.keys(projected).length > 0 ? projected : { code: "ERROR" };
}

/**
 * Copy diagnostic metadata while removing credentials, node responses,
 * encryption material, and application values. Status/action/span metadata
 * remains useful for correlating an operation.
 */
export function projectDiagnosticData(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return REDACTED;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return REDACTED;
  }
  if (value instanceof Error) return projectDiagnosticError(value);
  if (depth >= 8 || !isRecord(value)) return REDACTED;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => projectDiagnosticData(item, depth + 1, seen));
  }

  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "error") {
      projected[key] = projectDiagnosticError(child);
    } else if (key === "url") {
      projected[key] = projectUrl(child);
    } else if (SAFE_STRING_FIELD.test(key) && typeof child === "string") {
      projected[key] = child;
    } else if (SENSITIVE_FIELD.test(key)) {
      // Counters are safe; strings and objects could carry data or credentials.
      projected[key] =
        typeof child === "number" || typeof child === "boolean" ? child : REDACTED;
    } else {
      projected[key] = projectDiagnosticData(child, depth + 1, seen);
    }
  }
  return projected;
}
