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
