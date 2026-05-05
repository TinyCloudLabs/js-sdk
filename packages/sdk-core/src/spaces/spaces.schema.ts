/**
 * Zod schemas for Space and SpaceService configuration types.
 *
 * These schemas provide runtime validation for space management types.
 * Types are derived from schemas using z.infer<>.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type { Result, ServiceError } from "@tinycloud/sdk-services";
import { CreateDelegationParamsSchema } from "../delegations/types.schema.js";

// =============================================================================
// Validation Error Type
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

// =============================================================================
// SpaceConfig Schema
// =============================================================================

/**
 * Configuration for creating a Space object.
 *
 * Contains the space identifier, name, and factory functions for creating
 * space-scoped services.
 */
export const SpaceConfigSchema = z.object({
  /** The space identifier (full URI) */
  id: z.string(),
  /** The short name of the space */
  name: z.string(),
  /** Factory function to create a space-scoped KV service */
  createKV: z.function(),
  /** Factory function to create a space-scoped Data Vault service */
  createVault: z.function(),
  /** Factory function to create space-scoped delegations */
  createDelegations: z.function(),
  /** Factory function to create space-scoped sharing */
  createSharing: z.function(),
  /** Function to get space info */
  getInfo: z.function(),
});

export type SpaceConfig = z.infer<typeof SpaceConfigSchema>;

// =============================================================================
// SpaceServiceConfig Schema
// =============================================================================

/**
 * Configuration for SpaceService.
 *
 * Contains all the dependencies needed for the SpaceService to manage
 * spaces, including hosts, session, and factory functions.
 */
export const SpaceServiceConfigSchema = z.object({
  /** TinyCloud host URLs */
  hosts: z.array(z.string()),
  /** Active session for authentication */
  session: z.unknown(),
  /** Platform-specific invoke function */
  invoke: z.function(),
  /** Optional custom fetch implementation */
  fetch: z.function().optional(),
  /** Optional capability key registry for delegated space discovery */
  capabilityRegistry: z.unknown().optional(),
  /** Factory function to create a space-scoped KV service */
  createKVService: z.function().optional(),
  /** Factory function to create a space-scoped Data Vault service */
  createVaultService: z.function().optional(),
  /** User's PKH DID (derived from address or provided explicitly) */
  userDid: z.string().optional(),
  /** Optional SharingService for v2 sharing links (client-side) */
  sharingService: z.unknown().optional(),
  /** Factory function to create delegations using SIWE-based flow */
  createDelegation: z.function().optional(),
});

export type SpaceServiceConfig = z.infer<typeof SpaceServiceConfigSchema>;

// =============================================================================
// SpaceDelegationParams Schema
// =============================================================================

/**
 * Parameters for creating a space-scoped delegation.
 *
 * Extends CreateDelegationParams with the spaceId field.
 */
export const SpaceDelegationParamsSchema = CreateDelegationParamsSchema.extend({
  /** The space ID to create the delegation for */
  spaceId: z.string(),
});

export type SpaceDelegationParams = z.infer<typeof SpaceDelegationParamsSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate a SpaceConfig object against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 *
 * @example
 * ```typescript
 * const result = validateSpaceConfig(config);
 * if (result.ok) {
 *   const space = new Space(result.data);
 * } else {
 *   console.error("Invalid config:", result.error.message);
 * }
 * ```
 */
