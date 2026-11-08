import { PartialNodeWriteError, routingFailure } from "@tinycloud/sdk-services";

export const OPERATION_ERROR_CODES = [
  "INPUT_INVALID",
  "OPERATION_NOT_FOUND",
  "OPERATION_VERSION_UNSUPPORTED",
  "PROFILE_NOT_FOUND",
  "PROFILE_POSTURE_NOT_ALLOWED",
  "PROFILE_OWNER_OPT_IN_REQUIRED",
  "PROFILE_MIGRATION_REQUIRED",
  "AUTH_REQUIRED",
  "PERMISSION_DENIED",
  "SESSION_NOT_FOUND",
  "PERMISSION_HINT_INVALID",
  "DELEGATION_ARTIFACT_INVALID",
  "DELEGATION_EXPIRED",
  "DELEGATION_AUDIENCE_MISMATCH",
  "DELEGATION_HOST_MISMATCH",
  "DELEGATION_REJECTED",
  "ENCRYPTION_NETWORK_UNRESOLVED",
  "NODE_UNREACHABLE",
  "NODE_NOT_RESPONDING",
  "DECRYPTION_DEPENDENCY_UNAVAILABLE",
  "NODE_IDENTITY_MISMATCH",
  "PARTIAL_NODE_WRITE",
  "RESOURCE_NOT_ROUTED",
  "REGISTRY_UNAVAILABLE",
  "NODE_NOT_FOUND",
  "NODE_REGISTRY_ENTRY_EXISTS",
  "NODE_ERROR",
  "STORAGE_QUOTA_EXCEEDED",
  "KV_NOT_FOUND",
  "KV_PRECONDITION_FAILED",
  "KV_CONFLICT",
  "KV_RESPONSE_TOO_LARGE",
  "SQL_QUERY_INVALID",
  "SQL_EXECUTION_FAILED",
  "SQL_RESULT_LIMIT_EXCEEDED",
  "SQL_VALUE_UNSAFE",
  "READ_SOURCE_CHANGED",
  "READ_CONTEXT_MISMATCH",
  "SECRET_READ_FAILED",
  "SECRET_DECRYPT_FAILED",
  "OUTPUT_INVALID",
  "INTERNAL_ERROR",
] as const;

export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];

export interface OperationError {
  readonly code: OperationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function operationError(
  code: OperationErrorCode,
  message: string,
  options: Readonly<{
    retryable?: boolean;
    details?: Readonly<Record<string, unknown>>;
  }> = {},
): OperationError {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

const MANAGE_STORAGE = "Do not retry: the owner must free up space or upgrade at https://account.tinycloud.xyz/storage.";

/**
 * A write the node refused because the owner's TinyCloud storage is full
 * (SDK `STORAGE_QUOTA_EXCEEDED`, HTTP 402) or too small for this write
 * (`STORAGE_LIMIT_REACHED`, HTTP 413). Nothing was written, so the outcome is
 * known, and it stays refused until the owner acts, so it is never retryable.
 * The SDK's account totals travel as details; per-space numbers never do.
 */
export function storageFullOperationError(error: unknown): OperationError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, meta } = error as { code?: unknown; meta?: unknown };
  if (code !== "STORAGE_QUOTA_EXCEEDED" && code !== "STORAGE_LIMIT_REACHED") return undefined;
  const account = typeof meta === "object" && meta !== null ? (meta as { account?: unknown }).account : undefined;
  return operationError(
    "STORAGE_QUOTA_EXCEEDED",
    code === "STORAGE_LIMIT_REACHED"
      ? `This write is larger than the TinyCloud storage left, so nothing was written. Reading still works. ${MANAGE_STORAGE}`
      : `TinyCloud storage is full, so nothing was written. Reading still works. ${MANAGE_STORAGE}`,
    { retryable: false, ...(account === undefined ? {} : { details: { account } }) },
  );
}

/**
 * The SDK's node retry codes (`NODE_BUSY`, `REQUEST_TIMEOUT`, `OUTCOME_UNKNOWN`) as `NODE_ERROR` with the
 * SDK's own verdict: a busy node or a deadline hit before any write began applied nothing, so a retry is
 * safe; `OUTCOME_UNKNOWN` may have applied a write, so it is never retryable and says to read back first.
 */
export function nodeRetryOperationError(error: unknown): OperationError | undefined {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "OUTCOME_UNKNOWN") {
    return operationError(
      "NODE_ERROR",
      "The storage server may have applied the write; read the data back before retrying.",
      { retryable: false },
    );
  }
  if (code !== "NODE_BUSY" && code !== "REQUEST_TIMEOUT") return undefined;
  return operationError("NODE_ERROR", "The storage server was busy and applied nothing; try again shortly.", { retryable: true });
}

