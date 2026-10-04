/**
 * SDK Services - Error Utilities
 *
 * Utilities for creating and handling service errors.
 */

import {
  ServiceError,
  ErrorCodes,
  err,
  serviceError,
  type PermissionHint,
} from "./types";

/** Validate one structured node permission hint without accepting raw errors. */
export function parsePermissionHint(value: unknown): PermissionHint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.some((key) => !["actions", "path", "service", "space"].includes(key))) return undefined;
  if (candidate.service !== "tinycloud.kv" && candidate.service !== "tinycloud.encryption") return undefined;
  if (typeof candidate.path !== "string" || candidate.path.length === 0 || candidate.path.includes("*")) return undefined;
  if (candidate.service === "tinycloud.kv" &&
    (typeof candidate.space !== "string" || candidate.space.length === 0 || !candidate.path.startsWith("vault/") || candidate.path.endsWith("/"))) {
    return undefined;
  }
  if (candidate.service === "tinycloud.encryption" &&
    (candidate.space !== undefined || !candidate.path.startsWith("urn:tinycloud:encryption:") || candidate.path.endsWith(":"))) {
    return undefined;
  }
  if (!Array.isArray(candidate.actions) || candidate.actions.length !== 1 ||
    typeof candidate.actions[0] !== "string" || candidate.actions[0].includes("*")) return undefined;
  const expectedAction = candidate.service === "tinycloud.kv"
    ? "tinycloud.kv/get"
    : "tinycloud.encryption/decrypt";
  if (candidate.actions[0] !== expectedAction) return undefined;
  const space = typeof candidate.space === "string" ? candidate.space : undefined;
  return {
    service: candidate.service,
    ...(space === undefined ? {} : { space }),
    path: candidate.path,
    actions: [candidate.actions[0]],
  };
}

/** Extract only a validated structured hint from an SDK-owned error body. */
export function parsePermissionHintFromErrorText(text: string): PermissionHint | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const root = parsed as Record<string, unknown>;
    const nested = root.error;
    const nestedRecord = typeof nested === "object" && nested !== null
      ? nested as Record<string, unknown>
      : undefined;
    return parsePermissionHint(root.permissionHint) ??
      parsePermissionHint(nestedRecord?.permissionHint);
  } catch {
    return undefined;
  }
}

/**
 * Create a service error for authentication required.
 */
export function authRequiredError(service: string): ServiceError {
  return {
    code: ErrorCodes.AUTH_REQUIRED,
    message: "Authentication required. Please sign in first.",
    service,
  };
}

/**
 * Create a service error for expired authentication.
 */
export function authExpiredError(service: string): ServiceError {
  return {
    code: ErrorCodes.AUTH_EXPIRED,
    message: "Session has expired. Please sign in again.",
    service,
  };
}

/**
 * Create a service error for network issues.
 */
export function networkError(
  service: string,
  message: string,
  cause?: Error
): ServiceError {
  return {
    code: ErrorCodes.NETWORK_ERROR,
    message,
    service,
    cause,
  };
}

/**
 * Create a service error for timeouts.
 */
export function timeoutError(service: string): ServiceError {
  return {
    code: ErrorCodes.TIMEOUT,
    message: "Request timed out.",
    service,
  };
}

/**
 * Create a service error for aborted requests.
 */
export function abortedError(service: string): ServiceError {
  return {
    code: ErrorCodes.ABORTED,
    message: "Request was aborted.",
    service,
  };
}

/**
 * Create a service error for not found resources.
 */
export function notFoundError(
  service: string,
  resource: string
): ServiceError {
  return {
    code: ErrorCodes.NOT_FOUND,
    message: `Resource not found: ${resource}`,
    service,
  };
}

/**
 * Create a service error for permission denied.
 */
export function permissionDeniedError(
  service: string,
  action: string
): ServiceError {
  return {
    code: ErrorCodes.PERMISSION_DENIED,
    message: `Permission denied for action: ${action}`,
    service,
  };
}

/**
 * Parse the server's "Unauthorized Action: {resource} / {ability}" pattern.
 */
export function parseAuthError(responseText: string): { resource?: string; action?: string } {
  const match = responseText.match(/^Unauthorized Action:\s*(.+?)\s*\/\s*(tinycloud\.\S+)$/m);
  if (match) {
    return { resource: match[1].trim(), action: match[2].trim() };
  }
  return {};
}

/**
 * Create a service error for unauthorized action (missing capability).
 */
export function authUnauthorizedError(
  service: string,
  message: string,
  meta?: Record<string, unknown>
): ServiceError {
  return serviceError(ErrorCodes.AUTH_UNAUTHORIZED, message, service, { meta });
}

/**
 * Authorization verdict read from an error's structure, never its message:
 * - `"unauthenticated"`: HTTP 401 — the session is missing or stale.
 * - `"forbidden"`: HTTP 403, or `AUTH_UNAUTHORIZED` without a status — the
 *   session is valid but lacks the capability.
 * - `"other"`: a non-authorization HTTP error status (4xx/5xx).
 */
export type AuthorizationVerdict = "unauthenticated" | "forbidden" | "other";

const MAX_CAUSE_DEPTH = 8;

/** The first 4xx/5xx among `status`, `statusCode`, `meta.status`. Success and
 * informational statuses (e.g. a 200 `Response` kept as `cause`) are not
 * failures, so they are skipped rather than ending the search. */
