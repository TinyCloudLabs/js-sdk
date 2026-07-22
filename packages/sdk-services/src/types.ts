/**
 * SDK Services - Core Types
 *
 * These types define the service architecture for TinyCloud SDK.
 * Services use dependency injection via IServiceContext for platform independence.
 */

// =============================================================================
// Result Type Pattern
// =============================================================================

/**
 * Result type for service operations.
 * Services return Result instead of throwing, making error handling explicit.
 *
 * @template T - The success data type
 * @template E - The error type (defaults to ServiceError)
 *
 * @example
 * ```typescript
 * const result = await kv.get('key');
 * if (result.ok) {
 *   console.log(result.data);
 * } else {
 *   console.error(result.error.code);
 * }
 * ```
 */
export type Result<T, E = ServiceError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/**
 * Service error with structured information.
 */
export interface ServiceError {
  /** Error code for programmatic handling (e.g., 'KV_NOT_FOUND', 'AUTH_EXPIRED') */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Service that produced the error (e.g., 'kv', 'sql') */
  service: string;
  /** Original error if this wraps another error */
  cause?: Error;
  /** Additional metadata about the error */
  meta?: Record<string, unknown>;
}

/**
 * A node-supplied permission hint after strict SDK validation. This is
 * deliberately narrower than a general capability: no wildcards, caveats,
 * descriptions, or transport metadata can cross the service boundary.
 */
export interface PermissionHint {
  readonly service: "tinycloud.kv" | "tinycloud.encryption";
  readonly space?: string;
  readonly path: string;
  readonly actions: readonly string[];
}

/**
 * Storage quota information returned with quota-related errors.
 */
export interface StorageQuotaInfo {
  usedBytes: number;
  limitBytes: number;
  service: string;
}

/**
 * Standard error codes used across services.
 */
