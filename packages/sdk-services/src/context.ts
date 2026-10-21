/**
 * ServiceContext implementation for TinyCloud SDK Services
 * @module @tinycloud/sdk-services
 */

import {
  IServiceContext,
  IService,
  ServiceSession,
  RetryPolicy,
  InvokeFunction,
  InvokeAnyFunction,
  FetchFunction,
  FetchRequestInit,
  FetchResponse,
  defaultRetryPolicy,
  EventHandler,
  TelemetryEventHandler,
  TelemetryConfig,
} from "./types";
import { tinyCloudDebugLogger } from "./debug";
import { nodeRetryError } from "./errors";
import { abortableSleep } from "./sleep";
import { projectDiagnosticData } from "./diagnostics";
import {
  buildRequestEvent,
  byteLengthOf,
  declaredLengthOf,
  invocationMetaOf,
  rememberInvocation,
  type RequestSink,
} from "./telemetry/requestLog";

/**
 * Configuration options for ServiceContext.
 */
export interface ServiceContextConfig {
  /** Function to invoke WASM operations */
  invoke: InvokeFunction;
  /** Optional function to mint a single authorization header for multiple capabilities */
  invokeAny?: InvokeAnyFunction;
  /** Function to make HTTP requests (defaults to globalThis.fetch) */
  fetch?: FetchFunction;
  /** List of TinyCloud host URLs */
  hosts: string[];
  /** Initial session (optional) */
  session?: ServiceSession | null;
  /** Retry policy configuration */
  retryPolicy?: Partial<RetryPolicy>;
  /** Default-off telemetry event delivery. */
  telemetry?: TelemetryConfig;
  /** Developer request log; omitted when developer mode is off. */
  requestSink?: RequestSink;
}

/**
 * ServiceContext provides platform dependencies and cross-service access to services.
 * This is the primary interface services use to interact with the SDK runtime.
 *
 * @example
 * ```typescript
 * const context = new ServiceContext({
 *   invoke: wasmInvoke,
 *   hosts: ['https://node.tinycloud.xyz'],
 *   retryPolicy: { maxAttempts: 5 },
 * });
 *
 * // Register a service
 * const kvService = new KVService({});
 * context.registerService('kv', kvService);
 * kvService.initialize(context);
 *
 * // Update session when user signs in
 * context.setSession(userSession);
 * ```
 */
export class ServiceContext implements IServiceContext {
  private _session: ServiceSession | null = null;
  private _services: Map<string, IService> = new Map();
  private _eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private _abortController: AbortController = new AbortController();
  private _operationAbortSignal?: AbortSignal;
  private _retired = false;
  private readonly _invoke: InvokeFunction;
  private readonly _invokeAny?: InvokeAnyFunction;
  private readonly _fetch: FetchFunction;
  private readonly _fetchCore: FetchFunction;
  private readonly _requestSink?: RequestSink;
  private readonly _hosts: string[];
  private readonly _retryPolicy: RetryPolicy;
  private readonly _telemetryEnabled: boolean;
  private readonly _telemetryHandler?: TelemetryEventHandler;

  constructor(config: ServiceContextConfig) {
    this._requestSink = config.requestSink;
    this._invoke = this.wrapInvoke(config.invoke);
    this._invokeAny = config.invokeAny
      ? this.wrapInvokeAny(config.invokeAny)
      : undefined;
    this._fetchCore = this.wrapFetch(config.fetch ?? globalThis.fetch.bind(globalThis));
    this._fetch =
      this._requestSink === undefined ? this._fetchCore : this.recordFetch(this._fetchCore);
    this._hosts = config.hosts;
    this._session = config.session ?? null;
    this._retryPolicy = {
      ...defaultRetryPolicy,
      ...config.retryPolicy,
    };
    this._telemetryEnabled =
      typeof config.telemetry === "boolean"
        ? config.telemetry
        : config.telemetry?.enabled === true;
    this._telemetryHandler =
      typeof config.telemetry === "object" ? config.telemetry.onEvent : undefined;
  }

  // ============================================================
  // Session Management
  // ============================================================

  /**
   * Get the current session.
   */
  get session(): ServiceSession | null {
    return this._retired ? null : this._session;
  }

  /**
   * Check if the context has an authenticated session.
   */
  get isAuthenticated(): boolean {
    return !this._retired && this._session !== null;
  }

