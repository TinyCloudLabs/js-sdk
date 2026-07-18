/**
 * MockKVService - Test implementation of IKVService
 *
 * Provides an in-memory KV service for testing without network dependencies.
 */

import type {
  IKVService,
  IPrefixedKVService,
  IServiceContext,
  ServiceSession,
  Result,
  KVServiceConfig,
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
  KVResponseHeaders,
  KVSignedReadUrlResponse,
} from "@tinycloud/sdk-services";
import {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  ok,
  err,
  ErrorCodes,
  serviceError,
  PrefixedKVService,
} from "@tinycloud/sdk-services";

/**
 * Recorded operation for assertions.
 */
export interface RecordedOperation {
  type:
    | "get"
    | "put"
    | "batchPut"
    | "list"
    | "delete"
    | "head"
    | "createSignedReadUrl";
  key?: string;
  value?: unknown;
  options?: unknown;
  timestamp: number;
}

/**
 * Stored value with metadata.
 */
interface StoredValue {
  data: unknown;
  contentType: string;
  lastModified: Date;
  etag: string;
}

/**
 * Error injection configuration.
 */
export interface ErrorInjection {
  /** Key pattern to match (string for exact match, RegExp for pattern) */
  pattern: string | RegExp;
  /** Error code to return */
  code: string;
  /** Error message */
  message: string;
  /** Operation types to inject error on */
  operations?: RecordedOperation["type"][];
  /** Number of times to inject (undefined = always) */
  count?: number;
}

/**
 * Configuration for MockKVService.
 */
export interface MockKVServiceConfig extends KVServiceConfig {
  /** Initial data to populate the store */
  initialData?: Record<string, unknown>;
  /** Simulated latency in milliseconds (0 = instant) */
  latencyMs?: number;
  /** Error injections for testing error handling */
  errorInjections?: ErrorInjection[];
}

/**
 * MockKVService implements IKVService for testing.
 *
 * Features:
 * - In-memory key-value store
 * - Configurable latency simulation
 * - Error injection capability
 * - Operation tracking for assertions
 *
 * @example
 * ```typescript
 * const mockKV = new MockKVService({
 *   initialData: { 'user/settings': { theme: 'dark' } },
 *   latencyMs: 10,
 * });
 * mockKV.initialize(context);
 *
 * const result = await mockKV.get('user/settings');
 * expect(result.ok).toBe(true);
 * expect(result.data.data).toEqual({ theme: 'dark' });
 *
 * // Check operations
 * expect(mockKV.getOperations('get')).toHaveLength(1);
 * ```
 */
export class MockKVService implements IKVService {
  static readonly serviceName = "kv";

  private _config: MockKVServiceConfig;
  private _context!: IServiceContext;
  private _store: Map<string, StoredValue> = new Map();
  private _operations: RecordedOperation[] = [];
  private _errorInjections: ErrorInjection[];
  private _latencyMs: number;
  private _abortController: AbortController = new AbortController();

  constructor(config: MockKVServiceConfig = {}) {
    this._config = config;
    this._latencyMs = config.latencyMs ?? 0;
    this._errorInjections = [...(config.errorInjections ?? [])];

    // Initialize with seed data
    if (config.initialData) {
      for (const [key, value] of Object.entries(config.initialData)) {
        this._store.set(key, this.createStoredValue(value));
      }
    }
  }

  get config(): KVServiceConfig {
    return this._config;
  }

  initialize(context: IServiceContext): void {
    this._context = context;
  }

  onSessionChange(session: ServiceSession | null): void {
    // No-op for mock
  }

  onSignOut(): void {
    this._abortController.abort();
    this._abortController = new AbortController();
  }

  // ============================================================
  // KV Operations
  // ============================================================

  async get<T = unknown>(
    key: string,
    options?: KVGetOptions
  ): Promise<Result<KVResponse<T>>> {
    this.recordOperation("get", key, undefined, options);

    const fullKey = this.getFullKey(key, options?.prefix);

    // Check for error injection
    const injectedError = this.checkErrorInjection(fullKey, "get");
    if (injectedError) {
      return err(injectedError);
    }

    await this.simulateLatency();

    // Check abort
    if (options?.signal?.aborted) {
      return err(serviceError(ErrorCodes.ABORTED, "Request aborted", "kv"));
    }

    const stored = this._store.get(fullKey);
    if (!stored) {
      return err(
        serviceError(ErrorCodes.KV_NOT_FOUND, `Key not found: ${key}`, "kv")
      );
    }

    return ok({
      data: stored.data as T,
      headers: this.createHeaders(stored),
    });
  }

  async put(
    key: string,
    value: unknown,
    options?: KVPutOptions
  ): Promise<Result<KVResponse<void>>> {
    this.recordOperation("put", key, value, options);

    const fullKey = this.getFullKey(key, options?.prefix);

    // Check for error injection
    const injectedError = this.checkErrorInjection(fullKey, "put");
    if (injectedError) {
      return err(injectedError);
    }

    await this.simulateLatency();

    // Check abort
    if (options?.signal?.aborted) {
      return err(serviceError(ErrorCodes.ABORTED, "Request aborted", "kv"));
    }

    const stored = this.createStoredValue(value, options?.contentType);
    this._store.set(fullKey, stored);

    return ok({
      data: undefined as void,
      headers: this.createHeaders(stored),
    });
  }

