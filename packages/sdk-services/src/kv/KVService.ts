/**
 * KVService - Key-Value storage service implementation.
 *
 * Platform-agnostic KV service that works with both web-sdk and node-sdk.
 * Uses dependency injection via IServiceContext for platform dependencies.
 */

import { BaseService } from "../base/BaseService";
import {
  Result,
  ok,
  err,
  ErrorCodes,
  serviceError,
  FetchResponse,
  type InvocationFacts,
} from "../types";
import {
  authRequiredError,
  wrapError,
  storageQuotaExceededError,
  storageLimitReachedError,
  parseAuthError,
  authUnauthorizedError,
} from "../errors";
import { IKVService } from "./IKVService";
import { PrefixedKVService, IPrefixedKVService } from "./PrefixedKVService";
import {
  KVServiceConfig,
  KVGetOptions,
  KVPutOptions,
  KVListOptions,
  KVDeleteOptions,
  KVHeadOptions,
  KVResponse,
  KVListResponse,
  KVResponseHeaders,
  KVAction,
  type KVReadMode,
} from "./types";

/**
 * KV service implementation.
 *
 * Provides key-value storage operations using TinyCloud's KV API.
 * Uses the Result type pattern for explicit error handling.
 *
 * @example
 * ```typescript
 * // Register with SDK
 * const sdk = new TinyCloud({
 *   services: { kv: KVService },
 *   serviceConfigs: { kv: { prefix: 'myapp' } },
 * });
 *
 * // Use the service
 * const result = await sdk.kv.get('settings');
 * if (result.ok) {
 *   console.log(result.data.data);
 * }
 * ```
 */
export class KVService extends BaseService implements IKVService {
  /**
   * Service identifier for registration.
   */
  static readonly serviceName = "kv";

  /**
   * Service configuration.
   */
  declare protected _config: KVServiceConfig;

  /**
   * Create a new KVService instance.
   *
   * @param config - Service configuration
   */
  constructor(config: KVServiceConfig = {}) {
    super();
    this._config = config;
  }

  /**
   * Get the service configuration.
   */
  get config(): KVServiceConfig {
    return this._config;
  }

  // Parses "Used: X bytes, Limit: Y bytes" from tinycloud-node error responses
  private parseQuotaInfo(
    errorText: string
  ): { usedBytes: number; limitBytes: number } | undefined {
    const match = errorText.match(
      /Used:\s*(\d+)\s*bytes,\s*Limit:\s*(\d+)\s*bytes/i
    );
    if (match) {
      return {
        usedBytes: parseInt(match[1], 10),
        limitBytes: parseInt(match[2], 10),
      };
    }
    return undefined;
  }

  private handleQuotaErrorResponse(
    response: FetchResponse,
    errorText: string,
    key: string
  ): Result<never> | undefined {
    if (response.status === 402) {
      const quotaInfo = this.parseQuotaInfo(errorText);
      return err(
        storageQuotaExceededError(
          "kv",
          `Storage quota exceeded for key "${key}": ${errorText}`,
          {
            status: response.status,
            ...(quotaInfo
              ? { usedBytes: quotaInfo.usedBytes, limitBytes: quotaInfo.limitBytes }
              : {}),
          }
        )
      );
    }

    if (response.status === 413) {
      const quotaInfo = this.parseQuotaInfo(errorText);
      return err(
        storageLimitReachedError(
          "kv",
          `Storage limit reached for key "${key}": ${errorText}`,
          {
            status: response.status,
            ...(quotaInfo
              ? { usedBytes: quotaInfo.usedBytes, limitBytes: quotaInfo.limitBytes }
              : {}),
          }
        )
      );
    }

    return undefined;
  }

  /**
   * Get the full path with optional prefix.
   *
   * @param key - The key
   * @param prefixOverride - Optional prefix override
   * @returns The full path
   */
  private getFullPath(key: string, prefixOverride?: string): string {
    const prefix = prefixOverride ?? this._config.prefix ?? "";
    return prefix ? `${prefix}/${key}` : key;
  }

  /**
   * Get the host URL.
   */
  private get host(): string {
    return this.context.hosts[0];
  }

