/**
 * Zod schemas for SharingService types.
 *
 * These schemas provide runtime validation for sharing link data,
 * receive options, and service configuration.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type {
  FetchFunction,
  IKVService,
  InvokeFunction,
  ServiceSession,
} from "@tinycloud/sdk-services";
import {
  JWKSchema,
  DelegationSchema,
  KeyProviderSchema,
  IngestOptionsSchema,
  type Result,
  type DelegationError,
  DelegationErrorCodes,
} from "./types.schema.js";
import type { ICapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry.js";
import type { DelegationManager } from "./DelegationManager.js";

// =============================================================================
// EncodedShareData Schema
// =============================================================================

/**
 * Schema for data encoded in a sharing link.
 *
 * This is the primary validation point for external share link data.
 * The link is base64-decoded and JSON-parsed, then validated against this schema.
 */
export const EncodedShareDataSchema = z.object({
  /** Private key in JWK format (must include d parameter) */
  key: JWKSchema.refine(
    (jwk) => typeof jwk.d === "string" && jwk.d.length > 0,
    { message: "JWK must include private key (d parameter)" }
  ),
  /** DID of the key */
  keyDid: z.string().min(1, "keyDid is required"),
  /** The delegation granting access */
  delegation: DelegationSchema,
  /** Resource path this link grants access to */
  path: z.string().min(1, "path is required"),
  /** TinyCloud host URL */
  host: z.string().url("host must be a valid URL"),
  /** Space ID */
  spaceId: z.string().min(1, "spaceId is required"),
  /** Schema version (must be 1) */
  version: z.literal(1),
});

export type EncodedShareData = z.infer<typeof EncodedShareDataSchema>;

// =============================================================================
// ReceiveOptions Schema
// =============================================================================

/**
 * Schema for options when receiving a sharing link.
 */
export const ReceiveOptionsSchema = z.object({
  /**
   * Whether to automatically create a sub-delegation to the current session key.
   * Default: true
   */
  autoSubdelegate: z.boolean().optional(),
  /**
   * Whether to use the current session key for operations (requires autoSubdelegate).
   * Default: true
   */
  useSessionKey: z.boolean().optional(),
  /**
   * Ingestion options passed to CapabilityKeyRegistry.
   */
  ingestOptions: IngestOptionsSchema.optional(),
});

export type ReceiveOptions = z.infer<typeof ReceiveOptionsSchema>;

// =============================================================================
// SharingServiceConfig Schema
// =============================================================================

/**
 * Schema for SharingService configuration.
 *
 * Note: Function fields use z.function() for shape validation only.
 * External types (ServiceSession, DelegationManager, ICapabilityKeyRegistry)
 * use z.unknown() with runtime type refinement.
 */
export const SharingServiceConfigSchema = z.object({
  /** TinyCloud host URLs */
  hosts: z.array(z.string().url()).min(1, "At least one host URL is required"),
  /**
   * Active session for authentication.
   * Required for generate(), optional for receive().
   */
  session: z
    .unknown()
    .refine(
      (val): val is ServiceSession =>
        val === undefined || (val !== null && typeof val === "object"),
      { message: "Expected a ServiceSession object or undefined" }
    )
    .optional(),
  /** Platform-specific invoke function */
  invoke: z
    .unknown()
    .refine((val): val is InvokeFunction => typeof val === "function", {
      message: "Expected an invoke function",
    }),
  /** Optional custom fetch implementation */
  fetch: z
    .unknown()
    .refine(
      (val): val is FetchFunction =>
        val === undefined || typeof val === "function",
      { message: "Expected a fetch function or undefined" }
    )
    .optional(),
  /** Key provider for cryptographic operations */
  keyProvider: KeyProviderSchema,
  /** Capability key registry for key/delegation management */
  registry: z
    .unknown()
    .refine(
      (val): val is ICapabilityKeyRegistry =>
        val !== null && typeof val === "object",
      { message: "Expected an ICapabilityKeyRegistry object" }
    ),
  /**
   * Delegation manager for creating delegations.
   * Required for generate(), optional for receive().
   */
  delegationManager: z
    .unknown()
    .refine(
      (val): val is DelegationManager =>
        val === undefined || (val !== null && typeof val === "object"),
      { message: "Expected a DelegationManager object or undefined" }
    )
    .optional(),
  /** Factory for creating KV service instances */
  createKVService: z.unknown().refine(
    (val): val is (config: {
      hosts: string[];
      session: ServiceSession;
      invoke: InvokeFunction;
      fetch?: FetchFunction;
      pathPrefix?: string;
    }) => IKVService => typeof val === "function",
    { message: "Expected a createKVService factory function" }
  ),
  /** Base URL for sharing links (e.g., "https://share.myapp.com") */
  baseUrl: z.string().optional(),
  /**
   * Custom delegation creation function.
   */
  createDelegation: z
    .unknown()
    .refine((val) => val === undefined || typeof val === "function", {
      message: "Expected a createDelegation function or undefined",
    })
    .optional(),
  /**
   * WASM function for client-side delegation creation.
   */
  createDelegationWasm: z
    .unknown()
    .refine((val) => val === undefined || typeof val === "function", {
      message: "Expected a createDelegationWasm function or undefined",
    })
    .optional(),
  /** CID computation used to verify transportable child delegations. */
  computeCid: z
    .unknown()
    .refine((val): val is (data: Uint8Array, codec: bigint) => string => val === undefined || typeof val === "function", {
      message: "Expected a computeCid function or undefined",
    })
    .optional(),
  /**
   * Path prefix for KV operations.
   */
  pathPrefix: z.string().optional(),
  /**
   * Session expiry time.
   */
  sessionExpiry: z.date().optional(),
  /**
   * Callback to create a DIRECT delegation from wallet to share key.
   * This is the preferred method for long-lived share links because it
   * bypasses the session delegation chain entirely.
   */
  onRootDelegationNeeded: z
    .unknown()
    .refine((val) => val === undefined || typeof val === "function", {
      message: "Expected an onRootDelegationNeeded function or undefined",
    })
    .optional(),
});

export type SharingServiceConfig = z.infer<typeof SharingServiceConfigSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validates encoded share data from a decoded link.
 *
 * @param data - Unknown data to validate (from JSON.parse)
 * @returns Result with validated data or validation error
 *
 * @example
 * ```typescript
 * const parsed = JSON.parse(base64UrlDecode(linkData));
 * const result = validateEncodedShareData(parsed);
 * if (!result.ok) {
 *   return result; // Forward the error
 * }
 * const shareData = result.data;
 * ```
 */
export function validateEncodedShareData(
  data: unknown
): Result<EncodedShareData, DelegationError> {
  const result = EncodedShareDataSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: DelegationErrorCodes.VALIDATION_ERROR,
        message: `Invalid share data: ${result.error.message}`,
        service: "delegation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validates receive options.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateReceiveOptions(
  data: unknown
): Result<ReceiveOptions, DelegationError> {
  const result = ReceiveOptionsSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: DelegationErrorCodes.VALIDATION_ERROR,
        message: `Invalid receive options: ${result.error.message}`,
        service: "delegation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validates SharingService configuration.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 */
export function validateSharingServiceConfig(
  data: unknown
): Result<SharingServiceConfig, DelegationError> {
  const result = SharingServiceConfigSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: DelegationErrorCodes.VALIDATION_ERROR,
        message: `Invalid SharingService config: ${result.error.message}`,
        service: "delegation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}
