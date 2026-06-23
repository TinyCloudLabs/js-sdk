/**
 * Zod schemas for session persistence types.
 *
 * This is the source of truth for session-related types. TypeScript types
 * are derived from these schemas using z.infer<>.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type { Result, ServiceError } from "@tinycloud/sdk-services";

// =============================================================================
// Shared Patterns
// =============================================================================

/**
 * Ethereum address pattern (checksummed or lowercase).
 */
const ethereumAddressPattern = /^0x[a-fA-F0-9]{40}$/;

// =============================================================================
// ENS Data Schema
// =============================================================================

/**
 * Schema for ENS data associated with a session.
 */
export const EnsDataSchema = z.object({
  /** ENS name/domain. */
  domain: z.string().nullable().optional(),
  /** ENS avatar URL. */
  avatarUrl: z.string().nullable().optional(),
});

export type EnsData = z.infer<typeof EnsDataSchema>;

// =============================================================================
// Persisted TinyCloud Session Schema
// =============================================================================

/**
 * Schema for TinyCloud-specific session data that's persisted.
 */
export const PersistedTinyCloudSessionSchema = z.object({
  /** The delegation header containing the UCAN */
  delegationHeader: z.object({
    Authorization: z.string(),
  }),
  /** The delegation CID */
  delegationCid: z.string(),
  /** The space ID for this session */
  spaceId: z.string(),
  /** Additional spaces included in this session's capabilities. Key is logical name, value is full spaceId URI */
  spaces: z.record(z.string(), z.string()).optional(),
  /** The verification method DID */
  verificationMethod: z.string(),
});

export type PersistedTinyCloudSession = z.infer<
  typeof PersistedTinyCloudSessionSchema
>;

// =============================================================================
// Persisted Session Data Schema
// =============================================================================

/**
 * Schema for full persisted session data.
 *
 * Contains all data needed to restore a session without re-authentication.
 */
export const PersistedSessionDataSchema = z.object({
  /** User's Ethereum address */
  address: z
    .string()
    .regex(ethereumAddressPattern, "Invalid Ethereum address"),
  /** EIP-155 Chain ID */
  chainId: z.number().int().positive(),
  /** Session key in JWK format (stringified) */
  sessionKey: z.string(),
  /** The signed SIWE message */
  siwe: z.string(),
  /** User's signature of the SIWE message */
  signature: z.string(),
  /** TinyCloud delegation data if available */
  tinycloudSession: PersistedTinyCloudSessionSchema.optional(),
  /** Session expiration timestamp (ISO 8601 with timezone offset) */
  expiresAt: z.string().datetime({ offset: true }),
  /** Session creation timestamp (ISO 8601 with timezone offset) */
  createdAt: z.string().datetime({ offset: true }),
  /** Schema version for migrations */
  version: z.string(),
  /** Optional ENS data */
  ens: EnsDataSchema.optional(),
  /**
   * TinyCloud hosts this session was created against. Persisted so a
   * restored session resolves to the same node without re-running the
   * registry/fallback resolution (or the wallet sign-in flow). Optional
   * for backward compatibility with sessions persisted before this field
   * existed — those restore and lazily re-resolve their hosts.
   */
  tinycloudHosts: z.array(z.string()).optional(),
});

export type PersistedSessionData = z.infer<typeof PersistedSessionDataSchema>;

// =============================================================================
// TinyCloud Session Schema (Runtime)
// =============================================================================

/**
 * Schema for full TinyCloud session with delegation data.
 *
 * This is the runtime session type used for making invocations and delegations.
 */
export const TinyCloudSessionSchema = z.object({
  /** User's Ethereum address */
  address: z.string().regex(ethereumAddressPattern, "Invalid Ethereum address"),
  /** EIP-155 Chain ID */
  chainId: z.number().int().positive(),
  /** Session key ID */
  sessionKey: z.string(),
  /** The space ID for this session */
  spaceId: z.string(),
  /** Additional spaces included in this session's capabilities. Key is logical name, value is full spaceId URI */
  spaces: z.record(z.string(), z.string()).optional(),
  /** The delegation CID */
  delegationCid: z.string(),
  /** The delegation header for API calls */
  delegationHeader: z.object({
    Authorization: z.string(),
  }),
  /** The verification method DID */
  verificationMethod: z.string(),
  /** The session key JWK (required for invoke operations) */
  jwk: z.object({}).passthrough(),
  /** The signed SIWE message */
  siwe: z.string(),
  /** User's signature of the SIWE message */
  signature: z.string(),
});

export type TinyCloudSession = z.infer<typeof TinyCloudSessionSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validation error type for schema validation failures.
 */
export interface ValidationError extends ServiceError {
  code: "VALIDATION_ERROR";
  meta?: {
    issues: z.ZodIssue[];
    path?: string;
  };
}

/**
 * Validate persisted session data against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 *
 * @example
 * ```typescript
 * const result = validatePersistedSessionData(JSON.parse(rawData));
 * if (result.ok) {
 *   // result.data is typed as PersistedSessionData
 *   console.log(result.data.address);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export function validatePersistedSessionData(
  data: unknown
): Result<PersistedSessionData, ValidationError> {
  const result = PersistedSessionDataSchema.safeParse(data);
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
 * Validate TinyCloud session against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateTinyCloudSession(
  data: unknown
): Result<TinyCloudSession, ValidationError> {
  const result = TinyCloudSessionSchema.safeParse(data);
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
 * Validate persisted TinyCloud session against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validatePersistedTinyCloudSession(
  data: unknown
): Result<PersistedTinyCloudSession, ValidationError> {
  const result = PersistedTinyCloudSessionSchema.safeParse(data);
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
