/**
 * Zod schemas for delegation management types.
 *
 * These schemas provide runtime validation for delegation, capability key management,
 * and sharing link functionality. Types are derived from schemas using z.infer<>.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type {
  FetchFunction,
  InvokeFunction,
  ServiceSession,
} from "@tinycloud/sdk-services";

// =============================================================================
// Result Type (Generic)
// =============================================================================

/**
 * Creates a Result schema for a given data type and error type.
 * Result types provide explicit error handling instead of throwing.
 */
export function createResultSchema<T extends z.ZodTypeAny, E extends z.ZodTypeAny>(
  dataSchema: T,
  errorSchema: E
) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: errorSchema }),
  ]);
}

/**
 * Result type pattern for delegation operations.
 */
export type Result<T, E = DelegationError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

// =============================================================================
// JWK Type (JSON Web Key)
// =============================================================================

/**
 * JSON Web Key representation for cryptographic keys.
 * Follows the JWK specification (RFC 7517).
 */
export const JWKSchema = z.object({
  /** Key type (e.g., "EC", "RSA", "OKP") */
  kty: z.string(),
  /** Curve for EC/OKP keys (e.g., "P-256", "Ed25519") */
  crv: z.string().optional(),
  /** X coordinate for EC keys, public key for OKP */
  x: z.string().optional(),
  /** Y coordinate for EC keys */
  y: z.string().optional(),
  /** Private key value (d parameter) */
  d: z.string().optional(),
  /** Public exponent for RSA keys */
  e: z.string().optional(),
  /** Modulus for RSA keys */
  n: z.string().optional(),
  /** Key ID */
  kid: z.string().optional(),
  /** Algorithm */
  alg: z.string().optional(),
  /** Key use (e.g., "sig", "enc") */
  use: z.string().optional(),
  /** Key operations (e.g., ["sign", "verify"]) */
  key_ops: z.array(z.string()).optional(),
});

export type JWK = z.infer<typeof JWKSchema>;

// =============================================================================
// Key Management Types
// =============================================================================

/**
 * Type of key in the capability registry.
 */
export const KeyTypeSchema = z.enum(["main", "session", "ingested"]);
export type KeyType = z.infer<typeof KeyTypeSchema>;

/**
 * Information about a cryptographic key used for delegations.
 */
export const KeyInfoSchema = z.object({
  /** Unique identifier for this key */
  id: z.string(),
  /** DID associated with this key */
  did: z.string(),
  /** Type of key determining its authority level */
  type: KeyTypeSchema,
  /** Private key in JWK format */
  jwk: JWKSchema.optional(),
  /** Priority for key selection (lower = higher priority) */
  priority: z.number(),
});

export type KeyInfo = z.infer<typeof KeyInfoSchema>;

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error type for delegation operations.
 */
