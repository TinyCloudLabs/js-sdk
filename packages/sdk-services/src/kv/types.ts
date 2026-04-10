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
   * Default read mode for KV read operations.
   * Defaults to canonical, which hides quarantined keys from normal reads.
   */
  readMode?: KVReadMode;

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
 * KV read mode.
 */
export type KVReadMode = "canonical" | "provisional";

/**
 * Options for KV get operations.
 */
export interface KVGetOptions {
  /**
   * Override the default read mode for this operation.
   */
  readMode?: KVReadMode;

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
 * Options for KV list operations.
 */
export interface KVListOptions {
  /**
   * Override the default read mode for this operation.
   */
  readMode?: KVReadMode;

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
   * Override the default read mode for this operation.
   */
  readMode?: KVReadMode;

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