  /**
   * Update the session and notify all registered services.
   *
   * @param session - New session or null to clear
   */
  setSession(session: ServiceSession | null): void {
    this.assertActive();
    this._session = session;
    this.emit('session.changed', { authenticated: session !== null });

    // Notify all services of session change
    for (const service of this._services.values()) {
      service.onSessionChange(session);
    }
  }

  // ============================================================
  // Platform Dependencies
  // ============================================================

  /**
   * Get the invoke function for WASM operations.
   */
  get invoke(): InvokeFunction {
    this.assertActive();
    return this._invoke;
  }

  /**
   * Get the multi-resource invoke function when available.
   */
  get invokeAny(): InvokeAnyFunction | undefined {
    this.assertActive();
    return this._invokeAny;
  }

  /**
   * Get the fetch function for HTTP requests.
   */
  get fetch(): FetchFunction {
    this.assertActive();
    return this._fetch;
  }

  /**
   * The fetch function without developer request recording. Replication hands this to its own
   * inner context so each HTTP attempt is recorded once, by that context, not twice.
   */
  get unrecordedFetch(): FetchFunction {
    this.assertActive();
    return this._fetchCore;
  }

  /** The developer request sink this context records to; undefined when developer mode is off. */
  get requestSink(): RequestSink | undefined {
    return this._requestSink;
  }

  /**
   * Get the list of TinyCloud host URLs.
   */
  get hosts(): string[] {
    this.assertActive();
    return this._hosts;
  }

  // ============================================================
  // Service Registry
  // ============================================================

  /**
   * Register a service with the context.
   *
   * @param name - Service name (e.g., 'kv')
   * @param service - Service instance
   */
  registerService(name: string, service: IService): void {
    this._services.set(name, service);
  }

  /**
   * Unregister a service from the context.
   *
   * @param name - Service name to remove
   */
  unregisterService(name: string): void {
    this._services.delete(name);
  }

  /**
   * Get a registered service by name.
   *
   * @param name - Service name
   * @returns The service instance or undefined if not registered
   */
  getService<T extends IService>(name: string): T | undefined {
    return this._services.get(name) as T | undefined;
  }

  // ============================================================
  // Event System (Telemetry)
  // ============================================================