const ROUTING_OPERATION_ERRORS: Readonly<Record<NonNullable<ReturnType<typeof routingFailure>>["code"], OperationError>> = {
  NODE_NOT_RESPONDING: { code: "NODE_NOT_RESPONDING", message: "Your storage server isn't responding. Try again in a minute.", retryable: true },
  DECRYPTION_DEPENDENCY_UNAVAILABLE: { code: "DECRYPTION_DEPENDENCY_UNAVAILABLE", message: "The decryption service isn't responding. Try again in a minute.", retryable: true },
  NODE_IDENTITY_MISMATCH: { code: "NODE_IDENTITY_MISMATCH", message: "This storage server isn't the one in your storage settings, so TinyCloud didn't use it.", retryable: false },
  PARTIAL_NODE_WRITE: { code: "PARTIAL_NODE_WRITE", message: "This didn't finish on every server that needs a copy. Try again.", retryable: false },
  RESOURCE_NOT_ROUTED: { code: "RESOURCE_NOT_ROUTED", message: "Your storage settings don't say where this data goes.", retryable: false },
  registry_unavailable: { code: "REGISTRY_UNAVAILABLE", message: "Couldn't reach your storage settings. Try again in a few minutes.", retryable: true },
  node_not_found: { code: "NODE_NOT_FOUND", message: "No storage server is set for this data.", retryable: false },
  node_registry_entry_exists: { code: "NODE_REGISTRY_ENTRY_EXISTS", message: "That storage server isn't in your storage settings, so it wasn't used.", retryable: false },
};

function partialRoutingDetails(partial: PartialNodeWriteError) {
  return {
    succeeded: partial.succeeded,
    failed: partial.failed.map(({ url, status, cause }) => {
      const code = routingFailure(cause)?.code;
      return { url, ...(status === undefined ? {} : { status }), ...(code === undefined ? {} : { code }) };
    }),
  };
}

/** Preserve routing codes without exposing node response bodies or private causes. */
export function routingOperationError(error: unknown): OperationError | undefined {
  const failure = routingFailure(error);
  if (!failure) return undefined;
  const projected = ROUTING_OPERATION_ERRORS[failure.code];
  const message = failure.code === "registry_unavailable" && failure.meta?.reason === "no-saved-settings"
    ? "Couldn't reach your storage settings, and none are saved on this computer yet, so this didn't run. Try again in a few minutes."
    : projected.message;
  return operationError(projected.code, message, {
    retryable: projected.retryable,
    ...(error instanceof PartialNodeWriteError ? { details: partialRoutingDetails(error) } : {}),
  });
}

/** Only grant registration may project all-unavailable partials as retryable availability. */
export function activationRoutingOperationError(error: unknown): OperationError | undefined {
  if (!(error instanceof PartialNodeWriteError)) return routingOperationError(error);
  const details = partialRoutingDetails(error);
  // Retrying the same grant registration is safe: no operation data has been written.
  const unavailable = details.failed.length > 0 &&
    details.failed.every(({ code }) => code === "NODE_NOT_RESPONDING");
  const projected = ROUTING_OPERATION_ERRORS[unavailable ? "NODE_NOT_RESPONDING" : "PARTIAL_NODE_WRITE"];
  return operationError(projected.code,
    unavailable ? projected.message : "This permission wasn't saved on every server that needs it. Try again.", {
      retryable: projected.retryable,
      details,
    });
}

/**
 * Internal operations and profile resolution use this for expected failures.
 * Generic exceptions are never exposed at the projection boundary.
 */
export class OperationInvocationError extends Error {
  public readonly operationError: OperationError;

  constructor(operationError: OperationError) {
    super(operationError.message);
    this.name = "OperationInvocationError";
    this.operationError = operationError;
  }
}

export function isOperationErrorCode(value: unknown): value is OperationErrorCode {
  return typeof value === "string" && OPERATION_ERROR_CODES.includes(value as OperationErrorCode);
}

export function internalOperationError(): OperationError {
  return operationError(
    "INTERNAL_ERROR",
    "The operation could not be completed.",
  );
}

export function sanitizeThrownOperationError(error: unknown): OperationError {
  if (error instanceof OperationInvocationError) {
    return sanitizeOperationError(error.operationError);
  }

  return internalOperationError();
}

export function sanitizeOperationError(error: unknown): OperationError {
  if (
    typeof error !== "object" ||
    error === null ||
    !isOperationErrorCode((error as { code?: unknown }).code) ||
    typeof (error as { message?: unknown }).message !== "string" ||
    typeof (error as { retryable?: unknown }).retryable !== "boolean"
  ) {
    return internalOperationError();
  }

  const candidate = error as OperationError;
  return operationError(candidate.code, candidate.message, {
    retryable: candidate.retryable,
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  });
}