export const DelegationErrorSchema = z.object({
  /** Error code for programmatic handling */
  code: z.string(),
  /** Human-readable error message */
  message: z.string(),
  /** The service that produced the error */
  service: z.literal("delegation"),
  /** Original error if wrapping another error */
  cause: z.instanceof(Error).optional(),
  /** Additional metadata about the error */
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type DelegationError = z.infer<typeof DelegationErrorSchema>;

/**
 * Error codes for delegation operations.
 */
export const DelegationErrorCodes = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  NOT_FOUND: "NOT_FOUND",
  REVOKED: "REVOKED",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  ABORTED: "ABORTED",
  INVALID_INPUT: "INVALID_INPUT",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CREATION_FAILED: "CREATION_FAILED",
  REVOCATION_FAILED: "REVOCATION_FAILED",
  INVALID_TOKEN: "INVALID_TOKEN",
  KV_SERVICE_UNAVAILABLE: "KV_SERVICE_UNAVAILABLE",
  DATA_FETCH_FAILED: "DATA_FETCH_FAILED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type DelegationErrorCode =
  (typeof DelegationErrorCodes)[keyof typeof DelegationErrorCodes];

// =============================================================================
// Delegation Types
// =============================================================================

/**
 * Represents a delegation from one DID to another.
 */
export const DelegationSchema = z.object({
  /** Content identifier (CID) of the delegation */
  cid: z.string(),
  /** DID of the delegate (the party receiving the delegation) */
  delegateDID: z.string(),
  /** Space ID this delegation applies to */
  spaceId: z.string(),
  /** Resource path this delegation grants access to */
  path: z.string(),
  /** Actions this delegation authorizes */
  actions: z.array(z.string()),
  /** When this delegation expires (accepts Date or ISO string from JSON) */
  expiry: z.coerce.date(),
  /** Whether this delegation has been revoked */
  isRevoked: z.boolean(),
  /** DID of the delegator (the party granting the delegation) */
  delegatorDID: z.string().optional(),
  /** When this delegation was created (accepts Date or ISO string from JSON) */
  createdAt: z.coerce.date().optional(),
  /** Parent delegation CID if this is a sub-delegation */
  parentCid: z.string().optional(),
  /** Whether sub-delegation is allowed */
  allowSubDelegation: z.boolean().optional(),
  /** Authorization header (UCAN bearer token) */
  authHeader: z.string().optional(),
});

export type Delegation = z.infer<typeof DelegationSchema>;

/**
 * Entry in the capability registry mapping a capability to available keys.
 */
export const CapabilityEntrySchema = z.object({
  /** Resource URI this capability applies to */
  resource: z.string(),
  /** Action this capability authorizes */
  action: z.string(),
  /** Keys that can exercise this capability, ordered by priority */
  keys: z.array(KeyInfoSchema),
  /** The delegation that grants this capability */
  delegation: DelegationSchema,
  /** When this capability expires (accepts Date or ISO string from JSON) */
  expiresAt: z.coerce.date().optional(),
});

export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

/**
 * Persistent record of a delegation stored in the system.
 */
export const DelegationRecordSchema = z.object({
  /** Content identifier (CID) of the delegation */
  cid: z.string(),
  /** Space ID this delegation applies to */
  spaceId: z.string(),
  /** DID of the delegator (grantor) */
  delegator: z.string(),
  /** DID of the delegatee (recipient) */
  delegatee: z.string(),
  /** Key ID used to sign/exercise this delegation */
  keyId: z.string().optional(),
  /** Resource path pattern this delegation grants access to */
  path: z.string(),
  /** Actions this delegation authorizes */
  actions: z.array(z.string()),
  /** When this delegation expires (accepts Date or ISO string from JSON) */
  expiry: z.coerce.date().optional(),
  /** When this delegation becomes valid (not before) (accepts Date or ISO string) */
  notBefore: z.coerce.date().optional(),
  /** Whether this delegation has been revoked */
  isRevoked: z.boolean(),
  /** When this delegation was created (accepts Date or ISO string from JSON) */
  createdAt: z.coerce.date(),
  /** Parent delegation CID if this is a sub-delegation */
  parentCid: z.string().optional(),
});

export type DelegationRecord = z.infer<typeof DelegationRecordSchema>;

/**
 * Parameters for creating a new delegation.
 */
export const CreateDelegationParamsSchema = z.object({
  /** DID of the delegate (the party receiving the delegation) */
  delegateDID: z.string(),
  /** Resource path this delegation grants access to */
  path: z.string(),
  /** Actions to authorize */
  actions: z.array(z.string()),
  /** When this delegation expires (accepts Date or ISO string) */
  expiry: z.coerce.date().optional(),
  /** Whether to disable sub-delegation */
  disableSubDelegation: z.boolean().optional(),
  /** Optional statement for the SIWE message */
  statement: z.string().optional(),
});

export type CreateDelegationParams = z.infer<typeof CreateDelegationParamsSchema>;

/**
 * A chain of delegations from root to leaf (array format).
 */
export const DelegationChainSchema = z.array(DelegationSchema);
export type DelegationChain = z.infer<typeof DelegationChainSchema>;

/**
 * Structured delegation chain (v2 spec).
 */
export const DelegationChainV2Schema = z.object({
  /** The root delegation from the original authority */
  root: DelegationSchema,
  /** Intermediate delegations in the chain (may be empty) */
  chain: z.array(DelegationSchema),
  /** The final delegation to the current user */
  leaf: DelegationSchema,
});

export type DelegationChainV2 = z.infer<typeof DelegationChainV2Schema>;

// =============================================================================
// Filtering and Query Types
// =============================================================================

/**
 * Direction of delegation to filter by.
 */
export const DelegationDirectionSchema = z.enum(["granted", "received", "all"]);
export type DelegationDirection = z.infer<typeof DelegationDirectionSchema>;

/**
 * Filters for listing delegations.
 */
export const DelegationFiltersSchema = z.object({
  /** Filter by delegation direction */
  direction: DelegationDirectionSchema.optional(),
  /** Filter by resource path pattern */
  path: z.string().optional(),
  /** Filter by required actions */
  actions: z.array(z.string()).optional(),
  /** Include revoked delegations */
  includeRevoked: z.boolean().optional(),
  /** Filter by delegator DID */
  delegator: z.string().optional(),
  /** Filter by delegatee DID */
  delegatee: z.string().optional(),
  /** Only include delegations valid at this time */
  validAt: z.coerce.date().optional(),
  /** Maximum number of results to return */
  limit: z.number().optional(),
  /** Cursor for pagination */
  cursor: z.string().optional(),
});

export type DelegationFilters = z.infer<typeof DelegationFiltersSchema>;

// =============================================================================
// Space Types
// =============================================================================

/**
 * Type of space ownership.
 */
export const SpaceOwnershipSchema = z.enum(["owned", "delegated"]);
export type SpaceOwnership = z.infer<typeof SpaceOwnershipSchema>;

/**
 * Information about a space the user has access to.
 */
export const SpaceInfoSchema = z.object({
  /** Space identifier */
  id: z.string(),
  /** Human-readable name for the space */
  name: z.string().optional(),
  /** DID of the space owner */
  owner: z.string(),
  /** Whether user owns or has delegated access */
  type: SpaceOwnershipSchema,
  /** Permissions the user has in this space */
  permissions: z.array(z.string()).optional(),
  /** When the access expires (for delegated spaces) */
  expiresAt: z.coerce.date().optional(),
});

export type SpaceInfo = z.infer<typeof SpaceInfoSchema>;

// =============================================================================
// Share Link Types
// =============================================================================

/**
 * Schema for encoding share link data.
 */
export const ShareSchemaSchema = z.enum(["base64", "compact", "ipfs"]);
export type ShareSchema = z.infer<typeof ShareSchemaSchema>;

/**
 * A shareable link containing delegation credentials.
 */
export const ShareLinkSchema = z.object({
  /** Unique token identifying this share link */
  token: z.string(),
  /** Full URL for sharing */
  url: z.string(),
  /** The delegation this link grants access to */
  delegation: DelegationSchema,
  /** Encoding schema used for the link */
  schema: ShareSchemaSchema,
  /** When this share link expires */
  expiresAt: z.coerce.date().optional(),
  /** Human-readable description of what is being shared */
  description: z.string().optional(),
});

export type ShareLink = z.infer<typeof ShareLinkSchema>;

/**
 * Data retrieved from a share link.
 */
export function createShareLinkDataSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    /** The retrieved data */
    data: dataSchema,
    /** The delegation that authorized this access */
    delegation: DelegationSchema,
    /** The space the data belongs to */
    spaceId: z.string(),
    /** The resource path that was accessed */
    path: z.string(),
  });
}

