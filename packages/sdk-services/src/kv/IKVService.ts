/**
 * IKVService - Interface for KV (Key-Value) service.
 *
 * Platform-agnostic interface for key-value storage operations.
 * Implementations use dependency injection via IServiceContext.
 */

import { IService, Result } from "../types";
import type { IPrefixedKVService } from "./PrefixedKVService";
import {
  KVServiceConfig,
  KVGetOptions,
  KVPutOptions,
  KVBatchPutItem,
  KVBatchPutOptions,
  KVBatchPutResponse,
  KVBatchReadResponse,
  KVListOptions,
  KVListMatchingOptions,
  KVChangesOptions,
  KVChangesResponse,
  KVDeleteOptions,
  KVHeadOptions,
  KVCreateSignedReadUrlOptions,
  KVResponse,
  KVListResponse,
  KVSignedReadUrlResponse,
} from "./types";

/**
 * KV service interface.
 *
 * Provides key-value storage operations with:
 * - Result type pattern (no throwing)
 * - Optional prefix namespacing
 * - Configurable timeouts
 * - Abort signal support
 *
 * @example
 * ```typescript
 * const result = await kv.get('user/settings');
 * if (result.ok) {
 *   console.log('Settings:', result.data.data);
 * } else {
 *   console.error('Error:', result.error.code);
 * }
 * ```
 */
export interface IKVService extends IService {
  /**
   * Get a value by key.
   *
   * @param key - The key to retrieve
   * @param options - Optional get configuration
   * @returns Result with the stored value and headers
   *
   * @example
   * ```typescript
   * const result = await kv.get<UserSettings>('settings');
   * if (result.ok) {
   *   const settings = result.data.data;
   *   const etag = result.data.headers.etag;
   * }
   * ```
   */
  get<T = unknown>(
    key: string,
    options?: KVGetOptions
  ): Promise<Result<KVResponse<T>>>;

  batchGet<T = unknown>(
    keys: string[],
    options?: KVGetOptions
  ): Promise<Result<KVBatchReadResponse<T>>>;

  /**
   * Store a value at a key.
   *
   * Objects are automatically JSON stringified.
   * Strings are stored as-is.
   *
   * @param key - The key to store under
   * @param value - The value to store
   * @param options - Optional put configuration
   * @returns Result indicating success/failure
   *
   * @example
   * ```typescript
   * // Store an object (auto-stringified)
   * const result = await kv.put('settings', { theme: 'dark' });
   *
   * // Store a string
   * const result = await kv.put('name', 'Alice');
   * ```
   */
  put(
    key: string,
    value: unknown,
    options?: KVPutOptions
  ): Promise<Result<KVResponse<void>>>;

  /**
   * Store multiple values in one TinyCloud KV invocation.
   *
   * The batch is authorized as one invocation containing one `tinycloud.kv/put`
   * capability per key. The node commits the whole batch or rejects it.
   *
   * @param items - Entries to write
   * @param options - Optional batch configuration
   * @returns Result with the written keys and count
   */
  batchPut(
    items: KVBatchPutItem[],
    options?: KVBatchPutOptions
  ): Promise<Result<KVBatchPutResponse>>;

  /**
   * List keys with optional prefix filtering.
   *
   * @param options - Optional list configuration
   * @returns Result with array of matching keys
   *
   * @example
   * ```typescript
   * // List all keys
   * const result = await kv.list();
   *
   * // List keys with a specific prefix
   * const result = await kv.list({ prefix: 'users/' });
   * ```
   */
  list(options?: KVListOptions): Promise<Result<KVListResponse>>;

