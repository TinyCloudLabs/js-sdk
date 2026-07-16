import type {
  OperationContextSummary,
  OperationDefinition,
  OperationRef,
} from "./contract.js";
import type { OperationError, OperationErrorCode } from "./errors.js";
import { safeOriginHost, safeSessionDid } from "./safe-values.js";

export const REDACTED_VALUE = "[REDACTED]";

export interface SafeOperationDiagnostic {
  readonly operation: OperationRef;
  readonly context: OperationContextSummary;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: OperationError;
}

/**
 * Return a detached redacted value. A missing pointer is intentionally a no-op
 * so an operation can evolve an optional shape without leaking another field.
 */
export function redactOperationValue(
  definition: Pick<OperationDefinition<unknown, unknown>, "sensitivity">,
  value: unknown,
): unknown {
  const clone = cloneValue(value);
  const pointers = [
    ...definition.sensitivity.input,
    ...definition.sensitivity.output,
  ];

  let redacted: unknown = clone;
  for (const pointer of pointers) {
    redacted = redactPointer(redacted, pointer);
  }
  return redacted;
}

/**
 * Diagnostic payloads are a supported non-result channel. They accept raw
 * operation values only through this helper, never an invocation target.
 */
export function createSafeOperationDiagnostic(
  definition: Pick<OperationDefinition<unknown, unknown>, "sensitivity">,
  diagnostic: Readonly<{
    operation: OperationRef;
    context: OperationContextSummary;
    input?: unknown;
    output?: unknown;
    error?: OperationError;
  }>,
): SafeOperationDiagnostic {
  return {
    operation: {
      operationId: diagnostic.operation.operationId,
      operationVersion: diagnostic.operation.operationVersion,
    },
    context: {
      profile: diagnostic.context.profile,
      host: diagnostic.context.host,
      posture: diagnostic.context.posture,
      ...(diagnostic.context.operatorType === undefined
        ? {}
        : { operatorType: diagnostic.context.operatorType }),
      ...(diagnostic.context.principalDid === undefined
        ? {}
        : { principalDid: diagnostic.context.principalDid }),
      ...(diagnostic.context.sessionDid === undefined
        ? {}
        : { sessionDid: diagnostic.context.sessionDid }),
      ...(diagnostic.context.ownerDid === undefined
        ? {}
        : { ownerDid: diagnostic.context.ownerDid }),
      ...(diagnostic.context.space === undefined
        ? {}
        : { space: diagnostic.context.space }),
    },
    ...(diagnostic.input === undefined
      ? {}
      : { input: redactOperationValue(definition, diagnostic.input) }),
    ...(diagnostic.output === undefined
      ? {}
      : { output: redactOperationValue(definition, diagnostic.output) }),
    ...(diagnostic.error === undefined
      ? {}
      : { error: redactOperationError(definition, diagnostic.error) }),
  };
}

export function redactOperationError(
  _definition: Pick<OperationDefinition<unknown, unknown>, "sensitivity">,
  error: OperationError,
): OperationError {
  const details =
    error.details === undefined
      ? undefined
      : redactSafeErrorDetails(error.code, error.details);

  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(details === undefined
      ? {}
      : {
          details: isRecord(details) ? details : { redacted: details },
        }),
  };
}

/**
 * Error details are a separate, code-owned channel. Only fields with an
 * explicit stable policy can cross the canonical result or diagnostic
 * boundary; arbitrary handler details are dropped rather than redacted by
 * input pointers, which could accidentally preserve a transport secret.
 */
const SAFE_ERROR_DETAIL_POLICIES: Readonly<
  Partial<
    Record<
      OperationErrorCode,
      Readonly<Record<string, (value: unknown) => unknown | undefined>>
    >
  >
> = {
  INPUT_INVALID: {
    issues: (value) =>
      Array.isArray(value) ? safeIssueCodes(value) : undefined,
  },
  OPERATION_VERSION_UNSUPPORTED: {
    supportedVersions: (value) =>
      Array.isArray(value) && value.every((item) => Number.isInteger(item))
        ? value
        : undefined,
  },
  DELEGATION_AUDIENCE_MISMATCH: {
    expectedSessionDid: safeSessionDid,
    artifactAudience: safeSessionDid,
  },
  DELEGATION_HOST_MISMATCH: {
    expectedHost: safeOriginHost,
    artifactHost: safeOriginHost,
  },
};

function redactSafeErrorDetails(
  code: OperationErrorCode,
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const policy = SAFE_ERROR_DETAIL_POLICIES[code];
  if (policy === undefined) return undefined;

  const safeDetails: Record<string, unknown> = {};
  for (const [key, sanitize] of Object.entries(policy)) {
    if (!hasOwn(details, key)) continue;
    const value = sanitize(details[key]);
    if (value !== undefined) safeDetails[key] = value;
  }
  return Object.keys(safeDetails).length === 0 ? undefined : safeDetails;
}

function safeIssueCodes(
  value: readonly unknown[],
): readonly Readonly<{ code: string }>[] | undefined {
  const codes = value.map((issue) => {
    if (!isRecord(issue) || typeof issue.code !== "string") return undefined;
    return SAFE_ISSUE_CODES.has(issue.code) ? { code: issue.code } : undefined;
  });
  return codes.every(
    (issue): issue is Readonly<{ code: string }> => issue !== undefined,
  )
    ? codes
    : undefined;
}

const SAFE_ISSUE_CODES = new Set([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite",
]);

function redactPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") {
    return REDACTED_VALUE;
  }
  if (!pointer.startsWith("/")) {
    return value;
  }

  const tokens = pointer.slice(1).split("/").map(unescapePointerToken);
  const parent = getPointerParent(value, tokens);
  if (parent === undefined) {
    return value;
  }

  const key = tokens[tokens.length - 1];
  if (key === undefined || !hasOwn(parent, key)) {
    return value;
  }

  Reflect.set(parent, key, REDACTED_VALUE);
  return value;
}

function getPointerParent(
  value: unknown,
  tokens: readonly string[],
): Record<string, unknown> | unknown[] | undefined {
  if (tokens.length === 0) {
    return undefined;
  }

  let cursor = value;
  for (const token of tokens.slice(0, -1)) {
    if (!isRecordOrArray(cursor) || !hasOwn(cursor, token)) {
      return undefined;
    }
    cursor = Reflect.get(cursor, token);
  }
  return isRecordOrArray(cursor) ? cursor : undefined;
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }

  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneValue((value as Record<string, unknown>)[key]),
      writable: true,
    });
  }
  return clone;
}

function isRecordOrArray(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