export const ShareLinkDataSchema = createShareLinkDataSchema(z.unknown());
export type ShareLinkData<T = unknown> = {
  data: T;
  delegation: Delegation;
  spaceId: string;
  path: string;
};

// =============================================================================
// Ingestion Types
// =============================================================================

/**
 * Options for ingesting an external delegation.
 */
export const IngestOptionsSchema = z.object({
  /** Whether to persist the delegation to storage */
  persist: z.boolean().optional(),
  /** Whether to validate the full delegation chain */
  validateChain: z.boolean().optional(),
  /** Name for the ingested key */
  keyName: z.string().optional(),
  /** Whether to create a session key for this delegation */
  createSessionKey: z.boolean().optional(),
  /** Override the priority for the ingested key */
  priority: z.number().optional(),
});

export type IngestOptions = z.infer<typeof IngestOptionsSchema>;

// =============================================================================
// Parameter Types
// =============================================================================

/**
 * Parameters for generating a share link.
 */
export const GenerateShareParamsSchema = z.object({
  /** Resource path to share */
  path: z.string(),
  /** Actions to authorize */
  actions: z.array(z.string()).optional(),
  /** When the share link expires */
  expiry: z.coerce.date().optional(),
  /** Encoding schema for the link */
  schema: ShareSchemaSchema.optional(),
  /** Human-readable description */
  description: z.string().optional(),
  /** Base URL for the share link */
  baseUrl: z.string().optional(),
});