  /**
   * List the keys that start with a *partial* path segment, e.g. every key
   * beginning `qa/b` including `qa/b00` and `qa/b01`.
   *
   * ## Why this is a helper and not a `list` option
   *
   * Since node 1.19.0 (TC-731) the node matches list prefixes on **whole path
   * segments**: `list({ prefix: 'qa/b' })` returns the key `qa/b` and
   * everything under `qa/b/`, and does **not** return `qa/b00`. This is
   * deliberate. A list *is* the authorization scope: a grant on `docs` must
   * not let its holder enumerate `docsecret/...`, and a partial-segment match
   * would disclose key names across exactly that grant boundary. (Matching is
   * also case-exact.) So the node will never do "starts with" for you, and a
   * caller that wants "names starting with X" has to do it client-side. This
   * is that client-side helper.
   *
   * ## What it does
   *
   * 1. Splits `prefix` at its last `/`. The *folder* is everything up to and
   *    including that `/` (the space root, `""`, if there is no `/`); the
   *    *partial* is the rest.
   * 2. Calls the ordinary {@link IKVService.list} on the folder, following
   *    every `nextCursor` until the node reports no more pages.
   * 3. Keeps the keys that start with `prefix` (that is, whose segment after
   *    the folder starts with the partial) and returns them as
   *    `{ keys }`, the same shape as `list`. `truncated` and `nextCursor` are
   *    never set: the result is complete, not a page.
   *
   * | `prefix`    | folder listed | partial | matches                         |
   * | ----------- | ------------- | ------- | ------------------------------- |
   * | `qa/b`      | `qa/`         | `b`     | `qa/b`, `qa/b/x`, `qa/b00`      |
   * | `qa/b/`     | `qa/b/`       | (empty) | everything under `qa/b/`        |
   * | `qa/b/c`    | `qa/b/`       | `c`     | `qa/b/c`, `qa/b/cat`, `qa/b/c/x`|
   * | `b`         | `""` (root)   | `b`     | `b`, `b/x`, `b00`               |
   * | `""`        | `""` (root)   | (empty) | every key in the space          |
   *
   * A name that matches *and* has children returns the name **and** its
   * descendants (`qa/b` and `qa/b/x` above). That is not extra logic: `list`
   * is recursive, so the folder listing already contains the descendants, and
   * the filter only looks at the prefix. Callers that want one entry per
   * name must collapse on the first segment after the folder themselves.
   *
   * ## Authorization
   *
   * The helper never widens scope. It issues only normal `list` calls on the
   * folder, so a delegated session sees exactly what its grant allows for
   * that folder. If the folder itself is outside the grant, the result is the
   * same error `list` returns for it (nothing is retried against a narrower
   * or wider prefix). Consequently a grant on `qa/b00` alone cannot use
   * `listMatching('qa/b')`: listing `qa/` is outside that grant. List the
   * folder the grant covers instead.
   *
   * ## Cost
   *
   * **It fetches every key in the folder**, page after page, then discards
   * the ones that don't match. The work is proportional to the size of the
   * *folder*, not the number of matches, and a folder with 100 000 keys takes
   * hundreds of requests even if one key matches. Page size (`limit`) tunes
   * the number of requests, not the amount of data read.
   *
   * ## When to use it
   *
   * - UI type-ahead / autocomplete over a folder of modest size.
   * - Small folders, one-off lookups, scripts and debugging.
   *
   * ## When not to
   *
   * - Large or unbounded folders, or anything on a hot path. Give the data a
   *   real folder structure instead (`users/<id>/...`, one folder per
   *   bucket/day/shard) so the thing you look up is a whole segment and a
   *   plain `list({ prefix })` answers it in one request, within the grant.
   *
   * A failed page returns that page's error and discards what was gathered so
   * far; there is no partial result. Pass `signal` to abort a long walk.
   *
   * @param prefix - Absolute key prefix, possibly ending mid-segment. Like
   *   `list({ prefix })`, it replaces the service's configured prefix rather
   *   than being appended to it.
   * @param options - Optional per-page list configuration
   * @returns Result with every key starting with `prefix`
   *
   * @example
   * ```typescript
   * // Keys: qa/b00, qa/b01, qa/c00
   * const result = await kv.listMatching('qa/b');
   * if (result.ok) {
   *   console.log(result.data.keys); // ['qa/b00', 'qa/b01']
   * }
   * ```
   */
  listMatching(
    prefix: string,
    options?: KVListMatchingOptions
  ): Promise<Result<KVListResponse>>;

  /**
   * Delete a key.
   *
   * @param key - The key to delete
   * @param options - Optional delete configuration
   * @returns Result indicating success/failure
   *
   * @example
   * ```typescript
   * const result = await kv.delete('old-key');
   * if (!result.ok && result.error.code === 'KV_NOT_FOUND') {
   *   console.log('Key already deleted');
   * }
   * ```
   */
  delete(key: string, options?: KVDeleteOptions): Promise<Result<KVResponse<void>>>;