export const ErrorCodes = {
  // Common errors
  NOT_FOUND: "NOT_FOUND",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  ABORTED: "ABORTED",
  INVALID_INPUT: "INVALID_INPUT",
  PERMISSION_DENIED: "PERMISSION_DENIED",

  // KV-specific errors
  KV_NOT_FOUND: "KV_NOT_FOUND",
  KV_WRITE_FAILED: "KV_WRITE_FAILED",
  KV_PRECONDITION_FAILED: "KV_PRECONDITION_FAILED",
  KV_CONFLICT: "KV_CONFLICT",
  KV_RESPONSE_TOO_LARGE: "KV_RESPONSE_TOO_LARGE",

  // SQL-specific errors
  SQL_ERROR: "SQL_ERROR",
  SQL_PERMISSION_DENIED: "SQL_PERMISSION_DENIED",
  SQL_DATABASE_NOT_FOUND: "SQL_DATABASE_NOT_FOUND",
  SQL_RESPONSE_TOO_LARGE: "SQL_RESPONSE_TOO_LARGE",
  SQL_QUOTA_EXCEEDED: "SQL_QUOTA_EXCEEDED",
  SQL_INVALID_STATEMENT: "SQL_INVALID_STATEMENT",
  SQL_SCHEMA_ERROR: "SQL_SCHEMA_ERROR",
  SQL_READONLY_VIOLATION: "SQL_READONLY_VIOLATION",

  // Storage quota errors
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  STORAGE_LIMIT_REACHED: "STORAGE_LIMIT_REACHED",

  // DuckDB-specific errors
  DUCKDB_ERROR: "DUCKDB_ERROR",
  DUCKDB_PERMISSION_DENIED: "DUCKDB_PERMISSION_DENIED",
  DUCKDB_DATABASE_NOT_FOUND: "DUCKDB_DATABASE_NOT_FOUND",
  DUCKDB_RESPONSE_TOO_LARGE: "DUCKDB_RESPONSE_TOO_LARGE",
  DUCKDB_QUOTA_EXCEEDED: "DUCKDB_QUOTA_EXCEEDED",
  DUCKDB_INVALID_STATEMENT: "DUCKDB_INVALID_STATEMENT",
  DUCKDB_SCHEMA_ERROR: "DUCKDB_SCHEMA_ERROR",
  DUCKDB_READONLY_VIOLATION: "DUCKDB_READONLY_VIOLATION",

  // Compute-specific errors
  COMPUTE_ERROR: "COMPUTE_ERROR",
  COMPUTE_PERMISSION_DENIED: "COMPUTE_PERMISSION_DENIED",
  COMPUTE_FUNCTION_NOT_FOUND: "COMPUTE_FUNCTION_NOT_FOUND",
  COMPUTE_QUOTA_EXCEEDED: "COMPUTE_QUOTA_EXCEEDED",
  COMPUTE_GRANT_UNAVAILABLE: "COMPUTE_GRANT_UNAVAILABLE",
  COMPUTE_BINDING_UNAVAILABLE: "COMPUTE_BINDING_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// =============================================================================
// Service Session
// =============================================================================

/**
 * Session data required for authenticated service operations.
 * Both TinyCloudSession and web-sdk Session can be cast to this interface.
 */
export interface ServiceSession {
  /** The delegation header containing the UCAN */
  delegationHeader: { Authorization: string };
  /** The delegation CID */
  delegationCid: string;
  /** The space ID for this session */
  spaceId: string;
  /** The verification method DID */
  verificationMethod: string;
  /** The session key JWK (required for invoke) */
  jwk: object;
}

// =============================================================================
// Platform Dependencies (Injected)
// =============================================================================

/**
 * Headers type - compatible with both browser and Node.js.
 */
export type ServiceHeaders = Record<string, string> | [string, string][];

/**
 * A single fact object to include in the UCAN invocation.
 * Facts are key-value objects that the server reads from the UCAN facts field.
 */
export interface InvocationFact {
  [key: string]: unknown;
}

/**
 * Facts to include in the UCAN invocation.
 * This is an array of fact objects per the UCAN spec.
 * Used to pass additional parameters that the server reads from the UCAN facts field.
 */
export type InvocationFacts = InvocationFact[];

/**
 * Invoke function signature - platform-specific implementation injected via DI.
 * Both node-sdk-wasm and web-sdk-wasm export this with identical signature.
 *
 * @param session - The service session with delegation data
 * @param service - Service name (e.g., "kv")
 * @param path - Resource path or key
 * @param action - Action to perform (e.g., "tinycloud.kv/get")
 * @param facts - Optional facts to include in the UCAN (e.g., for capabilities/read params)
 * @returns Headers to include in the request
 */
export type InvokeFunction = (
  session: ServiceSession,
  service: string,
  path: string,
  action: string,
  facts?: InvocationFacts,
) => ServiceHeaders;

/**
 * Multi-resource invocation entry.
 */
export interface InvokeAnyEntry {
  /**
   * Legacy space-scoped resource. Optional when `resource` is provided.
   */
  spaceId?: string;
  service: string;
  path: string;
  action: string;
  /** Optional raw resource URI. When set, WASM signs this URI directly. */
  resource?: string;
  /** Capability caveats that must remain on this invocation attenuation. */
  caveats?: Record<string, unknown>[];
}

/**
 * Invoke function for minting a single authorization header that covers
 * multiple capabilities across one effective invoker.
 */
export type InvokeAnyFunction = (
  session: ServiceSession,
  entries: InvokeAnyEntry[],
  facts?: InvocationFacts,
) => ServiceHeaders;

/**
 * Result of minting a delegation with a caveat map applied to every granted
 * (service, path, ability) row. Mirrors the WASM `createDelegationWithCaveat`
 * return shape (tinycloud-node's `tinycloud-sdk-wasm` crate).
 */
export interface DelegationWithCaveatResult {
  /** Base64url-encoded UCAN JWT string. */
  delegation: string;
  /** CID of the delegation. */
  cid: string;
  /** The delegate DID (recipient). */
  delegateDID: string;
  /** Expiration timestamp, seconds since epoch. */
  expiry: number;
  /** The (service, space, path, actions) entries granted. */
  resources: Array<{ service: string; space: string; path: string; actions: string[] }>;
}

/**
 * Mint a delegation where every granted (service, path, ability) row carries
 * the SAME caveat object. Platform-specific implementation injected via DI,
 * mirroring {@link InvokeFunction}. Optional: only services that need to mint
 * caveat-bearing delegations (currently the compute service's deploy-time
 * `D_fn` grant, compute-service.md §5.1/§6.2) require it.
 *
 * @param session - The current session (delegation data + jwk).
 * @param delegateDid - The recipient DID (audience of the UCAN).
 * @param spaceId - The TinyCloud user space the delegation targets.
 * @param abilities - Service -> path -> actions map (same shape as `createDelegation`).
 * @param expirationSecs - UCAN expiration, seconds since epoch.
 * @param notBeforeSecs - Optional UCAN not-before, seconds since epoch.
 * @param caveat - A single JSON object attached identically to every granted row.
 */
export type CreateDelegationWithCaveatFunction = (
  session: ServiceSession,
  delegateDid: string,
  spaceId: string,
  abilities: Record<string, Record<string, string[]>>,
  expirationSecs: number,
  notBeforeSecs: number | undefined,
  caveat: Record<string, unknown>,
) => DelegationWithCaveatResult;

/**
 * Mint a short-lived session usable ONLY for a specific, privileged ability
 * that the ambient session does NOT carry (e.g. the compute service's
 * `compute/deploy`, which is deliberately excluded from the default session
 * grant — compute-service.md §12.1 F9). The platform binding is responsible
 * for actually authorizing this out-of-band (e.g. a fresh wallet-signed
 * root delegation), submitting it to the node, and returning a
 * {@link ServiceSession}-shaped object whose `invoke`/`invokeAny` calls will
 * carry that privileged ability.
 *
 * Optional: only services with a privileged, non-ambient operation
 * (currently compute's `deploy`) require it.
 */
export type MintPrivilegedSessionFunction = (
  grant: { service: string; path: string; ability: string },
  expirySecs?: number,
) => Promise<ServiceSession>;

/**
 * Fetch request options - compatible with standard fetch API.
 */
export interface FetchRequestInit {
  method?: string;
  headers?: ServiceHeaders;
  body?: Blob | FormData | string;
  signal?: AbortSignal;
}

/**
 * Fetch response interface - compatible with standard Response.
 */
export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body?: unknown;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

/**
 * Fetch function signature - allows for custom fetch implementations.
 * Compatible with both browser fetch and Node.js fetch.
 */
export type FetchFunction = (
  url: string,
  init?: FetchRequestInit,
) => Promise<FetchResponse>;

// =============================================================================
// Retry Policy
// =============================================================================

/**
 * Configuration for automatic retry of failed requests.
 */
export interface RetryPolicy {
  /** Maximum number of attempts (including initial) */
  maxAttempts: number;
  /** Backoff strategy between retries */
  backoff: "none" | "linear" | "exponential";
  /** Base delay in milliseconds for backoff calculation */
  baseDelayMs: number;
  /** Maximum delay in milliseconds between retries */
  maxDelayMs: number;
  /** Error codes that should trigger a retry */
  retryableErrors: string[];
}

/**
 * Default retry policy.
 */
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoff: "exponential",
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryableErrors: [ErrorCodes.NETWORK_ERROR, ErrorCodes.TIMEOUT],
};

