/**
 * PrefixedKVService - A prefix-scoped view of KVService.
 *
 * Provides key-value operations scoped to a specific prefix.
 * All operations automatically prefix keys, enabling app data isolation
 * within a shared space.
 *
 * @example
 * ```typescript
 * const space = sdk.space('default');
 *
 * // Create prefix-scoped views
 * const myApp = space.kv.withPrefix('/app.myapp.com');
 * const sharedPhotos = space.kv.withPrefix('/photos');
 *
 * // Operations are automatically prefixed
 * await myApp.put('settings.json', { theme: 'dark' });
 * // -> Actually writes to: /app.myapp.com/settings.json
 *
 * await myApp.get('settings.json');
 * // -> Actually reads from: /app.myapp.com/settings.json
 *
 * await sharedPhotos.list();
 * // -> Lists: /photos/*
 *
 * // Nested prefixes
 * const settings = myApp.withPrefix('/settings');
 * await settings.get('theme.json');  // -> /app.myapp.com/settings/theme.json
 * ```
 */

import { Result } from "../types";
import {
  KVGetOptions,
  KVPutOptions,
  KVBatchPutItem,
  KVBatchPutOptions,
  KVBatchPutResponse,
  KVListOptions,
  KVDeleteOptions,
  KVHeadOptions,
  KVCreateSignedReadUrlOptions,
  KVResponse,
  KVListResponse,
  KVSignedReadUrlResponse,
} from "./types";

/**
 * Interface for prefixed KV operations.
 *
 * Provides the same operations as IKVService but scoped to a prefix.
 * Supports nested prefixes via withPrefix().
 */
export interface IPrefixedKVService {
  /**
   * The current prefix for this scoped view.
   */
  readonly prefix: string;

  /**
   * Get a value by key.
   *
   * The key is automatically prefixed with this service's prefix.
   *
   * @param key - The key to retrieve (will be prefixed)
   * @param options - Optional get configuration
   * @returns Result with the stored value and headers
   *
   * @example
   * ```typescript
   * const myApp = kv.withPrefix('/app.myapp.com');
   * const result = await myApp.get('settings.json');
   * // -> Reads from: /app.myapp.com/settings.json
   * ```
   */
  get<T = unknown>(
    key: string,
    options?: Omit<KVGetOptions, 'prefix'>
  ): Promise<Result<KVResponse<T>>>;

  /**
   * Store a value at a key.
   *
   * The key is automatically prefixed with this service's prefix.
   *
   * @param key - The key to store under (will be prefixed)
   * @param value - The value to store
   * @param options - Optional put configuration
   * @returns Result indicating success/failure
   *
   * @example
   * ```typescript
   * const myApp = kv.withPrefix('/app.myapp.com');
   * await myApp.put('settings.json', { theme: 'dark' });
   * // -> Stores at: /app.myapp.com/settings.json
   * ```
   */
  put(
    key: string,
    value: unknown,
    options?: Omit<KVPutOptions, 'prefix'>
  ): Promise<Result<KVResponse<void>>>;

  /**
   * Store multiple values within this prefix in one TinyCloud KV invocation.
   */
  batchPut(
    items: KVBatchPutItem[],
    options?: Omit<KVBatchPutOptions, 'prefix'>
  ): Promise<Result<KVBatchPutResponse>>;

  /**
   * List keys within this prefix.
   *
   * Returns keys that match the prefix, with keys returned relative
   * to the prefix when removePrefix is true (default for prefixed service).
   *
   * @param options - Optional list configuration
   * @returns Result with array of matching keys
   *
   * @example
   * ```typescript
   * const myApp = kv.withPrefix('/app.myapp.com');
   * const result = await myApp.list();
   * // -> Lists keys under: /app.myapp.com/*
   * // Returns: ['settings.json', 'data/user.json', ...]
   * ```
   */
  list(options?: Omit<KVListOptions, 'prefix'>): Promise<Result<KVListResponse>>;

