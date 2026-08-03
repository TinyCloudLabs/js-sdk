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
  ServiceHeaders,
} from "../types";
import {
  authRequiredError,
  wrapError,
  storageQuotaExceededError,
  storageLimitReachedError,
  parseAuthError,
  parsePermissionHintFromErrorText,
  authUnauthorizedError,
} from "../errors";
import { IKVService } from "./IKVService";
import { PrefixedKVService, IPrefixedKVService } from "./PrefixedKVService";
import {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  KVServiceConfig,
  KVGetOptions,
  KVPutOptions,
  KVBatchPutItem,
  KVBatchPutOptions,
  KVBatchPutResponse,
  KVBatchReadResponse,
  KVListOptions,
  KVDeleteOptions,
  KVHeadOptions,
  KVCreateSignedReadUrlOptions,
  KVResponse,
  KVListResponse,
  KVResponseHeaders,
  KVSignedReadUrlResponse,
  KVAction,
} from "./types";

interface SignedKvUrlNodeResponse {
  url: string;
  ticketId: string;
  expiresAt: string;
}

interface KvBatchNodeItem {
  key: string;
  ok: boolean;
  dataBase64?: string;
  headers?: Record<string, string>;
  error?: { code: string; message: string };
}

interface KvBatchNodeResponse {
  results: KvBatchNodeItem[];
}

const MAX_KV_BATCH_READ_ITEMS = 100;

