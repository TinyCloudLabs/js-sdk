/**
 * KV Service Types
 *
 * Type definitions for the KV (Key-Value) service operations.
 */

import type { Result } from "../types";

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
   * Default timeout in milliseconds for each KV request, including reading
   * the response body. When it elapses the request is aborted and the
   * operation returns an `ErrorCodes.TIMEOUT` error. A per-call `timeout`
   * option overrides it. Unset (the default), `0`, or `Infinity` means no
   * timeout.
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
   * Return the raw response bytes as a Uint8Array instead of parsed/text data.
   * Use this to read back binary values (e.g. images) byte-identically. Takes
   * precedence over {@link raw}.
   */
  binary?: boolean;

  /**
   * Ask the node to reject the response when the stored value exceeds this
   * number of bytes. This bounds downloads before the response body is read.
   */
  maxResponseBytes?: number;

  /**
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
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

  /** Only write when the current object has this strong ETag. */
  ifMatch?: string;

  /** Only write when the key does not exist. */
  ifNoneMatch?: "*";

  /**
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
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
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
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
 * Response from a KV batch read. Transport or authorization failures are
 * returned by the outer Result; each requested key has its own Result so a
 * missing key does not discard successful siblings.
 */
export interface KVBatchReadResponse<T = unknown> {
  results: Array<{
    key: string;
    result: Result<KVResponse<T>>;
  }>;
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

  /** Maximum number of keys the node may return. */
  limit?: number;

  /** Opaque scope-bound cursor returned by a previous bounded list. */
  cursor?: string;

  /**
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
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

  /** Only delete when the current object has this strong ETag. */
  ifMatch?: string;

  /**
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
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
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
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
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
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

  /** True when more matching keys exist than the requested limit. */
  truncated?: boolean;

  /** Opaque cursor for the next page, when the node returned one. */
  nextCursor?: string;
}

/**
 * Options for {@link IKVService.changes}, the `tinycloud.kv/sync` change feed.
 */
export interface KVChangesOptions {
  /**
   * The space-relative KV prefix to follow, sent as the invocation path. It
   * is not joined with the service's configured prefix, and must be non-empty.
   * Prefixes match whole path segments: `notes` covers `notes` and
   * `notes/a`, while `notes/` covers everything under `notes/` but not
   * `notes` itself. The session must hold `tinycloud.kv/sync` on it by name.
   */
  prefix: string;

  /**
   * The `cursor` from the previous page. Omit it to bootstrap from the start
   * of the prefix. Opaque; never parse or build one.
   */
  cursor?: string;

  /**
   * Page size, 1 through 1000 (node default 500). A page never splits one
   * invocation's changes, so it can hold more than `limit` changes.
   */
  limit?: number;

  /**
   * CID of a never-invoked delegation carrying `tinycloud.kv/retain` on the
   * prefix. When valid, the node attests `authority.retainUntil`.
   */
  retentionGrant?: string;

  /**
   * Custom timeout for this operation in milliseconds. Overrides
   * `KVServiceConfig.timeout`; `0` disables a configured timeout.
   */
  timeout?: number;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * One key's latest state in a change feed page. Content is not included:
 * read it with `get`/`batchGet` and check it against `etag`.
 */
export type KVChange =
  | {
      key: string;
      deleted: false;
      /** The strong ETag `get` returns for this state. */
      etag: string;
      metadata: Record<string, string>;
    }
  | {
      key: string;
      deleted: true;
    };

/**
 * The node-attested window in which the caller's authority holds. Values are
 * RFC 3339 timestamps, or `null` when nothing in the chain sets one.
 */
export interface KVChangesAuthority {
  /** The latest `nbf` across the invocation's whole delegation chain. */
  notBefore: string | null;
  /** The earliest `exp` across the invocation's whole delegation chain. */
  expiresAt: string | null;
  /**
   * The earliest `exp` across a valid retention grant's own chain. `null`
   * means no retention: none was presented, or its chain sets no expiry.
   */
  retainUntil: string | null;
}

/**
 * One page of the `tinycloud.kv/sync` change feed.
 */
export interface KVChangesResponse {
  /** Each changed key's latest state, in commit order. */
  changes: KVChange[];
  /**
   * More changes are available now. A page may be empty with `more: true`;
   * keep paging with the returned cursor.
   */
  more: boolean;
  /**
   * The cursor for the next request. An empty poll returns the request's
   * cursor unchanged.
   */
  cursor: string;
  /** The node, space and prefix that served the page. */
  source: {
    nodeDid: string;
    space: string;
    prefix: string;
  };
  authority: KVChangesAuthority;
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
  /** The change feed; never implied by `*` or `tinycloud.kv/*`. */
  SYNC: "tinycloud.kv/sync",
  /** Retention attestation; presented through `retentionGrant`, never invoked or implied. */
  RETAIN: "tinycloud.kv/retain",
} as const;

export type KVActionType = (typeof KVAction)[keyof typeof KVAction];