  async batchPut(
    items: KVBatchPutItem[],
    options?: KVBatchPutOptions
  ): Promise<Result<KVBatchPutResponse>> {
    this.recordOperation("batchPut", undefined, items, options);

    if (items.length === 0) {
      return ok({ written: [], count: 0 });
    }

    const entries = items.map((item) => ({
      item,
      fullKey: this.getFullKey(item.key, options?.prefix),
    }));
    const seen = new Set<string>();

    for (const { fullKey } of entries) {
      if (seen.has(fullKey)) {
        return err(
          serviceError(
            ErrorCodes.INVALID_INPUT,
            `KV batchPut received duplicate key after prefix resolution: ${fullKey}`,
            "kv"
          )
        );
      }
      seen.add(fullKey);
    }

    for (const { fullKey } of entries) {
      const injectedError = this.checkErrorInjection(fullKey, "batchPut");
      if (injectedError) {
        return err(injectedError);
      }
    }

    await this.simulateLatency();

    // Check abort
    if (options?.signal?.aborted) {
      return err(serviceError(ErrorCodes.ABORTED, "Request aborted", "kv"));
    }

    for (const { item, fullKey } of entries) {
      this._store.set(
        fullKey,
        this.createStoredValue(item.value, item.contentType)
      );
    }

    const written = entries.map(({ fullKey }) => fullKey);
    return ok({ written, count: written.length });
  }

  async list(options?: KVListOptions): Promise<Result<KVListResponse>> {
    this.recordOperation("list", options?.prefix ?? options?.path, undefined, options);

    // Build prefix
    let prefix = options?.prefix ?? this._config.prefix ?? "";
    if (options?.path) {
      prefix = prefix ? `${prefix}/${options.path}` : options.path;
    }

    // Check for error injection
    const injectedError = this.checkErrorInjection(prefix, "list");
    if (injectedError) {
      return err(injectedError);
    }

    await this.simulateLatency();

    // Check abort
    if (options?.signal?.aborted) {
      return err(serviceError(ErrorCodes.ABORTED, "Request aborted", "kv"));
    }

    let keys = Array.from(this._store.keys());

    // Filter by prefix
    if (prefix) {
      const prefixWithSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
      keys = keys.filter((k) => k === prefix || k.startsWith(prefixWithSlash));
    }

    // Optionally remove prefix
    if (options?.removePrefix && prefix) {
      const prefixWithSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
      keys = keys.map((k) =>
        k.startsWith(prefixWithSlash) ? k.slice(prefixWithSlash.length) : k
      );
    }

    return ok({ keys });
  }

  async delete(
    key: string,
    options?: KVDeleteOptions
  ): Promise<Result<KVResponse<void>>> {
    this.recordOperation("delete", key, undefined, options);

    const fullKey = this.getFullKey(key, options?.prefix);

    // Check for error injection
    const injectedError = this.checkErrorInjection(fullKey, "delete");
    if (injectedError) {
      return err(injectedError);
    }

    await this.simulateLatency();

    // Check abort
    if (options?.signal?.aborted) {
      return err(serviceError(ErrorCodes.ABORTED, "Request aborted", "kv"));
    }

    const stored = this._store.get(fullKey);
    if (!stored) {
      return err(
        serviceError(ErrorCodes.KV_NOT_FOUND, `Key not found: ${key}`, "kv")
      );
    }

    this._store.delete(fullKey);
    return ok({
      data: undefined as void,
      headers: this.createHeaders(stored),
    });
  }

  async head(
    key: string,
    options?: KVHeadOptions
  ): Promise<Result<KVResponse<void>>> {
    this.recordOperation("head", key, undefined, options);

    const fullKey = this.getFullKey(key, options?.prefix);

    // Check for error injection
    const injectedError = this.checkErrorInjection(fullKey, "head");
    if (injectedError) {
      return err(injectedError);
    }

    await this.simulateLatency();

    // Check abort
    if (options?.signal?.aborted) {
      return err(serviceError(ErrorCodes.ABORTED, "Request aborted", "kv"));
    }

    const stored = this._store.get(fullKey);
    if (!stored) {
      return err(
        serviceError(ErrorCodes.KV_NOT_FOUND, `Key not found: ${key}`, "kv")
      );
    }

    return ok({
      data: undefined as void,
      headers: this.createHeaders(stored),
    });
  }