function encodeKvBatchPartName(path: string): string {
  return encodeURIComponent(path).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

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
   * Classify a KV 404 by reading the response body once.
   *
   * The server returns 404 both for a genuinely missing key AND for an
   * un-hosted space (body "Space not found"). Previously get/head/delete
   * collapsed every 404 to KV_NOT_FOUND before reading the body, so an
   * un-hosted-space read was indistinguishable from a missing key. We now
   * preserve status + the "Space not found" body for the un-hosted case (so the
   * CLI/SDK can normalize it to SPACE_NOT_HOSTED, matching put/list/sql), and
   * fall through to KV_NOT_FOUND for a real missing key.
   */
  private async classifyNotFound(
    response: FetchResponse,
    key: string
  ): Promise<Result<never>> {
    const errorText = await response.text();
    if (/space not found/i.test(errorText)) {
      return err(
        serviceError(
          ErrorCodes.KV_NOT_FOUND,
          `KV ${response.status} - ${errorText}`,
          "kv",
          { meta: { status: response.status, statusText: response.statusText } }
        )
      );
    }
    return err(serviceError(ErrorCodes.KV_NOT_FOUND, `Key not found: ${key}`, "kv"));
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

  private withJsonContentType(headers: ServiceHeaders): ServiceHeaders {
    if (Array.isArray(headers)) {
      return [...headers, ["content-type", "application/json"]];
    }

    return {
      ...headers,
      "content-type": "application/json",
    };
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
    extraHeaders?: Readonly<Record<string, string>>
  ): Promise<FetchResponse> {
    const session = this.context.session!;
    const headers = this.context.invoke(
      session,
      "kv",
      path,
      action
    );

    const requestHeaders: ServiceHeaders = Array.isArray(headers)
      ? [...headers, ...Object.entries(extraHeaders ?? {})]
      : { ...headers, ...extraHeaders };

    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers: requestHeaders,
      body,
      signal: this.combineSignals(signal),
    });
  }

  /**
   * Serialize a single put value into a fetch body.
   *
   * Binary values (Blob/ArrayBuffer/typed-array, incl. Node Buffer) are sent as
   * raw bytes (as a Blob) so they round-trip byte-identically — without this a
   * Buffer would be JSON.stringify'd into `{"type":"Buffer","data":[...]}`.
   * Strings are returned unchanged (preserving prior behavior); other values are
   * JSON-encoded. `contentType` overrides the inferred type for binary values.
   */
  private serializePutValue(
    value: unknown,
    contentType?: string
  ): Blob | string {
    if (value instanceof Blob) {
      if (!contentType || value.type === contentType) {
        return value;
      }
      return new Blob([value], { type: contentType });
    }

    if (value instanceof ArrayBuffer) {
      return new Blob([value], {
        type: contentType ?? "application/octet-stream",
      });
    }

    if (ArrayBuffer.isView(value)) {
      // Pass a ranged view (honors byteOffset/byteLength so a Node Buffer backed
      // by a shared pool isn't over-read); Blob snapshots the bytes at
      // construction, so no defensive copy is needed.
      const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return new Blob([view], {
        type: contentType ?? "application/octet-stream",
      });
    }

    if (typeof value === "string") {
      return contentType ? new Blob([value], { type: contentType }) : value;
    }

    return JSON.stringify(value);
  }

  private serializeBatchPutValue(item: KVBatchPutItem): Blob {
    const contentType = item.contentType;

    if (item.value instanceof Blob) {
      if (!contentType || item.value.type === contentType) {
        return item.value;
      }
      return new Blob([item.value], { type: contentType });
    }

    if (item.value instanceof ArrayBuffer) {
      return new Blob([item.value], {
        type: contentType ?? "application/octet-stream",
      });
    }

    if (ArrayBuffer.isView(item.value)) {
      const value = item.value;
      const bytes = new Uint8Array(value.byteLength);
      bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return new Blob([bytes], {
        type: contentType ?? "application/octet-stream",
      });
    }

    if (typeof item.value === "string") {
      return new Blob([item.value], {
        type: contentType ?? "text/plain;charset=UTF-8",
      });
    }

    const json = JSON.stringify(item.value);
    if (json === undefined) {
      throw new Error(`Cannot JSON serialize KV batch value for key "${item.key}"`);
    }

    return new Blob([json], {
      type: contentType ?? "application/json",
    });
  }

  private normalizeBatchPutResponse(data: unknown): KVBatchPutResponse | undefined {
    if (!data || typeof data !== "object") {
      return undefined;
    }

    const response = data as Partial<KVBatchPutResponse>;
    if (
      !Array.isArray(response.written) ||
      !response.written.every((key) => typeof key === "string") ||
      typeof response.count !== "number"
    ) {
      return undefined;
    }

    return {
      written: response.written,
      count: response.count,
    };
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

  private createBatchResponseHeaders(
    values: Record<string, string>
  ): KVResponseHeaders {
    const normalized = new Map(
      Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])
    );
    return this.createResponseHeaders({
      get: (name) => normalized.get(name.toLowerCase()) ?? null,
    });
  }

  private parseBatchValue<T>(
    dataBase64: string,
    headers: Record<string, string>,
    raw: boolean = false,
    binary: boolean = false
  ): T {
    const encoded = globalThis.atob(dataBase64);
    const bytes = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
    if (binary) return bytes as unknown as T;

    const text = new TextDecoder().decode(bytes);
    if (raw) return text as unknown as T;
    const contentType = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-type"
    )?.[1];
    return (contentType?.includes("application/json")
      ? JSON.parse(text)
      : text) as T;
  }

  private normalizeBatchReadResponse(
    data: unknown,
    paths: string[],
    requireData: boolean
  ): KvBatchNodeResponse | undefined {
    if (!data || typeof data !== "object") return undefined;
    const response = data as Partial<KvBatchNodeResponse>;
    if (!Array.isArray(response.results) || response.results.length !== paths.length) {
      return undefined;
    }

    for (let index = 0; index < response.results.length; index++) {
      const item = response.results[index];
      if (
        !item ||
        typeof item !== "object" ||
        item.key !== paths[index] ||
        typeof item.ok !== "boolean"
      ) {
        return undefined;
      }
      if (
        item.ok &&
        (!item.headers ||
          typeof item.headers !== "object" ||
          Object.values(item.headers).some((value) => typeof value !== "string") ||
          (requireData && typeof item.dataBase64 !== "string"))
      ) {
        return undefined;
      }
      if (
        !item.ok &&
        (!item.error ||
          typeof item.error.code !== "string" ||
          typeof item.error.message !== "string")
      ) {
        return undefined;
      }
    }
    return response as KvBatchNodeResponse;
  }

  private async batchRead<T>(
    keys: string[],
    action: typeof KVAction.GET | typeof KVAction.HEAD,
    options?: KVGetOptions | KVHeadOptions
  ): Promise<Result<KVBatchReadResponse<T>>> {
    if (!this.requireAuth()) return err(authRequiredError("kv"));
    if (keys.length === 0) return ok({ results: [], count: 0 });
    if (keys.length > MAX_KV_BATCH_READ_ITEMS) {
      return err(serviceError(
        ErrorCodes.INVALID_INPUT,
        `KV batch reads accept at most ${MAX_KV_BATCH_READ_ITEMS} keys`,
        "kv"
      ));
    }
    if (keys.length === 1) {
      const key = keys[0]!;
      const result = action === KVAction.GET
        ? await this.get<T>(key, options as KVGetOptions)
        : await this.head(key, options as KVHeadOptions);
      return ok({
        results: [{ key, result: result as Result<KVResponse<T>> }],
        count: 1,
      });
    }
    if (!this.context.invokeAny) {
      return err(serviceError(
        ErrorCodes.INVALID_INPUT,
        "KV batch reads require SDK runtime support for multi-resource invocations",
        "kv"
      ));
    }

    const getOptions = action === KVAction.GET ? options as KVGetOptions : undefined;
    if (
      getOptions?.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(getOptions.maxResponseBytes) ||
        getOptions.maxResponseBytes <= 0)
    ) {
      return err(serviceError(
        ErrorCodes.INVALID_INPUT,
        "KV maxResponseBytes must be a positive safe integer",
        "kv"
      ));
    }

    const paths = keys.map((key) => this.getFullPath(key, options?.prefix));
    if (new Set(paths).size !== paths.length) {
      return err(serviceError(
        ErrorCodes.INVALID_INPUT,
        "KV batch read received duplicate keys after prefix resolution",
        "kv"
      ));
    }

    try {
      const session = this.context.session!;
      const invocationHeaders = this.context.invokeAny(
        session,
        paths.map((path) => ({
          spaceId: session.spaceId,
          service: "kv",
          path,
          action,
        }))
      );
      const limitHeaders: Record<string, string> = {};
      if (getOptions?.maxResponseBytes !== undefined) {
        limitHeaders["x-tinycloud-max-response-bytes"] = String(
          getOptions.maxResponseBytes
        );
      }
      const headers: ServiceHeaders = Array.isArray(invocationHeaders)
        ? [...invocationHeaders, ...Object.entries(limitHeaders)]
        : { ...invocationHeaders, ...limitHeaders };
      const response = await this.context.fetch(`${this.host}/invoke`, {
        method: "POST",
        headers,
        signal: this.combineSignals(options?.signal),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          const { resource, action: requiredAction } = parseAuthError(errorText);
          return err(authUnauthorizedError("kv", errorText, {
            status: response.status,
            ...(requiredAction && { requiredAction }),
            ...(resource && { resource }),
          }));
        }
        if (response.status === 413) {
          return err(serviceError(
            ErrorCodes.KV_RESPONSE_TOO_LARGE,
            "A KV batch value exceeds the requested response limit",
            "kv",
            { meta: { status: response.status, statusText: response.statusText } }
          ));
        }
        return err(serviceError(
          ErrorCodes.NETWORK_ERROR,
          `Failed to batch read ${keys.length} key(s): ${response.status} - ${errorText}`,
          "kv",
          { meta: { status: response.status, statusText: response.statusText } }
        ));
      }

      const payload = this.normalizeBatchReadResponse(
        await response.json(),
        paths,
        action === KVAction.GET
      );
      if (!payload) {
        return err(serviceError(
          ErrorCodes.NETWORK_ERROR,
          "KV batch read response did not match the requested keys",
          "kv"
        ));
      }

      const results = payload.results.map((item, index) => {
        if (!item.ok) {
          return {
            key: keys[index]!,
            result: err(serviceError(item.error!.code, item.error!.message, "kv")),
          };
        }
        const headers = item.headers!;
        const data = action === KVAction.HEAD
          ? undefined
          : this.parseBatchValue<T>(
              item.dataBase64!,
              headers,
              getOptions?.raw,
              getOptions?.binary
            );
        return {
          key: keys[index]!,
          result: ok({
            data: data as T,
            headers: this.createBatchResponseHeaders(headers),
          }),
        };
      });
      return ok({ results, count: results.length });
    } catch (error) {
      return err(wrapError("kv", error));
    }
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
    raw: boolean = false,
    binary: boolean = false
  ): Promise<T | undefined> {
    if (!response.ok) {
      return undefined;
    }

    if (binary) {
      return new Uint8Array(await response.arrayBuffer()) as unknown as T;
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

  private async createSignedReadUrlError(
    response: FetchResponse,
    key: string
  ): Promise<Result<never>> {
    let errorText = response.statusText;
    try {
      const text = await response.text();
      if (text) {
        errorText = text;
      }
    } catch {
      // Ignore secondary body read failure.
    }

    if (response.status === 401 || response.status === 403) {
      const { resource, action } = parseAuthError(errorText);
      return err(authUnauthorizedError("kv", errorText, {
        status: response.status,
        ...(action && { requiredAction: action }),
        ...(resource && { resource }),
      }));
    }

    const code =
      response.status === 400 ? ErrorCodes.INVALID_INPUT : ErrorCodes.NETWORK_ERROR;
    return err(
      serviceError(
        code,
        `Failed to create signed read URL for key "${key}": ${response.status} - ${errorText}`,
        "kv",
        { meta: { status: response.status, statusText: response.statusText } }
      )
    );
  }

  private normalizeSignedReadUrlResponse(
    data: unknown
  ): KVSignedReadUrlResponse | undefined {
    if (!data || typeof data !== "object") {
      return undefined;
    }

    const response = data as Partial<SignedKvUrlNodeResponse>;
    if (
      typeof response.url !== "string" ||
      typeof response.ticketId !== "string" ||
      typeof response.expiresAt !== "string"
    ) {
      return undefined;
    }

    return {
      url: new URL(response.url, this.host).toString(),
      relativeUrl: response.url,
      ticketId: response.ticketId,
      expiresAt: response.expiresAt,
    };
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

      if (
        options?.maxResponseBytes !== undefined &&
        (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
      ) {
        return err(serviceError(
          ErrorCodes.INVALID_INPUT,
          "KV maxResponseBytes must be a positive safe integer",
          "kv"
        ));
      }

      const path = this.getFullPath(key, options?.prefix);

      try {
        const response = await this.invokeOperation(
          path,
          KVAction.GET,
          undefined,
          options?.signal,
          options?.maxResponseBytes === undefined
            ? undefined
            : { "x-tinycloud-max-response-bytes": String(options.maxResponseBytes) }
        );

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            const errorText = await response.text();
            const { resource, action } = parseAuthError(errorText);
            const permissionHint = parsePermissionHintFromErrorText(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...(action && { requiredAction: action }),
              ...(resource && { resource }),
              ...(permissionHint === undefined ? {} : { permissionHint }),
            }));
          }

          if (response.status === 404) {
            return this.classifyNotFound(response, key);
          }

          const errorText = await response.text();
          if (response.status === 413) {
            return err(serviceError(
              ErrorCodes.KV_RESPONSE_TOO_LARGE,
              `KV value at key "${key}" exceeds the requested response limit`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            ));
          }
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to get key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }

        const data = await this.parseResponse<T>(
          response,
          options?.raw,
          options?.binary
        );
        return ok({
          data: data as T,
          headers: this.createResponseHeaders(response.headers),
        });
      } catch (error) {
        return err(wrapError("kv", error));
      }
    });
  }

  async batchGet<T = unknown>(
    keys: string[],
    options?: KVGetOptions
  ): Promise<Result<KVBatchReadResponse<T>>> {
    return this.withTelemetry("batchGet", String(keys.length), () =>
      this.batchRead<T>(keys, KVAction.GET, options)
    );
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

      if (options?.ifMatch !== undefined && options.ifNoneMatch !== undefined) {
        return err(serviceError(
          ErrorCodes.INVALID_INPUT,
          "KV put cannot combine ifMatch and ifNoneMatch",
          "kv"
        ));
      }

      const path = this.getFullPath(key, options?.prefix);

      // Serialize the value. Binary values (Blob/ArrayBuffer/typed-array/Buffer)
      // are sent as raw bytes so they round-trip byte-identically; strings are
      // sent as-is; everything else is JSON. Mirrors serializeBatchPutValue.
      const body = this.serializePutValue(value, options?.contentType);

      try {
        const response = await this.invokeOperation(
          path,
          KVAction.PUT,
          body,
          options?.signal,
          {
            ...(options?.ifMatch === undefined ? {} : { "if-match": options.ifMatch }),
            ...(options?.ifNoneMatch === undefined ? {} : { "if-none-match": options.ifNoneMatch }),
          }
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

          if (response.status === 412) {
            return err(serviceError(
              ErrorCodes.KV_PRECONDITION_FAILED,
              `KV precondition failed for key "${key}"`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            ));
          }

          if (
            response.status === 503 &&
            (options?.ifMatch !== undefined || options?.ifNoneMatch !== undefined)
          ) {
            return err(serviceError(
              ErrorCodes.KV_CONFLICT,
              `Concurrent KV update conflicted for key "${key}"`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            ));
          }

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
   * Store multiple values in one TinyCloud KV invocation.
   */
  async batchPut(
    items: KVBatchPutItem[],
    options?: KVBatchPutOptions
  ): Promise<Result<KVBatchPutResponse>> {
    return this.withTelemetry("batchPut", String(items.length), async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }

      if (items.length === 0) {
        return ok({ written: [], count: 0 });
      }

      if (!this.context.invokeAny) {
        return err(
          serviceError(
            ErrorCodes.INVALID_INPUT,
            "KV batchPut requires SDK runtime support for multi-resource invocations",
            "kv"
          )
        );
      }

      const session = this.context.session!;
      const paths = items.map((item) => this.getFullPath(item.key, options?.prefix));
      const seen = new Set<string>();
      for (const path of paths) {
        if (seen.has(path)) {
          return err(
            serviceError(
              ErrorCodes.INVALID_INPUT,
              `KV batchPut received duplicate key after prefix resolution: ${path}`,
              "kv"
            )
          );
        }
        seen.add(path);
      }

      // Conservative: `true` means we handed a fully-constructed request to
      // fetch(). It does NOT prove bytes reached the node — DNS/connect
      // failures and synchronous fetch rejections are included. Proving
      // actual dispatch requires lower-level transport instrumentation (out
      // of scope). The over-approximation is intentional and bounded: it can
      // only cause a reconciliation of at most N idempotent, byte-identical
      // overwrites — never a corrupted or differently-timestamped record.
      let requestMayHaveDispatched = false;
      try {
        const body = new FormData();
        for (let index = 0; index < items.length; index++) {
          body.append(
            encodeKvBatchPartName(paths[index]!),
            this.serializeBatchPutValue(items[index]!)
          );
        }

        const headers = this.context.invokeAny(
          session,
          paths.map((path) => ({
            spaceId: session.spaceId,
            service: "kv",
            path,
            action: KVAction.PUT,
          }))
        );

        const url = `${this.host}/invoke`;
        const init = {
          method: "POST",
          headers,
          body,
          signal: this.combineSignals(options?.signal),
        };

        // Resolve the fetch function to a local BEFORE flipping the flag.
        // `this.context.fetch` is a getter (context.ts:154-156) that can
        // itself throw (assertActive()) — if the flag were set first, that
        // throw would be mislabeled as "may have dispatched" even though no
        // request was ever handed to a transport (Sol B2).
        const fetchFn = this.context.fetch;
        requestMayHaveDispatched = true;
        const response = await fetchFn(url, init);

        if (!response.ok) {
          let errorText: string;
          try {
            errorText = await response.text();
          } catch (textError) {
            // A response was received — the status is known and
            // authoritative — but its body could not be read. Falling
            // through to the generic catch below would report
            // NETWORK_ERROR + requestMayHaveDispatched: true, which the
            // allow-list treats as ambiguous regardless of status. That
            // would turn a deterministic 4xx (nothing written) into a false
            // ambiguity (Sol B4). Classify by status alone instead; whether
            // this is later reconciled is still governed solely by
            // AMBIGUOUS_WRITE_STATUSES, exactly like the body-readable path.
            //
            // Sol B2 (round 2): preserve the underlying rejection instead of
            // discarding it — a bare `catch {}` here would make a
            // body-read failure silently invisible, which is exactly the
            // debugging trap the no-swallowed-errors rule exists to
            // prevent.
            const cause = textError instanceof Error ? textError : new Error(String(textError));
            return err(
              serviceError(
                ErrorCodes.KV_WRITE_FAILED,
                `Failed to batch put ${items.length} key(s): ${response.status} - <response body could not be read: ${cause.message}>`,
                "kv",
                { cause, meta: { status: response.status, statusText: response.statusText } }
              )
            );
          }

          if (response.status === 401 || response.status === 403) {
            const { resource, action } = parseAuthError(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...(action && { requiredAction: action }),
              ...(resource && { resource }),
            }));
          }

          const quotaError = this.handleQuotaErrorResponse(
            response,
            errorText,
            "batch"
          );
          if (quotaError) {
            return quotaError;
          }

          return err(
            serviceError(
              ErrorCodes.KV_WRITE_FAILED,
              `Failed to batch put ${items.length} key(s): ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }

        let rawBody: unknown;
        try {
          rawBody = await response.json();
        } catch (jsonError) {
          // A 2xx response whose body isn't valid JSON is precisely the
          // unconfirmed-2xx case — the node answered success but the write
          // set can't be confirmed. Falling through to the generic catch
          // below would carry only `requestMayHaveDispatched`, omitting
          // `responseReceived`/`status`/`outcome`, so this must be classified
          // here with the identical metadata block used by the two sibling
          // unconfirmed branches (Sol B3).
          //
          // Sol B2 (round 2): preserve the underlying rejection instead of
          // discarding it — a bare `catch {}` here would make a
          // JSON-parse failure silently invisible, which is exactly the
          // debugging trap the no-swallowed-errors rule exists to
          // prevent.
          const cause = jsonError instanceof Error ? jsonError : new Error(String(jsonError));
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `KV batchPut response was not valid JSON: ${cause.message}`,
              "kv",
              {
                cause,
                meta: {
                  requestMayHaveDispatched: true,
                  responseReceived: true,
                  status: response.status,
                  outcome: "batch-unconfirmed",
                },
              }
            )
          );
        }

        const batchResponse = this.normalizeBatchPutResponse(rawBody);
        if (!batchResponse) {
          // The code stays NETWORK_ERROR deliberately: adding a member to
          // ErrorCodes (types.ts:73-115) widens the exported ErrorCode union
          // (:117) and would break consumers with exhaustive switches. The
          // node answered 2xx (the write very likely landed) but the body
          // could not confirm it, so the ambiguity is carried in metadata
          // instead of a dedicated code.
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              "KV batchPut response did not include matching written keys and count",
              "kv",
              {
                meta: {
                  requestMayHaveDispatched: true,
                  responseReceived: true,
                  status: response.status,
                  outcome: "batch-unconfirmed",
                },
              }
            )
          );
        }

        // Validate against the exact requested path set, not just internal
        // self-consistency (count === written.length would accept a
        // malformed response that reports the right count for the wrong
        // keys, e.g. a partial write padded to look complete).
        const requestedPaths = new Set(paths);
        const writtenPaths = new Set(batchResponse.written);
        const matchesRequest =
          batchResponse.count === paths.length &&
          batchResponse.written.length === paths.length &&
          writtenPaths.size === paths.length &&
          batchResponse.written.every((key) => requestedPaths.has(key));

        if (!matchesRequest) {
          // Same rationale as above: NETWORK_ERROR is kept and the
          // ambiguity is carried in meta rather than a new ErrorCodes member.
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `KV batchPut response did not confirm all ${paths.length} requested key(s) were written`,
              "kv",
              {
                meta: {
                  requestMayHaveDispatched: true,
                  responseReceived: true,
                  status: response.status,
                  outcome: "batch-unconfirmed",
                },
              }
            )
          );
        }

        return ok(batchResponse);
      } catch (error) {
        const wrapped = wrapError("kv", error);
        return err({
          ...wrapped,
          meta: { ...wrapped.meta, requestMayHaveDispatched },
        });
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

      if (
        options?.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)
      ) {
        return err(serviceError(
          ErrorCodes.INVALID_INPUT,
          "KV list limit must be an integer from 1 through 1000",
          "kv"
        ));
      }

      // Build the path from prefix and optional path
      let listPath = options?.prefix ?? this._config.prefix ?? "";
      if (options?.path) {
        listPath = listPath ? `${listPath}/${options.path}` : options.path;
      }

      try {
        const response = await this.invokeOperation(
          listPath,
          KVAction.LIST,
          undefined,
          options?.signal,
          options?.limit === undefined && options?.cursor === undefined
            ? undefined
            : {
                ...(options?.limit === undefined ? {} : { "x-tinycloud-limit": String(options.limit) }),
                ...(options?.cursor === undefined ? {} : { "x-tinycloud-cursor": options.cursor }),
              }
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

        return ok({
          keys,
          ...(response.headers.get("x-tinycloud-truncated") === null
            ? {}
            : { truncated: response.headers.get("x-tinycloud-truncated") === "true" }),
          ...(response.headers.get("x-tinycloud-next-cursor") === null
            ? {}
            : { nextCursor: response.headers.get("x-tinycloud-next-cursor") ?? undefined }),
        });
      } catch (error) {
        return err(wrapError("kv", error));
      }
    });
  }

  /**
   * Delete a key.
   */
  async delete(
    key: string,
    options?: KVDeleteOptions
  ): Promise<Result<KVResponse<void>>> {
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
          options?.signal,
          options?.ifMatch === undefined
            ? undefined
            : { "if-match": options.ifMatch }
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
            return this.classifyNotFound(response, key);
          }

          const errorText = await response.text();
          if (response.status === 412) {
            return err(serviceError(
              ErrorCodes.KV_PRECONDITION_FAILED,
              `KV precondition failed for key "${key}"`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            ));
          }
          if (response.status === 503 && options?.ifMatch !== undefined) {
            return err(serviceError(
              ErrorCodes.KV_CONFLICT,
              `Concurrent KV delete conflicted for key "${key}"`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            ));
          }
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to delete key "${key}": ${response.status} - ${errorText}`,
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

      try {
        const response = await this.invokeOperation(
          path,
          KVAction.HEAD,
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
            return this.classifyNotFound(response, key);
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

  async batchHead(
    keys: string[],
    options?: KVHeadOptions
  ): Promise<Result<KVBatchReadResponse<void>>> {
    return this.withTelemetry("batchHead", String(keys.length), () =>
      this.batchRead<void>(keys, KVAction.HEAD, options)
    );
  }

  /**
   * Create a short-lived signed URL for reading a KV object.
   */
  async createSignedReadUrl(
    key: string,
    options?: KVCreateSignedReadUrlOptions
  ): Promise<Result<KVSignedReadUrlResponse>> {
    return this.withTelemetry("createSignedReadUrl", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }

      const path = this.getFullPath(key, options?.prefix);
      const session = this.context.session!;
      const headers = this.context.invoke(
        session,
        "kv",
        path,
        KVAction.GET
      );

      const body: {
        space: string;
        path: string;
        ttl_seconds: number;
        content_hash?: string;
        etag?: string;
      } = {
        space: session.spaceId,
        path,
        ttl_seconds:
          options?.expiresInSeconds ??
          Math.ceil(DEFAULT_SIGNED_READ_URL_EXPIRY_MS / 1000),
      };

      if (options?.contentHash !== undefined) {
        body.content_hash = options.contentHash;
      }
      if (options?.etag !== undefined) {
        body.etag = options.etag;
      }

      try {
        const response = await this.context.fetch(`${this.host}/signed/kv`, {
          method: "POST",
          headers: this.withJsonContentType(headers),
          body: JSON.stringify(body),
          signal: this.combineSignals(options?.signal),
        });

        if (!response.ok) {
          return this.createSignedReadUrlError(response, key);
        }

        const signedUrl = this.normalizeSignedReadUrlResponse(
          await response.json()
        );
        if (!signedUrl) {
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              "Signed read URL response did not include url, ticketId, and expiresAt",
              "kv"
            )
          );
        }

        return ok(signedUrl);
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