function errorStatusOf(node: Record<string, unknown>): number | undefined {
  const meta = node.meta;
  const candidates = [
    node.status,
    node.statusCode,
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>).status
      : undefined,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Classify an error from its typed HTTP error status (`status`, `statusCode`,
 * or `meta.status`, 4xx/5xx only) and `AUTH_UNAUTHORIZED` code, following the
 * `cause` chain outer-first (at most {@link MAX_CAUSE_DEPTH} links, cycles
 * stop the walk) so wrappers that rethrow with `cause` keep the verdict. The
 * outermost error status decides, so an outer 5xx keeps its retry budget even
 * over an inner 401. Returns `undefined` for untyped errors; only then may
 * callers fall back to message heuristics.
 */
export function authorizationVerdictOf(
  error: unknown,
): AuthorizationVerdict | undefined {
  const seen = new Set<unknown>();
  let sawUnauthorizedCode = false;
  let node: unknown = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && typeof node === "object" && node !== null && !seen.has(node);
    depth += 1
  ) {
    seen.add(node);
    const record = node as Record<string, unknown>;
    const status = errorStatusOf(record);
    if (status === 401) return "unauthenticated";
    if (status === 403) return "forbidden";
    if (status !== undefined) return "other";
    if (record.code === ErrorCodes.AUTH_UNAUTHORIZED) sawUnauthorizedCode = true;
    node = record.cause;
  }
  return sawUnauthorizedCode ? "forbidden" : undefined;
}

/**
 * Create a service error for storage quota exceeded (402 Payment Required).
 */
export function storageQuotaExceededError(
  service: string,
  message: string,
  meta?: Record<string, unknown>
): ServiceError {
  return {
    code: ErrorCodes.STORAGE_QUOTA_EXCEEDED,
    message,
    service,
    meta,
  };
}

/**
 * Create a service error for storage limit reached (413 Payload Too Large).
 */
export function storageLimitReachedError(
  service: string,
  message: string,
  meta?: Record<string, unknown>
): ServiceError {
  return {
    code: ErrorCodes.STORAGE_LIMIT_REACHED,
    message,
    service,
    meta,
  };
}

/** Shown when a write is rejected because the owner's storage is full. */
export const STORAGE_FULL_MESSAGE =
  "TinyCloud storage is full, so this change was not saved. Reading still works. Free up space or upgrade your plan to save again.";

/** Shown when a write is larger than the storage the owner has left. */
export const STORAGE_WRITE_TOO_LARGE_MESSAGE =
  "This change is larger than the TinyCloud storage you have left, so it was not saved. Reading still works. Free up space or upgrade your plan to save it.";

/**
 * Parse the byte counts from a node storage rejection
 * ("... Used: 155744 bytes, Limit: 0 bytes"). The limit is the share of the
 * owner's account-wide budget left for this space, so it is 0 when the
 * owner's other spaces already use the whole budget.
 */
export function parseStorageQuotaBytes(
  responseText: string
): { usedBytes: number; limitBytes: number } | undefined {
  const match = responseText.match(/Used:\s*(\d+)\s*bytes,\s*Limit:\s*(\d+)\s*bytes/i);
  if (!match) return undefined;
  return {
    usedBytes: parseInt(match[1], 10),
    limitBytes: parseInt(match[2], 10),
  };
}

/**
 * Build the error for a write the node rejected for storage: 402 when storage
 * is already full, 413 when this write is larger than what is left. KV, SQL
 * and DuckDB all report it with the same codes and message so an app can
 * detect "storage full" in one place with {@link isStorageFullError}.
 */
export function storageRejectionError(
  service: string,
  status: 402 | 413,
  meta: Record<string, unknown>,
  responseText: string
): ServiceError {
  const quotaMeta = { ...meta, ...parseStorageQuotaBytes(responseText) };
  return status === 402
    ? storageQuotaExceededError(service, STORAGE_FULL_MESSAGE, quotaMeta)
    : storageLimitReachedError(service, STORAGE_WRITE_TOO_LARGE_MESSAGE, quotaMeta);
}

/**
 * True when a write failed because the owner's TinyCloud storage is full.
 * Reads keep working in that state, so apps should switch to a read-only
 * view and point the user at freeing up space or upgrading.
 */
export function isStorageFullError(error: { code?: string } | null | undefined): boolean {
  return (
    error?.code === ErrorCodes.STORAGE_QUOTA_EXCEEDED ||
    error?.code === ErrorCodes.STORAGE_LIMIT_REACHED
  );
}

/**
 * Wrap an unknown error in a ServiceError.
 */
export function wrapError(
  service: string,
  error: unknown,
  defaultCode: string = ErrorCodes.NETWORK_ERROR
): ServiceError {
  if (error instanceof Error) {
    // Check for abort errors
    if (error.name === "AbortError") {
      return abortedError(service);
    }

    // Check for timeout errors (varies by platform)
    if (
      error.name === "TimeoutError" ||
      error.message.toLowerCase().includes("timeout")
    ) {
      return timeoutError(service);
    }

    return {
      code: defaultCode,
      message: error.message,
      service,
      cause: error,
    };
  }

  return {
    code: defaultCode,
    message: String(error),
    service,
  };
}

/**
 * Create an error Result from a ServiceError.
 */
export function errorResult(error: ServiceError) {
  return err(error);
}
