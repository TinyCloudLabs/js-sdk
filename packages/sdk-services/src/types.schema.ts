/**
 * Zod schemas for SDK Services API response types.
 *
 * This is the source of truth for service response types. TypeScript types
 * are derived from these schemas using z.infer<>.
 *
 * @packageDocumentation
 */

import { z } from "zod";

// =============================================================================
// Validation Error Type
// =============================================================================

/**
 * Validation error type for schema validation failures.
 */
export interface ValidationError {
  code: "VALIDATION_ERROR";
  message: string;
  service: string;
  meta?: {
    issues: z.ZodIssue[];
    path?: string;
  };
}

// =============================================================================
// Service Error Schema
// =============================================================================

/**
 * Schema for service error with structured information.
 */
export const ServiceErrorSchema = z.object({
  /** Error code for programmatic handling (e.g., 'KV_NOT_FOUND', 'AUTH_EXPIRED') */
  code: z.string(),
  /** Human-readable error message */
  message: z.string(),
  /** Service that produced the error (e.g., 'kv', 'sql') */
  service: z.string(),
  /** Original error if this wraps another error - not validated since Error is a class */
  cause: z.unknown().optional(),
  /** Additional metadata about the error - passthrough allows any object properties */
  meta: z.object({}).passthrough().optional(),
});

export type ServiceErrorType = z.infer<typeof ServiceErrorSchema>;

// =============================================================================
// Result Schema Factory
// =============================================================================

/**
 * Creates a Result schema for a given data type.
 * Result is a discriminated union: { ok: true, data: T } | { ok: false, error: E }
 *
 * @param dataSchema - Zod schema for the success data type
 * @param errorSchema - Zod schema for the error type (defaults to ServiceErrorSchema)
 * @returns A Zod schema for Result<T, E>
 *
 * @example
 * ```typescript
 * const KVGetResultSchema = createResultSchema(z.string());
 * type KVGetResult = z.infer<typeof KVGetResultSchema>;
 * ```
 */
export function createResultSchema<T extends z.ZodTypeAny, E extends z.ZodTypeAny>(
  dataSchema: T,
  errorSchema: E = ServiceErrorSchema as unknown as E
) {
  return z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: dataSchema,
    }),
    z.object({
      ok: z.literal(false),
      error: errorSchema,
    }),
  ]);
}

/**
 * Pre-built Result schema with unknown data and ServiceError.
 * Useful for generic validation before type narrowing.
 */
export const GenericResultSchema = createResultSchema(z.unknown(), ServiceErrorSchema);

// =============================================================================
// KV Response Schemas
// =============================================================================

/**
 * Schema for KV response headers metadata.
 * Note: The `get` method is a function and cannot be validated with Zod.
 * This schema validates the data properties only.
 */
export const KVResponseHeadersSchema = z.object({
  /** ETag for conditional requests */
  etag: z.string().optional(),
  /** Content type of the stored value */
  contentType: z.string().optional(),
  /** Last modification timestamp */
  lastModified: z.string().optional(),
  /** Content length in bytes */
  contentLength: z.number().optional(),
});

export type KVResponseHeadersType = z.infer<typeof KVResponseHeadersSchema>;

/**
 * Creates a KVResponse schema for a given data type.
 *
 * @param dataSchema - Zod schema for the data payload type
 * @returns A Zod schema for KVResponse<T>
 *
 * @example
 * ```typescript
 * const UserResponseSchema = createKVResponseSchema(UserSchema);
 * type UserResponse = z.infer<typeof UserResponseSchema>;
 * ```
 */
export function createKVResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    /** The data payload */
    data: dataSchema,
    /** Response headers with metadata */
    headers: KVResponseHeadersSchema,
  });
}

/**
 * Generic KVResponse schema with unknown data.
 * Useful for generic validation before type narrowing.
 */
export const GenericKVResponseSchema = createKVResponseSchema(z.unknown());

export type GenericKVResponseType = z.infer<typeof GenericKVResponseSchema>;

/**
 * Schema for KV list response.
 */
export const KVListResponseSchema = z.object({
  /** Array of keys matching the list criteria */
  keys: z.array(z.string()),
});

export type KVListResponseType = z.infer<typeof KVListResponseSchema>;

/**
 * Result schema for KV list operations.
 */
export const KVListResultSchema = createResultSchema(KVListResponseSchema);

export type KVListResultType = z.infer<typeof KVListResultSchema>;

// =============================================================================
// Telemetry Event Schemas
// =============================================================================

/**
 * Schema for service request event.
 */