// =============================================================================
// Service Context
// =============================================================================

/**
 * Event handler function type.
 */
export type EventHandler = (data: unknown) => void;

/**
 * SDK telemetry event handler.
 */
export type TelemetryEventHandler = (event: string, data: unknown) => void;

/**
 * Default-off telemetry configuration.
 */
export type TelemetryConfig =
  | boolean
  | {
      enabled?: boolean;
      onEvent?: TelemetryEventHandler;
    };

/**
 * Service interface - base contract for all services.
 */
export interface IService {
  /** Initialize service with context */
  initialize(context: IServiceContext): void;

  /** Called when session changes (sign-in, sign-out, refresh) */
  onSessionChange(session: ServiceSession | null): void;

  /** Called when SDK signs out - should abort pending operations */
  onSignOut(): void;

  /** Service-specific configuration */
  readonly config: Record<string, unknown>;
}

/**
 * Context provided to services for accessing platform dependencies.
 * The SDK creates this context and passes it to services during initialization.
 */
export interface IServiceContext {
  // Session management
  /** Current active session, or null if not authenticated */
  readonly session: ServiceSession | null;
  /** Whether there is an active authenticated session */
  readonly isAuthenticated: boolean;

  // Platform dependencies (injected by SDK)
  /** Platform-specific invoke function from WASM binding */
  readonly invoke: InvokeFunction;
  /** Optional multi-resource invoke function */
  readonly invokeAny?: InvokeAnyFunction;
  /** Optional caveat-bearing delegation minting (compute service D_fn grant) */
  readonly createDelegationWithCaveat?: CreateDelegationWithCaveatFunction;
  /** Optional content-CID computation (compute service function CID) */
  readonly computeCid?: (data: Uint8Array, codec: bigint) => string;
  /** Optional privileged-session minting (compute service `deploy` ability) */
  readonly mintPrivilegedSession?: MintPrivilegedSessionFunction;
  /** Fetch function (defaults to globalThis.fetch) */
  readonly fetch: FetchFunction;
  /** Available TinyCloud host URLs */
  readonly hosts: string[];