export type GenerateShareParams = z.infer<typeof GenerateShareParamsSchema>;

// =============================================================================
// Configuration Types
// =============================================================================

// Note: These types include functions and external types which cannot be fully validated at runtime.
// We use z.unknown().refine() for runtime type checking while preserving TypeScript types.

/**
 * Configuration for DelegationManager.
 * Note: ServiceSession, InvokeFunction, and FetchFunction are external types.
 */
export const DelegationManagerConfigSchema = z.object({
  /** TinyCloud host URLs */
  hosts: z.array(z.string()),
  /** Active session for authentication */
  session: z.unknown().refine(
    (val): val is ServiceSession => val !== null && typeof val === "object",
    { message: "Expected a ServiceSession object" }
  ),
  /** Platform-specific invoke function */
  invoke: z.unknown().refine(
    (val): val is InvokeFunction => typeof val === "function",
    { message: "Expected an invoke function" }
  ),
  /** Optional custom fetch implementation */
  fetch: z.unknown().refine(
    (val): val is FetchFunction => val === undefined || typeof val === "function",
    { message: "Expected a fetch function or undefined" }
  ).optional(),
});

export type DelegationManagerConfig = z.infer<typeof DelegationManagerConfigSchema>;

/**
 * Provider interface for cryptographic key operations.
 */
export const KeyProviderSchema = z.object({
  /** Generate a new session key, returns key ID */
  createSessionKey: z.unknown().refine(
    (val): val is (name: string) => Promise<string> => typeof val === "function",
    { message: "Expected a function" }
  ),
  /** Get JWK for a key */
  getJWK: z.unknown().refine(
    (val): val is (keyId: string) => object => typeof val === "function",
    { message: "Expected a function" }
  ),
  /** Get DID for a key */
  getDID: z.unknown().refine(
    (val): val is (keyId: string) => Promise<string> => typeof val === "function",
    { message: "Expected a function" }
  ),
});

export type KeyProvider = z.infer<typeof KeyProviderSchema>;

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Response from the delegation API.
 */
export const DelegationApiResponseSchema = z.object({
  /** SIWE message content */
  siwe: z.string(),
  /** Signature of the SIWE message */
  signature: z.string(),
  /** Delegation version */
  version: z.number(),
  /** CID of the created delegation */
  cid: z.string().optional(),
});

export type DelegationApiResponse = z.infer<typeof DelegationApiResponseSchema>;

// =============================================================================
// WASM Delegation Types
// =============================================================================

/**
 * A single (service, space, path, actions) entry inside a
 * createDelegation WASM result.
 *
 * Mirrors the Rust `DelegatedResource` struct in
 * `tinycloud-sdk-wasm/src/session.rs`. Field names match the manifest
 * {@link PermissionEntry} shape so callers can reconstruct what they sent
 * without having to re-parse the UCAN.
 *
 * `service` is the short form (e.g. `"kv"`, `"sql"`) as returned by the
 * Rust layer. The SDK layer translates to the long form
 * (`"tinycloud.kv"`) when comparing against manifests.
 */
export const DelegatedResourceSchema = z.object({
  /** Short-form service name, e.g. "kv", "sql", "duckdb", "capabilities", "hooks". */
  service: z.string(),
  /** Full space id string, e.g. "tinycloud:pkh:eip155:1:0x....:default". */
  space: z.string(),
  /** Resource path; empty string when the resource URI had no path segment. */
  path: z.string(),
  /** Full-URN ability strings, e.g. ["tinycloud.kv/get", "tinycloud.kv/put"]. */
  actions: z.array(z.string()),
});

export type DelegatedResource = z.infer<typeof DelegatedResourceSchema>;