  /**
   * Execute an invoke operation.
   *
   * @param path - Resource path
   * @param action - KV action
   * @param body - Optional request body
   * @param signal - Optional abort signal
   * @returns Fetch response
   */
  private async invokeOperation(
    path: string,
    action: string,
    body?: Blob | string,
    signal?: AbortSignal,
    facts?: InvocationFacts
  ): Promise<FetchResponse> {
    const session = this.context.session!;
    const headers = this.context.invoke(session, "kv", path, action, facts);

    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers,
      body,
      signal: this.combineSignals(signal),
    });
  }

  /**
   * Create KVResponseHeaders from fetch response headers.
   *
   * @param headers - Fetch response headers
   * @returns KVResponseHeaders object
   */
  private createResponseHeaders(headers: {
    get(name: string): string | null;
  }): KVResponseHeaders {
    return {
      etag: headers.get("etag") ?? undefined,
      contentType: headers.get("content-type") ?? undefined,
      lastModified: headers.get("last-modified") ?? undefined,
      contentLength: headers.get("content-length")
        ? parseInt(headers.get("content-length")!, 10)
        : undefined,
      get: (name: string) => headers.get(name),
    };
  }

  private resolveReadMode(readMode?: KVReadMode): KVReadMode {
    return readMode ?? this._config.readMode ?? "canonical";
  }

  private readModeFacts(readMode: KVReadMode): InvocationFacts {
    return [
      {
        kvReadParams: {
          type: readMode,
        },
      },
    ];
  }

  /**
   * Parse response body based on content type.
   *
   * @param response - Fetch response
   * @param raw - Whether to return raw text
   * @returns Parsed data
   */
  private async parseResponse<T>(
    response: FetchResponse,
    raw: boolean = false
  ): Promise<T | undefined> {
    if (!response.ok) {
      return undefined;
    }

    if (raw) {
      return (await response.text()) as unknown as T;
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return (await response.json()) as T;
    } else if (contentType?.startsWith("text/")) {
      return (await response.text()) as unknown as T;
    }

    // No content-type header - try to parse as JSON, fall back to text
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /**
   * Get a value by key.
   */
  async get<T = unknown>(
    key: string,
    options?: KVGetOptions
  ): Promise<Result<KVResponse<T>>> {
    return this.withTelemetry("get", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }

      const path = this.getFullPath(key, options?.prefix);
      const readMode = this.resolveReadMode(options?.readMode);

      try {
        const response = await this.invokeOperation(
          path,
          KVAction.GET,
          undefined,
          options?.signal,
          this.readModeFacts(readMode)
        );

        if (!response.ok) {
          if (response.status === 401) {
            const errorText = await response.text();
            const { resource, action } = parseAuthError(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...(action && { requiredAction: action }),
              ...(resource && { resource }),
            }));
          }

          if (response.status === 404) {
            return err(
              serviceError(
                ErrorCodes.KV_NOT_FOUND,
                `Key not found: ${key}`,
                "kv"
              )
            );
          }

          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to get key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }

        const data = await this.parseResponse<T>(response, options?.raw);
        return ok({
          data: data as T,
          headers: this.createResponseHeaders(response.headers),
        });
      } catch (error) {
        return err(wrapError("kv", error));
      }
    });
  }

  /**
   * Store a value at a key.
   */
  async put(
    key: string,
    value: unknown,
    options?: KVPutOptions
  ): Promise<Result<KVResponse<void>>> {
    return this.withTelemetry("put", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }

      const path = this.getFullPath(key, options?.prefix);

      // Serialize value to string
      let body: string;
      if (typeof value === "string") {
        body = value;
      } else {
        body = JSON.stringify(value);
      }

      try {
        const response = await this.invokeOperation(
          path,
          KVAction.PUT,
          body,
          options?.signal
        );

        if (!response.ok) {
          if (response.status === 401) {
            const errorText = await response.text();
            const { resource, action } = parseAuthError(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...(action && { requiredAction: action }),
              ...(resource && { resource }),
            }));
          }

          const errorText = await response.text();

          // Check for storage quota errors (402, 413)
          const quotaError = this.handleQuotaErrorResponse(
            response,
            errorText,
            key
          );
          if (quotaError) {
            return quotaError;
          }

          return err(
            serviceError(
              ErrorCodes.KV_WRITE_FAILED,
              `Failed to put key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }

        return ok({
          data: undefined as void,
          headers: this.createResponseHeaders(response.headers),
        });
      } catch (error) {
        return err(wrapError("kv", error));
      }
    });
  }

  /**
   * List keys with optional prefix filtering.
   */
  async list(options?: KVListOptions): Promise<Result<KVListResponse>> {
    return this.withTelemetry("list", options?.prefix, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }

      // Build the path from prefix and optional path
      let listPath = options?.prefix ?? this._config.prefix ?? "";
      if (options?.path) {
        listPath = listPath ? `${listPath}/${options.path}` : options.path;
      }
      const readMode = this.resolveReadMode(options?.readMode);

      try {
        const response = await this.invokeOperation(
          listPath,
          KVAction.LIST,
          undefined,
          options?.signal,
          this.readModeFacts(readMode)
        );

        if (!response.ok) {
          if (response.status === 401) {
            const errorText = await response.text();
            const { resource, action } = parseAuthError(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...(action && { requiredAction: action }),
              ...(resource && { resource }),
            }));
          }

          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to list keys: ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }

        let keys = await this.parseResponse<string[]>(response, options?.raw);
        keys = keys ?? [];

        // Optionally remove prefix from keys
        if (options?.removePrefix && listPath) {
          const prefixWithSlash = listPath.endsWith("/")
            ? listPath
            : `${listPath}/`;
          keys = keys.map((key) =>
            key.startsWith(prefixWithSlash)
              ? key.slice(prefixWithSlash.length)
              : key
          );
        }

        return ok({ keys });
      } catch (error) {
        return err(wrapError("kv", error));
      }
    });
  }

  /**
   * Delete a key.
   */
  async delete(key: string, options?: KVDeleteOptions): Promise<Result<void>> {
    return this.withTelemetry("delete", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }

      const path = this.getFullPath(key, options?.prefix);

      try {
        const response = await this.invokeOperation(
          path,
          KVAction.DELETE,
          undefined,
          options?.signal
        );

        if (!response.ok) {
          if (response.status === 401) {
            const errorText = await response.text();
            const { resource, action } = parseAuthError(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...(action && { requiredAction: action }),
              ...(resource && { resource }),
            }));
          }

          if (response.status === 404) {
            return err(
              serviceError(
                ErrorCodes.KV_NOT_FOUND,
                `Key not found: ${key}`,
                "kv"
              )
            );
          }

          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to delete key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }

        return ok(undefined);
      } catch (error) {
        return err(wrapError("kv", error));
      }
    });
  }

  /**
   * Get metadata for a key without retrieving the value.
   */
  async head(
    key: string,
    options?: KVHeadOptions
  ): Promise<Result<KVResponse<void>>> {
    return this.withTelemetry("head", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }

      const path = this.getFullPath(key, options?.prefix);
      const readMode = this.resolveReadMode(options?.readMode);

      try {
        const response = await this.invokeOperation(
          path,
          KVAction.HEAD,
          undefined,
          options?.signal,
          this.readModeFacts(readMode)
        );

        if (!response.ok) {
          if (response.status === 401) {
            const errorText = await response.text();
            const { resource, action } = parseAuthError(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...(action && { requiredAction: action }),
              ...(resource && { resource }),
            }));
          }

          if (response.status === 404) {
            return err(
              serviceError(
                ErrorCodes.KV_NOT_FOUND,
                `Key not found: ${key}`,
                "kv"
              )
            );
          }

          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to get metadata for key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }

        return ok({
          data: undefined as void,
          headers: this.createResponseHeaders(response.headers),
        });
      } catch (error) {
        return err(wrapError("kv", error));
      }
    });
  }

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
   * ## Prefix Conventions
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
  withPrefix(prefix: string): IPrefixedKVService {
    return new PrefixedKVService(this, prefix);
  }
}