  /**
   * Emit a telemetry event.
   *
   * @param event - Event name
   * @param data - Event data
   */
  emit(event: string, data: unknown): void {
    tinyCloudDebugLogger.log(event, data);

    if (this._telemetryEnabled && this._telemetryHandler) {
      try {
        this._telemetryHandler(event, projectDiagnosticData(data));
      } catch (error) {
        // Don't let telemetry handlers break SDK operations.
        console.error(`Error in telemetry handler for "${event}":`, error);
      }
    }

    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          // Don't let event handler errors break the flow
          console.error(`Error in event handler for "${event}":`, error);
        }
      }
    }
  }

  /**
   * Subscribe to telemetry events.
   *
   * @param event - Event name to subscribe to
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on(event: string, handler: EventHandler): () => void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this._eventHandlers.get(event);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this._eventHandlers.delete(event);
        }
      }
    };
  }

  /**
   * Remove all event handlers for an event.
   *
   * @param event - Event name (if omitted, clears all events)
   */
  clearEventHandlers(event?: string): void {
    if (event) {
      this._eventHandlers.delete(event);
    } else {
      this._eventHandlers.clear();
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Get the abort signal for cancelling operations.
   */
  get abortSignal(): AbortSignal {
    return this._abortController.signal;
  }

  get operationAbortSignal(): AbortSignal | undefined {
    return this._operationAbortSignal;
  }

  setOperationAbortSignal(signal: AbortSignal | undefined): void {
    this._operationAbortSignal = signal;
  }
  /**
   * Permanently retire this graph after its owner installs a replacement.
   * Unlike `abort()`, retirement never creates a fresh controller, so captured
   * services cannot resume calls under a superseded session.
   */
  retire(): void {
    if (this._retired) return;
    this._retired = true;
    this._session = null;
    this._abortController.abort();
    for (const service of this._services.values()) {
      // User-provided services are part of the retired graph, but their
      // cleanup must never make installing the replacement graph fail.
      try {
        service.onSignOut();
      } catch (error) {
        console.error("Error retiring service:", error);
      }
    }
  }

  /**
   * Abort all pending operations and notify services.
   * Creates a new AbortController for future operations.
   */
  abort(): void {
    // A retired graph must never receive a fresh abort signal. Captured
    // services retain this context, so recreating its controller would make a
    // stale graph look live to custom cleanup code.
    if (this._retired) return;
    this._abortController.abort();
    this._abortController = new AbortController();

    // Notify all services
    for (const service of this._services.values()) {
      try {
        service.onSignOut();
      } catch (error) {
        console.error("Error signing out service:", error);
      }
    }
  }

  /**
   * Sign out - abort operations and clear session.
   */
  signOut(): void {
    if (this._retired) return;
    this.abort();
    this.setSession(null);
    this.emit('session.expired', {});
  }

  // ============================================================
  // Retry Policy
  // ============================================================

  /**
   * Get the retry policy configuration.
   */
  get retryPolicy(): RetryPolicy {
    return this._retryPolicy;
  }

  private traceInvoke(invoke: InvokeFunction): InvokeFunction {
    return (session, service, path, action, facts) => {
      this.assertActive();
      if (!tinyCloudDebugLogger.isEnabled()) {
        return invoke(session, service, path, action, facts);
      }

      const timer = tinyCloudDebugLogger.startTimer("sdk.invoke", {
        service,
        path,
        action,
        facts,
      });

      try {
        const result = invoke(session, service, path, action, facts);
        timer.stop({ ok: true, service, path, action });
        return result;
      } catch (error) {
        timer.stop({ ok: false, service, path, action, error });
        throw error;
      }
    };
  }

  private wrapInvoke(invoke: InvokeFunction): InvokeFunction {
    const traced = this.traceInvoke(invoke);
    if (this._requestSink === undefined) return traced;
    return (session, service, path, action, facts) => {
      const headers = traced(session, service, path, action, facts);
      rememberInvocation(headers, { service, path, action, spaceId: session.spaceId });
      return headers;
    };
  }

  private assertActive(): void {
    if (this._retired) {
      throw new Error("Service graph has been retired: its session was replaced or signed out.");
    }
  }

  private traceInvokeAny(invokeAny: InvokeAnyFunction): InvokeAnyFunction {
    return (session, entries, facts) => {
      this.assertActive();
      if (!tinyCloudDebugLogger.isEnabled()) {
        return invokeAny(session, entries, facts);
      }

      const timer = tinyCloudDebugLogger.startTimer("sdk.invokeAny", {
        entries,
        facts,
      });

      try {
        const result = invokeAny(session, entries, facts);
        timer.stop({ ok: true, entries });
        return result;
      } catch (error) {
        timer.stop({ ok: false, entries, error });
        throw error;
      }
    };
  }

  private wrapInvokeAny(invokeAny: InvokeAnyFunction): InvokeAnyFunction {
    const traced = this.traceInvokeAny(invokeAny);
    if (this._requestSink === undefined) return traced;
    return (session, entries, facts) => {
      const headers = traced(session, entries, facts);
      const first = entries[0];
      if (first !== undefined) {
        rememberInvocation(headers, {
          service: first.service,
          path: first.path,
          action: first.action,
          spaceId: first.spaceId ?? session.spaceId,
        });
      }
      return headers;
    };
  }

  /** Retry `NODE_BUSY` / `REQUEST_TIMEOUT`; `build` must re-sign per attempt (the node 409s a repeated invocation). */
  async invokeWithRetry(
    url: string,
    build: () => FetchRequestInit | Promise<FetchRequestInit>,
  ): Promise<FetchResponse> {
    this.assertActive();
    if (this._requestSink === undefined) return this.sendWithRetry(url, build, { attempts: 0 });
    const at = Date.now();
    const clock = performance.now();
    const tally = { attempts: 0 };
    let first: FetchRequestInit | undefined;
    let response: FetchResponse | undefined;
    try {
      response = await this.sendWithRetry(url, async () => {
        const init = await build();
        first ??= init;
        return init;
      }, tally);
      return response;
    } finally {
      this.logRequest({ url, init: first, response, attempts: tally.attempts, at, clock });
    }
  }

  private async sendWithRetry(
    url: string,
    build: () => FetchRequestInit | Promise<FetchRequestInit>,
    tally: { attempts: number },
  ): Promise<FetchResponse> {
    const policy = this._retryPolicy;
    const startedAt = Date.now();
    let backoffMs = 0;
    let signal: AbortSignal | undefined;
    for (let attempt = 1; ; attempt++) {
      const init = await build();
      signal ??= this.combineSignals(init.signal);
      tally.attempts = attempt;
      const response = await this._fetchCore(url, init);
      const done = (): FetchResponse => {
        try { response.retry = { attempts: attempt, backoffMs }; } catch { /* frozen custom response */ }
        return response;
      };
      if (attempt >= policy.maxAttempts || response.status !== 503 || !response.clone) return done();
      const text = await response.clone().text().catch(() => "");
      const error = nodeRetryError("", "", response, text);
      if (!error || error.meta?.retryable !== true || !policy.retryableErrors.includes(error.code)) {
        return done();
      }
      const remaining = (policy.maxTotalMs ?? Infinity) - (Date.now() - startedAt);
      if (remaining <= 0) return done();
      const retryAfterMs = error.meta.retryAfterMs;
      const step = Math.min(
        policy.maxDelayMs,
        policy.backoff === "exponential"
          ? policy.baseDelayMs * 2 ** (attempt - 1)
          : policy.backoff === "linear"
            ? policy.baseDelayMs * attempt
            : 0,
      );
      const delay = Math.min(
        typeof retryAfterMs === "number" ? retryAfterMs : Math.random() * step,
        remaining,
      );
      (response.body as { cancel?(): Promise<unknown> } | undefined)?.cancel?.()?.catch?.(() => {});
      await abortableSleep(delay, signal);
      if (signal.aborted) throw signal.reason;
      backoffMs += delay;
    }
  }

  private wrapFetch(fetchFn: FetchFunction): FetchFunction {
    return async (url, init) => {
      this.assertActive();
      const request = {
        ...init,
        signal: this.combineSignals(init?.signal),
      };
      if (!tinyCloudDebugLogger.isEnabled()) {
        return fetchFn(url, request);
      }

      const meta = { url, method: request.method ?? "GET" };
      const timer = tinyCloudDebugLogger.startTimer("sdk.fetch", { ...meta, init: request });

      try {
        const response = await fetchFn(url, request);
        timer.stop({
          ...meta,
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
        });
        return response;
      } catch (error) {
        timer.stop({ ...meta, ok: false, error });
        throw error;
      }
    };
  }

  /** Direct `fetch` calls; retry loops are logged once by `invokeWithRetry`. */
  private recordFetch(fetchFn: FetchFunction): FetchFunction {
    return async (url, init) => {
      const at = Date.now();
      const clock = performance.now();
      let response: FetchResponse | undefined;
      try {
        response = await fetchFn(url, init);
        return response;
      } finally {
        this.logRequest({ url, init, response, at, clock });
      }
    };
  }

  /** Never throws: logging must not change a request's outcome. */
  private logRequest(sample: {
    url: string;
    init?: FetchRequestInit;
    response?: FetchResponse;
    at: number;
    clock: number;
    attempts?: number;
  }): void {
    const sink = this._requestSink;
    if (sink === undefined) return;
    try {
      const { url, init, response } = sample;
      const meta = invocationMetaOf(init?.headers);
      const declared = declaredLengthOf(response?.headers.get("content-length"));
      sink.record(
        buildRequestEvent({
          service: meta?.service ?? "other",
          op: meta ? `${meta.service}/${meta.action.split("/").pop() ?? meta.action}` : "other",
          path: meta?.path ?? null,
          spaceId: meta?.spaceId ?? null,
          url,
          bytes: byteLengthOf(init?.body) ?? declared,
          durationMs: performance.now() - sample.clock,
          attempts: sample.attempts ?? 1,
          ok: response?.ok === true,
          code: response === undefined ? "ERROR" : response.ok ? "ok" : `HTTP_${response.status}`,
          at: sample.at,
        }),
      );
    } catch {
      /* logging never changes the request's outcome */
    }
  }

  private combineSignals(signal?: AbortSignal): AbortSignal {
    if (!signal) return this._abortController.signal;
    const combined = new AbortController();
    const abort = (source: AbortSignal) => combined.abort(source.reason);
    if (signal.aborted) {
      abort(signal);
    } else if (this._abortController.signal.aborted) {
      abort(this._abortController.signal);
    } else {
      signal.addEventListener("abort", () => abort(signal), { once: true });
      this._abortController.signal.addEventListener(
        "abort",
        () => abort(this._abortController.signal),
        { once: true },
      );
    }
    return combined.signal;
  }
}