  /**
   * Get metadata for a key without retrieving the value.
   *
   * Useful for checking if a key exists or getting headers
   * without downloading the full value.
   *
   * @param key - The key to check
   * @param options - Optional head configuration
   * @returns Result with headers only
   *
   * @example
   * ```typescript
   * const result = await kv.head('large-file');
   * if (result.ok) {
   *   console.log('Size:', result.data.headers.contentLength);
   * }
   * ```
   */
  head(key: string, options?: KVHeadOptions): Promise<Result<KVResponse<void>>>;

  batchHead(
    keys: string[],
    options?: KVHeadOptions
  ): Promise<Result<KVBatchReadResponse<void>>>;

  /**
   * Read one page of the ordered, delete-aware change feed for a KV prefix
   * (`tinycloud.kv/sync`). Each change is a key's latest state; read content
   * with `get`/`batchGet` and check it against the change's `etag`.
   *
   * `options.prefix` and every returned `key` are full paths in the space;
   * the service's configured prefix is not applied to either. On a prefixed
   * service (for example `DelegatedAccess.kv`), `get(change.key)` would join
   * that prefix twice: strip the prefix from the key, or use
   * `withPrefix(...).changes()`, which returns keys relative to the view.
   *
   * The session must hold `tinycloud.kv/sync` on `options.prefix` by name: no
   * wildcard grants it. Page with the returned `cursor` while `more` is true;
   * a page can exceed `limit`, or be empty with `more: true`.
   *
   * Errors: `KV_SYNC_RESET_REQUIRED` (410, `meta.reason`) means discard sync
   * state and restart without a cursor. `AUTH_DELEGATION_REVOKED` and
   * `AUTH_DELEGATION_ANCESTOR_REVOKED` mean the grant is revoked.
   * `KV_RETENTION_GRANT_REFUSED` (403, `meta.reason`) rejects `retentionGrant`.
   *
   * Requires a node that advertises the `kv-sync-v1` feature in `/info`.
   *
   * @example
   * ```typescript
   * let cursor: string | undefined;
   * do {
   *   const page = await kv.changes({ prefix: 'notes/', cursor });
   *   if (!page.ok) throw new Error(page.error.message);
   *   for (const change of page.data.changes) apply(change);
   *   cursor = page.data.cursor;
   *   if (!page.data.more) break;
   * } while (true);
   * ```
   */
  changes(options: KVChangesOptions): Promise<Result<KVChangesResponse>>;

  /**
   * Create a short-lived signed URL for reading a KV object.
   *
   * The request is authorized with the current session's `tinycloud.kv/get`
   * capability for the resolved key path. The returned `url` is absolute and
   * can be passed to external services that need bearer read access.
   *
   * Requires tinycloud-node with the `/signed/kv` endpoint from TC-1368.
   *
   * @param key - The key to expose via a signed read URL
   * @param options - Optional signed URL configuration
   * @returns Result with URL and expiry metadata
   */
  createSignedReadUrl(
    key: string,
    options?: KVCreateSignedReadUrlOptions
  ): Promise<Result<KVSignedReadUrlResponse>>;

  /**
   * Create a prefix-scoped view of this KV service.
   *
   * Returns a PrefixedKVService that automatically prefixes all
   * key operations with the specified prefix. This enables apps
   * to isolate their data within a shared space.
   *
   * @param prefix - The prefix to apply to all operations
   * @returns A PrefixedKVService scoped to the prefix
   *
   * @example
   * ```typescript
   * const myApp = kv.withPrefix('/app.myapp.com');
   *
   * // Operations are automatically prefixed
   * await myApp.put('settings.json', { theme: 'dark' });
   * // -> Actually writes to: /app.myapp.com/settings.json
   *
   * // Nested prefixes
   * const settings = myApp.withPrefix('/settings');
   * await settings.get('theme.json');  // -> /app.myapp.com/settings/theme.json
   * ```
   */
  withPrefix(prefix: string): IPrefixedKVService;

  /**
   * Service configuration.
   */
  readonly config: KVServiceConfig;
}