  async createSignedReadUrl(
    key: string,
    options?: KVCreateSignedReadUrlOptions
  ): Promise<Result<KVSignedReadUrlResponse>> {
    this.recordOperation("createSignedReadUrl", key, undefined, options);

    const fullKey = this.getFullKey(key, options?.prefix);
    const injectedError = this.checkErrorInjection(fullKey, "createSignedReadUrl");
    if (injectedError) {
      return err(injectedError);
    }

    await this.simulateLatency();

    if (options?.signal?.aborted) {
      return err(serviceError(ErrorCodes.ABORTED, "Request aborted", "kv"));
    }

    const ticketId = `mock-${encodeURIComponent(fullKey)}`;
    const relativeUrl = `/signed/kv/${ticketId}`;
    const expiresInSeconds =
      options?.expiresInSeconds ??
      Math.ceil(DEFAULT_SIGNED_READ_URL_EXPIRY_MS / 1000);

    return ok({
      url: `https://mock.tinycloud.test${relativeUrl}`,
      relativeUrl,
      ticketId,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    });
  }

  /**
   * Create a prefix-scoped view of this KV service.
   *
   * @param prefix - The prefix to apply to all operations
   * @returns A PrefixedKVService scoped to the prefix
   */
  withPrefix(prefix: string): IPrefixedKVService {
    return new PrefixedKVService(this, prefix);
  }

  // ============================================================
  // Test Helpers
  // ============================================================

  /**
   * Get all recorded operations.
   */
  getOperations(): RecordedOperation[] {
    return [...this._operations];
  }

  /**
   * Get operations filtered by type.
   */
  getOperationsByType(type: RecordedOperation["type"]): RecordedOperation[] {
    return this._operations.filter((op) => op.type === type);
  }

  /**
   * Clear recorded operations.
   */
  clearOperations(): void {
    this._operations = [];
  }

  /**
   * Get the in-memory store contents.
   */
  getStoreContents(): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const [key, stored] of this._store) {
      result.set(key, stored.data);
    }
    return result;
  }

  /**
   * Directly set a value in the store (bypasses operation recording).
   */
  setStoreValue(key: string, value: unknown): void {
    this._store.set(key, this.createStoredValue(value));
  }

  /**
   * Clear the entire store.
   */
  clearStore(): void {
    this._store.clear();
  }

  /**
   * Add an error injection.
   */
  addErrorInjection(injection: ErrorInjection): void {
    this._errorInjections.push(injection);
  }

  /**
   * Clear all error injections.
   */
  clearErrorInjections(): void {
    this._errorInjections = [];
  }

  /**
   * Set the simulated latency.
   */
  setLatency(ms: number): void {
    this._latencyMs = ms;
  }

  /**
   * Get the number of items in the store.
   */
  get storeSize(): number {
    return this._store.size;
  }

  /**
   * Check if a key exists in the store.
   */
  hasKey(key: string): boolean {
    return this._store.has(key);
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  private getFullKey(key: string, prefixOverride?: string): string {
    const prefix = prefixOverride ?? this._config.prefix ?? "";
    return prefix ? `${prefix}/${key}` : key;
  }

  private createStoredValue(
    data: unknown,
    contentType?: string
  ): StoredValue {
    return {
      data,
      contentType: contentType ?? "application/json",
      lastModified: new Date(),
      etag: `"${Date.now()}-${Math.random().toString(36).slice(2)}"`,
    };
  }

  private createHeaders(stored: StoredValue): KVResponseHeaders {
    const headersMap = new Map<string, string>([
      ["etag", stored.etag],
      ["content-type", stored.contentType],
      ["last-modified", stored.lastModified.toISOString()],
      [
        "content-length",
        String(
          typeof stored.data === "string"
            ? stored.data.length
            : JSON.stringify(stored.data).length
        ),
      ],
    ]);

    return {
      etag: stored.etag,
      contentType: stored.contentType,
      lastModified: stored.lastModified.toISOString(),
      contentLength:
        typeof stored.data === "string"
          ? stored.data.length
          : JSON.stringify(stored.data).length,
      get: (name: string) => headersMap.get(name.toLowerCase()) ?? null,
    };
  }

  private recordOperation(
    type: RecordedOperation["type"],
    key?: string,
    value?: unknown,
    options?: unknown
  ): void {
    this._operations.push({
      type,
      key,
      value,
      options,
      timestamp: Date.now(),
    });
  }

  private checkErrorInjection(
    key: string,
    operation: RecordedOperation["type"]
  ): ReturnType<typeof serviceError> | null {
    for (let i = 0; i < this._errorInjections.length; i++) {
      const injection = this._errorInjections[i];

      // Check operation type
      if (injection.operations && !injection.operations.includes(operation)) {
        continue;
      }

      // Check pattern match
      const matches =
        typeof injection.pattern === "string"
          ? key === injection.pattern || key.startsWith(injection.pattern + "/")
          : injection.pattern.test(key);

      if (matches) {
        // Decrement count if specified
        if (injection.count !== undefined) {
          injection.count--;
          if (injection.count <= 0) {
            this._errorInjections.splice(i, 1);
          }
        }

        return serviceError(injection.code, injection.message, "kv");
      }
    }

    return null;
  }

  private async simulateLatency(): Promise<void> {
    if (this._latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this._latencyMs));
    }
  }
}