  /**
   * Delete a key.
   *
   * The key is automatically prefixed with this service's prefix.
   *
   * @param key - The key to delete (will be prefixed)
   * @param options - Optional delete configuration
   * @returns Result indicating success/failure
   *
   * @example
   * ```typescript
   * const myApp = kv.withPrefix('/app.myapp.com');
   * await myApp.delete('old-settings.json');
   * // -> Deletes: /app.myapp.com/old-settings.json
   * ```
   */
  delete(key: string, options?: Omit<KVDeleteOptions, 'prefix'>): Promise<Result<void>>;

  /**
   * Get metadata for a key without retrieving the value.
   *
   * The key is automatically prefixed with this service's prefix.
   *
   * @param key - The key to check (will be prefixed)
   * @param options - Optional head configuration
   * @returns Result with headers only
   *
   * @example
   * ```typescript
   * const myApp = kv.withPrefix('/app.myapp.com');
   * const result = await myApp.head('large-file.bin');
   * // -> Gets metadata for: /app.myapp.com/large-file.bin
   * ```
   */
  head(key: string, options?: Omit<KVHeadOptions, 'prefix'>): Promise<Result<KVResponse<void>>>;

  /**
   * Create a short-lived signed URL for reading a KV object.
   *
   * The key is automatically prefixed with this service's prefix.
   *
   * @param key - The key to expose via a signed read URL (will be prefixed)
   * @param options - Optional signed URL configuration
   * @returns Result with URL and expiry metadata
   */
  createSignedReadUrl(
    key: string,
    options?: Omit<KVCreateSignedReadUrlOptions, 'prefix'>
  ): Promise<Result<KVSignedReadUrlResponse>>;

  /**
   * Create a nested prefix-scoped view.
   *
   * The subPrefix is appended to the current prefix.
   *
   * @param subPrefix - The sub-prefix to append
   * @returns A new PrefixedKVService with the combined prefix
   *
   * @example
   * ```typescript
   * const myApp = kv.withPrefix('/app.myapp.com');
   * const settings = myApp.withPrefix('/settings');
   * await settings.get('theme.json');
   * // -> Reads from: /app.myapp.com/settings/theme.json
   * ```
   */
  withPrefix(subPrefix: string): IPrefixedKVService;
}

/**
 * Interface for a KV service that supports prefix delegation.
 *
 * This is the subset of IKVService methods needed by PrefixedKVService.
 */
interface IKVServiceLike {
  get<T = unknown>(
    key: string,
    options?: KVGetOptions
  ): Promise<Result<KVResponse<T>>>;

  put(
    key: string,
    value: unknown,
    options?: KVPutOptions
  ): Promise<Result<KVResponse<void>>>;

  batchPut(
    items: KVBatchPutItem[],
    options?: KVBatchPutOptions
  ): Promise<Result<KVBatchPutResponse>>;

  list(options?: KVListOptions): Promise<Result<KVListResponse>>;

  delete(key: string, options?: KVDeleteOptions): Promise<Result<void>>;

  head(key: string, options?: KVHeadOptions): Promise<Result<KVResponse<void>>>;

  createSignedReadUrl(
    key: string,
    options?: KVCreateSignedReadUrlOptions
  ): Promise<Result<KVSignedReadUrlResponse>>;
}

/**
 * PrefixedKVService - Implementation of prefix-scoped KV operations.
 *
 * This class wraps a KVService (or another PrefixedKVService) and
 * automatically prefixes all key operations with the configured prefix.
 *
 * ## Prefix Convention
 *
 * | Pattern | Use Case | Example |
 * | -- | -- | -- |
 * | `/app.{domain}/` | App-private data | `/app.photos.xyz/settings.json` |
 * | `/{type}/` | Shared data type | `/photos/vacation.jpg` |
 * | `/.{name}/` | Hidden/system data | `/.cache/thumbnails/` |
 * | `/public/` | Explicitly shareable | `/public/profile.json` |
 *
 * @example
 * ```typescript
 * // Create from KVService
 * const prefixed = new PrefixedKVService(kvService, '/app.myapp.com');
 *
 * // Or use the withPrefix factory method on KVService
 * const prefixed = kvService.withPrefix('/app.myapp.com');
 *
 * // All operations are automatically prefixed
 * await prefixed.put('settings.json', { theme: 'dark' });
 * await prefixed.get('settings.json');
 *
 * // Nested prefixes
 * const nested = prefixed.withPrefix('/settings');
 * await nested.get('theme.json');  // -> /app.myapp.com/settings/theme.json
 * ```
 */