export function validateSpaceConfig(
  data: unknown
): Result<SpaceConfig, ValidationError> {
  const result = SpaceConfigSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "space",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate a SpaceServiceConfig object against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 *
 * @example
 * ```typescript
 * const result = validateSpaceServiceConfig(config);
 * if (result.ok) {
 *   const service = new SpaceService(result.data);
 * } else {
 *   console.error("Invalid config:", result.error.message);
 * }
 * ```
 */
export function validateSpaceServiceConfig(
  data: unknown
): Result<SpaceServiceConfig, ValidationError> {
  const result = SpaceServiceConfigSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "space",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate a SpaceDelegationParams object against the schema.
 *
 * @param data - Unknown data to validate
 * @returns Result with validated data or validation error
 *
 * @example
 * ```typescript
 * const result = validateSpaceDelegationParams(params);
 * if (result.ok) {
 *   await createDelegation(result.data);
 * } else {
 *   console.error("Invalid params:", result.error.message);
 * }
 * ```
 */
export function validateSpaceDelegationParams(
  data: unknown
): Result<SpaceDelegationParams, ValidationError> {
  const result = SpaceDelegationParamsSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        service: "space",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

// =============================================================================
// Server Response Schemas
// =============================================================================

/**
 * Server's DelegationInfo structure (from capabilities/read response).
 * This schema validates the shape of delegation data received from the server.
 */
export const ServerDelegationInfoSchema = z.object({
  /** DID of the delegator */
  delegator: z.string(),
  /** DID of the delegate */
  delegate: z.string(),
  /** Parent delegation CIDs - accepts string or byte array format from server */
  parents: z.array(z.union([z.string(), z.array(z.number())])),
  /** Expiration time (ISO8601 string) */
  expiry: z.string().optional(),
  /** Not-before time (ISO8601 string) */
  not_before: z.string().optional(),
  /** Issued-at time (ISO8601 string) */
  issued_at: z.string().optional(),
  /** Capabilities granted by this delegation */
  capabilities: z.array(
    z.object({
      resource: z.string(),
      ability: z.string(),
    })
  ),
});

export type ServerDelegationInfo = z.infer<typeof ServerDelegationInfoSchema>;

/**
 * Server response for capabilities/read endpoint.
 * Returns a record mapping CID -> DelegationInfo.
 */
export const ServerDelegationsResponseSchema = z.record(
  z.string(),
  ServerDelegationInfoSchema
);

export type ServerDelegationsResponse = z.infer<typeof ServerDelegationsResponseSchema>;

/**
 * Server response for space/list endpoint.
 * Returns an array of owned space info.
 */
export const ServerOwnedSpaceSchema = z.object({
  /** Space identifier */
  id: z.string(),
  /** Space name (optional, can be derived from id) */
  name: z.string().optional(),
  /** Owner DID */
  owner: z.string(),
  /** Creation timestamp */
  createdAt: z.string().optional(),
});

export type ServerOwnedSpace = z.infer<typeof ServerOwnedSpaceSchema>;

export const ServerOwnedSpacesResponseSchema = z.array(ServerOwnedSpaceSchema);

export type ServerOwnedSpacesResponse = z.infer<typeof ServerOwnedSpacesResponseSchema>;

/**
 * Server response for space/create endpoint.
 */
export const ServerCreateSpaceResponseSchema = z.object({
  /** Space identifier */
  id: z.string(),
  /** Space name */
  name: z.string(),
  /** Owner DID */
  owner: z.string(),
  /** Creation timestamp */
  createdAt: z.string().optional(),
});

export type ServerCreateSpaceResponse = z.infer<typeof ServerCreateSpaceResponseSchema>;

/**
 * Server response for space/info endpoint.
 */
export const ServerSpaceInfoResponseSchema = z.object({
  /** Space identifier */
  id: z.string(),
  /** Space name (optional) */
  name: z.string().optional(),
  /** Owner DID */
  owner: z.string(),
  /** Ownership type */
  type: z.enum(["owned", "delegated"]).optional(),
  /** Permissions the user has in this space */
  permissions: z.array(z.string()).optional(),
  /** Expiration for delegated access */
  expiresAt: z.string().optional(),
});

export type ServerSpaceInfoResponse = z.infer<typeof ServerSpaceInfoResponseSchema>;

// =============================================================================
// Server Response Validation Helpers
// =============================================================================

/**
 * Validate server delegations response (capabilities/read).
 *
 * @param data - Unknown data from server
 * @returns Result with validated data or validation error
 */
export function validateServerDelegationsResponse(
  data: unknown
): Result<ServerDelegationsResponse, ValidationError> {
  // Handle null/undefined as empty response
  if (data === null || data === undefined) {
    return { ok: true, data: {} };
  }

  // Handle array format (legacy compatibility) - return as-is, validation happens elsewhere
  if (Array.isArray(data)) {
    return { ok: true, data: {} };
  }

  const result = ServerDelegationsResponseSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `Invalid server delegations response: ${result.error.message}`,
        service: "space",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate server owned spaces response (space/list).
 *
 * @param data - Unknown data from server
 * @returns Result with validated data or validation error
 */
export function validateServerOwnedSpacesResponse(
  data: unknown
): Result<ServerOwnedSpacesResponse, ValidationError> {
  const result = ServerOwnedSpacesResponseSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `Invalid server owned spaces response: ${result.error.message}`,
        service: "space",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate server create space response (space/create).
 *
 * @param data - Unknown data from server
 * @returns Result with validated data or validation error
 */
export function validateServerCreateSpaceResponse(
  data: unknown
): Result<ServerCreateSpaceResponse, ValidationError> {
  const result = ServerCreateSpaceResponseSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `Invalid server create space response: ${result.error.message}`,
        service: "space",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validate server space info response (space/info).
 *
 * @param data - Unknown data from server
 * @returns Result with validated data or validation error
 */
export function validateServerSpaceInfoResponse(
  data: unknown
): Result<ServerSpaceInfoResponse, ValidationError> {
  const result = ServerSpaceInfoResponseSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `Invalid server space info response: ${result.error.message}`,
        service: "space",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}