export const ServiceRequestEventSchema = z.object({
  service: z.string(),
  action: z.string(),
  span: z.string().optional(),
  key: z.string().optional(),
  timestamp: z.number(),
});

export type ServiceRequestEventType = z.infer<typeof ServiceRequestEventSchema>;

/**
 * Schema for service response event.
 */
export const ServiceResponseEventSchema = z.object({
  service: z.string(),
  action: z.string(),
  span: z.string().optional(),
  ok: z.boolean(),
  duration: z.number(),
  durationMs: z.number().optional(),
  status: z.number().optional(),
});

export type ServiceResponseEventType = z.infer<typeof ServiceResponseEventSchema>;

/**
 * Schema for service error event.
 */
export const ServiceErrorEventSchema = z.object({
  service: z.string(),
  span: z.string().optional(),
  error: ServiceErrorSchema,
});

export type ServiceErrorEventType = z.infer<typeof ServiceErrorEventSchema>;

/**
 * Schema for service retry event.
 */
export const ServiceRetryEventSchema = z.object({
  service: z.string(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  error: ServiceErrorSchema,
});

export type ServiceRetryEventType = z.infer<typeof ServiceRetryEventSchema>;

/**
 * Schema for generic named span event.
 */
export const TelemetrySpanEventSchema = z.object({
  span: z.string(),
  ok: z.boolean(),
  durationMs: z.number(),
  service: z.string().optional(),
  action: z.string().optional(),
  status: z.number().optional(),
  error: ServiceErrorSchema.optional(),
});

export type TelemetrySpanEventType = z.infer<typeof TelemetrySpanEventSchema>;

// =============================================================================
// Retry Policy Schema
// =============================================================================

/**
 * Schema for retry policy configuration.
 */
export const RetryPolicySchema = z.object({
  /** Maximum number of attempts (including initial) */
  maxAttempts: z.number().int().positive(),
  /** Backoff strategy between retries */
  backoff: z.enum(["none", "linear", "exponential"]),
  /** Base delay in milliseconds for backoff calculation */
  baseDelayMs: z.number().nonnegative(),
  /** Maximum delay in milliseconds between retries */
  maxDelayMs: z.number().nonnegative(),
  /** Error codes that should trigger a retry */
  retryableErrors: z.array(z.string()),
});

export type RetryPolicyType = z.infer<typeof RetryPolicySchema>;

// =============================================================================
// Service Session Schema
// =============================================================================

/**
 * Schema for service session data required for authenticated operations.
 */
export const ServiceSessionSchema = z.object({
  /** The delegation header containing the UCAN */
  delegationHeader: z.object({
    Authorization: z.string(),
  }),
  /** The delegation CID */
  delegationCid: z.string(),
  /** The space ID for this session */
  spaceId: z.string(),
  /** The verification method DID */
  verificationMethod: z.string(),
  /** The session key JWK (required for invoke) */
  jwk: z.object({}).passthrough(),
});

export type ServiceSessionType = z.infer<typeof ServiceSessionSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate service error against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateServiceError(
  data: unknown
): { ok: true; data: ServiceErrorType } | { ok: false; error: ValidationError } {
  const result = ServiceErrorSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "validation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate KV list response against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateKVListResponse(
  data: unknown
): { ok: true; data: KVListResponseType } | { ok: false; error: ValidationError } {
  const result = KVListResponseSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "kv",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate KV response headers against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateKVResponseHeaders(
  data: unknown
): { ok: true; data: KVResponseHeadersType } | { ok: false; error: ValidationError } {
  const result = KVResponseHeadersSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "kv",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate service session against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateServiceSession(
  data: unknown
): { ok: true; data: ServiceSessionType } | { ok: false; error: ValidationError } {
  const result = ServiceSessionSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "session",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate retry policy against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateRetryPolicy(
  data: unknown
): { ok: true; data: RetryPolicyType } | { ok: false; error: ValidationError } {
  const result = RetryPolicySchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "config",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate service request event against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateServiceRequestEvent(
  data: unknown
): { ok: true; data: ServiceRequestEventType } | { ok: false; error: ValidationError } {
  const result = ServiceRequestEventSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "telemetry",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate service response event against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateServiceResponseEvent(
  data: unknown
): { ok: true; data: ServiceResponseEventType } | { ok: false; error: ValidationError } {
  const result = ServiceResponseEventSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "telemetry",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate named telemetry span event against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateTelemetrySpanEvent(
  data: unknown
): { ok: true; data: TelemetrySpanEventType } | { ok: false; error: ValidationError } {
  const result = TelemetrySpanEventSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "telemetry",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}