export class PrefixedKVService implements IPrefixedKVService {
  /**
   * The underlying KV service.
   */
  private readonly _kv: IKVServiceLike;

  /**
   * The prefix for this scoped view.
   */
  private readonly _prefix: string;

  /**
   * Create a new PrefixedKVService.
   *
   * @param kv - The underlying KV service to delegate to
   * @param prefix - The prefix to apply to all operations
   */
  constructor(kv: IKVServiceLike, prefix: string) {
    this._kv = kv;
    // Normalize prefix: ensure it doesn't end with slash
    this._prefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  }

  /**
   * The current prefix for this scoped view.
   */
  get prefix(): string {
    return this._prefix;
  }

  /**
   * Compute the full key path by combining prefix and key.
   *
   * @param key - The key to prefix
   * @returns The full path including prefix
   */
  private getFullKey(key: string): string {
    // Handle keys that start with slash
    const normalizedKey = key.startsWith('/') ? key : `/${key}`;
    return `${this._prefix}${normalizedKey}`;
  }

  /**
   * Get a value by key.
   */
  async get<T = unknown>(
    key: string,
    options?: Omit<KVGetOptions, 'prefix'>
  ): Promise<Result<KVResponse<T>>> {
    const fullKey = this.getFullKey(key);
    // Use empty prefix override to use the full key as-is
    return this._kv.get<T>(fullKey, { ...options, prefix: '' });
  }

  /**
   * Store a value at a key.
   */
  async put(
    key: string,
    value: unknown,
    options?: Omit<KVPutOptions, 'prefix'>
  ): Promise<Result<KVResponse<void>>> {
    const fullKey = this.getFullKey(key);
    return this._kv.put(fullKey, value, { ...options, prefix: '' });
  }

  /**
   * Store multiple values within this prefix in one TinyCloud KV invocation.
   */
  async batchPut(
    items: KVBatchPutItem[],
    options?: Omit<KVBatchPutOptions, 'prefix'>
  ): Promise<Result<KVBatchPutResponse>> {
    return this._kv.batchPut(
      items.map((item) => ({
        ...item,
        key: this.getFullKey(item.key),
      })),
      { ...options, prefix: '' }
    );
  }

  /**
   * List keys within this prefix.
   */
  async list(options?: Omit<KVListOptions, 'prefix'>): Promise<Result<KVListResponse>> {
    // List uses the prefix directly, and by default removes the prefix from results
    const removePrefix = options?.removePrefix ?? true;
    return this._kv.list({
      ...options,
      prefix: this._prefix,
      removePrefix,
    });
  }

  /**
   * Delete a key.
   */
  async delete(key: string, options?: Omit<KVDeleteOptions, 'prefix'>): Promise<Result<void>> {
    const fullKey = this.getFullKey(key);
    return this._kv.delete(fullKey, { ...options, prefix: '' });
  }

  /**
   * Get metadata for a key without retrieving the value.
   */
  async head(
    key: string,
    options?: Omit<KVHeadOptions, 'prefix'>
  ): Promise<Result<KVResponse<void>>> {
    const fullKey = this.getFullKey(key);
    return this._kv.head(fullKey, { ...options, prefix: '' });
  }

  /**
   * Create a short-lived signed URL for reading a KV object.
   */
  async createSignedReadUrl(
    key: string,
    options?: Omit<KVCreateSignedReadUrlOptions, 'prefix'>
  ): Promise<Result<KVSignedReadUrlResponse>> {
    const fullKey = this.getFullKey(key);
    return this._kv.createSignedReadUrl(fullKey, { ...options, prefix: '' });
  }

  /**
   * Create a nested prefix-scoped view.
   */
  withPrefix(subPrefix: string): IPrefixedKVService {
    // Normalize subPrefix
    const normalizedSubPrefix = subPrefix.startsWith('/')
      ? subPrefix
      : `/${subPrefix}`;
    const combinedPrefix = `${this._prefix}${normalizedSubPrefix}`;
    return new PrefixedKVService(this._kv, combinedPrefix);
  }
}