  // Cross-service access
  /** Get another registered service by name */
  getService<T extends IService>(name: string): T | undefined;

  // Telemetry/Events
  /** Emit a telemetry event */
  emit(event: string, data: unknown): void;
  /** Subscribe to events */
  on(event: string, handler: EventHandler): () => void;

  // Lifecycle
  /** Abort signal that fires when SDK signs out */
  readonly abortSignal: AbortSignal;

  // Retry policy
  /** Retry policy for failed requests */
  readonly retryPolicy: RetryPolicy;
}

// =============================================================================
// Telemetry Events
// =============================================================================

/**
 * Event emitted before a service request.
 */
export interface ServiceRequestEvent {
  service: string;
  action: string;
  span?: string;
  key?: string;
  timestamp: number;
}

/**
 * Event emitted after a service response.
 */
export interface ServiceResponseEvent {
  service: string;
  action: string;
  span?: string;
  ok: boolean;
  duration: number;
  durationMs?: number;
  status?: number;
}

/**
 * Event emitted on service error.
 */
export interface ServiceErrorEvent {
  service: string;
  span?: string;
  error: ServiceError;
}

/**
 * Event emitted on retry attempt.
 */
export interface ServiceRetryEvent {
  service: string;
  attempt: number;
  maxAttempts: number;
  error: ServiceError;
}

/**
 * Generic named span event for aggregating operation timings.
 */
export interface TelemetrySpanEvent {
  span: string;
  ok: boolean;
  durationMs: number;
  service?: string;
  action?: string;
  status?: number;
  error?: ServiceError;
}

/**
 * Telemetry event names.
 */
export const TelemetryEvents = {
  SPAN: "telemetry.span",
  SERVICE_REQUEST: "service.request",
  SERVICE_RESPONSE: "service.response",
  SERVICE_ERROR: "service.error",
  SERVICE_RETRY: "service.retry",
  SESSION_CHANGED: "session.changed",
  SESSION_EXPIRED: "session.expired",
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a success result.
 */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/**
 * Create an error result.
 */
export function err<E = ServiceError>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Create a ServiceError.
 */
export function serviceError(
  code: string,
  message: string,
  service: string,
  options?: { cause?: Error; meta?: Record<string, unknown> },
): ServiceError {
  return {
    code,
    message,
    service,
    cause: options?.cause,
    meta: options?.meta,
  };
}
