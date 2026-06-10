/**
 * KV Service Types
 *
 * Type definitions for the KV (Key-Value) service operations.
 */

/**
 * Configuration for KVService.
 */
export interface KVServiceConfig {
  /**
   * Default prefix for all keys.
   * Useful for namespacing data within a space.
   *
   * @example
   * ```typescript
   * const kv = new KVService({ prefix: 'myapp/settings' });
   * await kv.put('theme', 'dark'); // Stores at 'myapp/settings/theme'
   * ```
   */
  prefix?: string;

  /**
   * Default timeout in milliseconds for KV operations.
   * Overrides the context-level timeout if set.
   */
  timeout?: number;

  /** Allow additional config properties */
  [key: string]: unknown;
}

/**
 * Options for KV get operations.
 */
export interface KVGetOptions {
  /**
   * Override the default prefix for this operation.
   */
  prefix?: string;

  /**
   * Return raw response instead of parsed JSON.
   * When true, data will be the raw response text.
   */
  raw?: boolean;

  /**
   * Custom timeout for this operation in milliseconds.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Options for KV put operations.
 */
export interface KVPutOptions {
  /**
   * Override the default prefix for this operation.
   */
  prefix?: string;

  /**
   * Content type for the value.
   * Defaults to 'application/json' for objects.
   */
  contentType?: string;

  /**
   * Custom metadata headers to store with the value.
   */
  metadata?: Record<string, string>;

  /**
   * Custom timeout for this operation in milliseconds.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * One entry in a KV batch put request.
 */
export interface KVBatchPutItem {
  /**
   * The key to store under.
   */
  key: string;

  /**
   * The value to store.
   *
   * Objects are JSON stringified. Strings are stored as text. Binary values
   * should be supplied as Blob, ArrayBuffer, or Uint8Array.
   */
  value: unknown;

  /**
   * Content type for this item. Defaults to application/json for objects and
   * application/octet-stream for binary values.
   */
  contentType?: string;
}

/**
 * Options for KV batch put operations.
 */
export interface KVBatchPutOptions {
  /**
   * Override the default prefix for all entries in this batch.
   */
  prefix?: string;

  /**
   * Custom timeout for this operation in milliseconds.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Response from KV batch put operations.
 */
export interface KVBatchPutResponse {
  /**
   * Keys successfully written by the batch.
   */
  written: string[];

  /**
   * Number of written keys.
   */
  count: number;
}

/**
 * Options for KV list operations.
 */
export interface KVListOptions {
  /**
   * Override the default prefix for this operation.
   */
  prefix?: string;

  /**
   * Additional path to append to the prefix.
   */
  path?: string;

  /**
   * Whether to remove the prefix from returned keys.
   * When true, keys are returned relative to the prefix.
   */
  removePrefix?: boolean;

  /**
   * Return raw response instead of parsed JSON.
   */
  raw?: boolean;

  /**
   * Custom timeout for this operation in milliseconds.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Options for KV delete operations.
 */
export interface KVDeleteOptions {
  /**
   * Override the default prefix for this operation.
   */
  prefix?: string;

  /**
   * Custom timeout for this operation in milliseconds.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Options for KV head (metadata) operations.
 */
export interface KVHeadOptions {
  /**
   * Override the default prefix for this operation.
   */
  prefix?: string;

  /**
   * Custom timeout for this operation in milliseconds.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Default lifetime for signed KV read URLs when a caller omits expiresInSeconds.
 * SDK duration defaults are stored in milliseconds; createSignedReadUrl converts
 * this to the node endpoint's ttl_seconds field.
 *
 * Keep this in sync with EXPIRY.SIGNED_READ_URL_MS in @tinycloud/sdk-core.
 * sdk-services cannot import sdk-core because sdk-core depends on sdk-services.
 */
export const DEFAULT_SIGNED_READ_URL_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Options for creating a signed KV read URL.
 */
export interface KVCreateSignedReadUrlOptions {
  /**
   * Override the default prefix for this operation.
   */
  prefix?: string;

  /**
   * Requested URL lifetime in seconds.
   * Defaults to {@link DEFAULT_SIGNED_READ_URL_EXPIRY_MS} converted to seconds.
   * The node may cap this by its configured maximum, the invocation expiry,
   * or the parent delegation expiry.
   */
  expiresInSeconds?: number;

  /**
   * Optional blake3 content hash to bind the signed URL to a specific object.
   */
  contentHash?: string;

  /**
   * Optional ETag to bind the signed URL to a specific object version.
   */
  etag?: string;

  /**
   * Custom timeout for this operation in milliseconds.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Response headers from KV operations.
 */
export interface KVResponseHeaders {
  /**
   * ETag for conditional requests.
   */
  etag?: string;

  /**
   * Content type of the stored value.
   */
  contentType?: string;

  /**
   * Last modification timestamp.
   */
  lastModified?: string;

  /**
   * Content length in bytes.
   */
  contentLength?: number;

  /**
   * Get a header value by name.
   * @param name - Header name (case-insensitive)
   */
  get(name: string): string | null;
}

/**
 * Response from KV get/put operations.
 *
 * @template T - Type of the data payload
 */
export interface KVResponse<T = unknown> {
  /**
   * The data payload.
   * For get: the stored value.
   * For put: undefined.
   */
  data: T;

  /**
   * Response headers with metadata.
   */
  headers: KVResponseHeaders;
}

/**
 * Response from KV list operations.
 */
export interface KVListResponse {
  /**
   * Array of keys matching the list criteria.
   */
  keys: string[];
}

/**
 * Response from signed KV read URL creation.
 */
export interface KVSignedReadUrlResponse {
  /**
   * Absolute URL suitable for passing to external readers.
   */
  url: string;

  /**
   * Opaque URL returned by tinycloud-node, usually relative to the node host.
   */
  relativeUrl: string;

  /**
   * Opaque signed KV ticket identifier.
   */
  ticketId: string;

  /**
   * Expiry timestamp as returned by tinycloud-node.
   */
  expiresAt: string;
}

/**
 * KV service action types.
 */
export const KVAction = {
  GET: "tinycloud.kv/get",
  PUT: "tinycloud.kv/put",
  LIST: "tinycloud.kv/list",
  DELETE: "tinycloud.kv/del",
  HEAD: "tinycloud.kv/metadata",
} as const;

export type KVActionType = (typeof KVAction)[keyof typeof KVAction];