/**
 * Input parameters for the createDelegation WASM function.
 *
 * A single call may encode multiple `(service, path, actions)` entries
 * via the `abilities` map — the underlying UCAN will contain one
 * attenuation entry per `(service, path)` pair, all signed by the same
 * session key in one blob.
 *
 * The `abilities` shape is identical to what `prepareSession` accepts
 * (`Record<shortService, Record<path, actionURNs[]>>`), so manifest
 * resolution can feed both sides from one data structure.
 */
export const CreateDelegationWasmParamsSchema = z.object({
  /** The session containing delegation credentials */
  session: z.unknown().refine(
    (val): val is ServiceSession => val !== null && typeof val === "object",
    { message: "Expected a ServiceSession object" }
  ),
  /** DID of the delegate */
  delegateDID: z.string(),
  /** Space ID this delegation applies to */
  spaceId: z.string(),
  /**
   * Multi-resource abilities map: short-service → path → full-URN actions.
   * Matches the shape accepted by `prepareSession`.
   *
   * Example:
   * ```
   * {
   *   kv: {
   *     "com.listen.app/": ["tinycloud.kv/get", "tinycloud.kv/put"]
   *   },
   *   sql: {
   *     "com.listen.app/data.sqlite": ["tinycloud.sql/read"]
   *   }
   * }
   * ```
   */
  abilities: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
  /** Expiration time in seconds since Unix epoch */
  expirationSecs: z.number(),
  /** Optional not-before time in seconds since Unix epoch */
  notBeforeSecs: z.number().optional(),
});

export type CreateDelegationWasmParams = z.infer<typeof CreateDelegationWasmParamsSchema>;

/**
 * Result from the createDelegation WASM function.
 *
 * A single UCAN may cover multiple resources. The `resources` array
 * describes every `(service, space, path, actions)` entry granted, in
 * deterministic (service, path) lexicographic order (the Rust side sorts
 * the HashMap entries before signing).
 */
export const CreateDelegationWasmResultSchema = z.object({
  /** Base64url-encoded UCAN delegation */
  delegation: z.string(),
  /** CID of the delegation */
  cid: z.string(),
  /** DID of the delegate */
  delegateDID: z.string(),
  /** Expiration time */
  expiry: z.coerce.date(),
  /**
   * All (service, space, path, actions) entries granted by this delegation.
   * Always non-empty on success.
   */
  resources: z.array(DelegatedResourceSchema),
});

export type CreateDelegationWasmResult = z.infer<typeof CreateDelegationWasmResultSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validates a Delegation object and returns a Result.
 */
export function validateDelegation(data: unknown): Result<Delegation, DelegationError> {
  const result = DelegationSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: DelegationErrorCodes.VALIDATION_ERROR,
        message: result.error.message,
        service: "delegation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validates a CreateDelegationParams object and returns a Result.
 */
export function validateCreateDelegationParams(
  data: unknown
): Result<CreateDelegationParams, DelegationError> {
  const result = CreateDelegationParamsSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: DelegationErrorCodes.VALIDATION_ERROR,
        message: result.error.message,
        service: "delegation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validates a DelegationFilters object and returns a Result.
 */
export function validateDelegationFilters(
  data: unknown
): Result<DelegationFilters, DelegationError> {
  const result = DelegationFiltersSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: DelegationErrorCodes.VALIDATION_ERROR,
        message: result.error.message,
        service: "delegation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validates a ShareLink object and returns a Result.
 */
export function validateShareLink(data: unknown): Result<ShareLink, DelegationError> {
  const result = ShareLinkSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: DelegationErrorCodes.VALIDATION_ERROR,
        message: result.error.message,
        service: "delegation",
        meta: { issues: result.error.issues },
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Generic validation function factory.
 */
export function createValidator<T>(
  schema: z.ZodType<T>
): (data: unknown) => Result<T, DelegationError> {
  return (data: unknown): Result<T, DelegationError> => {
    const result = schema.safeParse(data);
    if (!result.success) {
      return {
        ok: false,
        error: {
          code: DelegationErrorCodes.VALIDATION_ERROR,
          message: result.error.message,
          service: "delegation",
          meta: { issues: result.error.issues },
        },
      };
    }
    return { ok: true, data: result.data };
  };
}
