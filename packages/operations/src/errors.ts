export const OPERATION_ERROR_CODES = [
  "INPUT_INVALID",
  "OPERATION_NOT_FOUND",
  "OPERATION_VERSION_UNSUPPORTED",
  "PROFILE_NOT_FOUND",
  "PROFILE_POSTURE_NOT_ALLOWED",
  "PROFILE_OWNER_OPT_IN_REQUIRED",
  "SESSION_NOT_FOUND",
  "PERMISSION_HINT_INVALID",
  "DELEGATION_ARTIFACT_INVALID",
  "DELEGATION_EXPIRED",
  "DELEGATION_AUDIENCE_MISMATCH",
  "DELEGATION_HOST_MISMATCH",
  "DELEGATION_REJECTED",
  "ENCRYPTION_NETWORK_UNRESOLVED",
  "NODE_UNREACHABLE",
  "NODE_ERROR",
  "KV_NOT_FOUND",
  "KV_PRECONDITION_FAILED",
  "KV_RESPONSE_TOO_LARGE",
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
