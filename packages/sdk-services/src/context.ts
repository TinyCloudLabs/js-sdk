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
  defaultRetryPolicy,
  EventHandler,
  TelemetryEventHandler,
  TelemetryConfig,
} from "./types";
import { tinyCloudDebugLogger } from "./debug";
import { projectDiagnosticData } from "./diagnostics";

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
  private _retired = false;
  private readonly _invoke: InvokeFunction;
  private readonly _invokeAny?: InvokeAnyFunction;
  private readonly _fetch: FetchFunction;
  private readonly _hosts: string[];
  private readonly _retryPolicy: RetryPolicy;
  private readonly _telemetryEnabled: boolean;
  private readonly _telemetryHandler?: TelemetryEventHandler;

  constructor(config: ServiceContextConfig) {
    this._invoke = this.wrapInvoke(config.invoke);
    this._invokeAny = config.invokeAny
      ? this.wrapInvokeAny(config.invokeAny)
      : undefined;
    this._fetch = this.wrapFetch(config.fetch ?? globalThis.fetch.bind(globalThis));
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

  private wrapInvoke(invoke: InvokeFunction): InvokeFunction {
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

  private assertActive(): void {
    if (this._retired) {
      throw new Error("Service graph has been retired by session replacement.");
    }
  }

  private wrapInvokeAny(invokeAny: InvokeAnyFunction): InvokeAnyFunction {
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

      const timer = tinyCloudDebugLogger.startTimer("sdk.fetch", {
        url,
        method: request.method ?? "GET",
        init: request,
      });

      try {
        const response = await fetchFn(url, request);
        timer.stop({
          ok: response.ok,
          url,
          method: request.method ?? "GET",
          status: response.status,
          statusText: response.statusText,
        });
        return response;
      } catch (error) {
        timer.stop({
          ok: false,
          url,
          method: request.method ?? "GET",
          error,
        });
        throw error;
      }
    };
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
