/**
 * BaseService - Abstract base class for all TinyCloud services.
 *
 * Provides common functionality:
 * - Context management
 * - Session lifecycle hooks
 * - Abort signal handling
 * - Telemetry emission
 */

import {
  IService,
  IServiceContext,
  ServiceSession,
  ServiceError,
  TelemetryEvents,
  err,
  Result,
} from "../types";
import { authRequiredError, wrapError, RequestTimeoutError } from "../errors";
import type { RequestSignal } from "./types";

/** setTimeout's delay is a signed 32-bit integer; larger values fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Abstract base class for TinyCloud services.
 *
 * Services extend this class to get common functionality like
 * context management, session lifecycle, and abort handling.
 *
 * @example
 * ```typescript
 * class MyService extends BaseService implements IMyService {
 *   static readonly serviceName = 'myservice';
 *
 *   constructor(config: MyServiceConfig = {}) {
 *     super();
 *     this._config = config;
 *   }
 *
 *   async doSomething(): Promise<Result<Data>> {
 *     if (!this.requireAuth()) {
 *       return err(authRequiredError('myservice'));
 *     }
 *     // ... implementation
 *   }
 * }
 * ```
 */
export abstract class BaseService implements IService {
  /**
   * Service identifier used for registration.
   * Must be overridden by subclasses.
   */
  static readonly serviceName: string;

  /**
   * Service context providing access to platform dependencies.
   * Set during initialize().
   */
  protected context!: IServiceContext;

  /**
   * Abort controller for this service's operations.
   * Reset on sign-out.
   */
  protected abortController: AbortController = new AbortController();

  /**
   * Service-specific configuration.
   */
  protected _config: Record<string, unknown> = {};

  /**
   * Get the service configuration.
   */
  get config(): Record<string, unknown> {
    return this._config;
  }

  /**
   * Initialize the service with context.
   * Called by the SDK after instantiation.
   *
   * @param context - The service context
   */
  initialize(context: IServiceContext): void {
    this.context = context;
  }

  /**
   * Called when session changes (sign-in, sign-out, refresh).
   * Override in subclasses to handle session changes.
   *
   * @param session - The new session, or null if signed out
   */
  onSessionChange(session: ServiceSession | null): void {
    // Override in subclass if needed
  }

  /**
   * Called when SDK signs out.
   * Aborts all pending operations.
   */
  onSignOut(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * Get the abort signal for this service.
   * Combines the service-level abort with context-level abort.
   */
  protected get abortSignal(): AbortSignal {
    return this.combineSignals();
  }

  /**
   * Check if the service is authenticated.
   */
  protected get isAuthenticated(): boolean {
    return this.context?.isAuthenticated ?? false;
  }

  /**
   * Get the current session.
   * Throws if not authenticated.
   */
  protected get session(): ServiceSession {
    if (!this.context?.session) {
      throw new Error("Not authenticated");
    }
    return this.context.session;
  }

  /**
   * Check authentication and return error result if not authenticated.
   * Use this at the start of methods that require authentication.
   *
   * @returns true if authenticated, false otherwise
   */
  protected requireAuth(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Emit a telemetry event.
   *
   * @param event - Event name
   * @param data - Event data
   */
  protected emit(event: string, data: unknown): void {
    this.context?.emit(event, data);
  }

  /**
   * Emit a service request event.
   *
   * @param action - The action being performed
   * @param key - Optional key/path being accessed
   */
  protected emitRequest(action: string, key?: string): void {
    const service = this.getServiceName();
    this.emit(TelemetryEvents.SERVICE_REQUEST, {
      service,
      action,
      span: this.spanName(action),
      key,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit a service response event.
   *
   * @param action - The action that was performed
   * @param ok - Whether the request was successful
   * @param startTime - Start time for duration calculation
   * @param status - Optional HTTP status code
   */
  protected emitResponse(
    action: string,
    ok: boolean,
    startTime: number,
    status?: number
  ): void {
    const service = this.getServiceName();
    const durationMs = Date.now() - startTime;
    const span = this.spanName(action);
    this.emit(TelemetryEvents.SERVICE_RESPONSE, {
      service,
      action,
      span,
      ok,
      duration: durationMs,
      durationMs,
      status,
    });
    this.emit(TelemetryEvents.SPAN, {
      span,
      service,
      action,
      ok,
      durationMs,
      status,
    });
  }

  /**
   * Emit a service error event.
   *
   * @param error - The service error
   */
  protected emitError(error: ServiceError, action?: string): void {
    const span = action ? this.spanName(action) : undefined;
    this.emit(TelemetryEvents.SERVICE_ERROR, {
      service: this.getServiceName(),
      ...(span ? { span } : {}),
      error,
    });
  }

  /**
   * Get the service name from the static property.
   * Subclasses must define static serviceName.
   */
  protected getServiceName(): string {
    return (this.constructor as typeof BaseService).serviceName;
  }

  /**
   * Stable span name used by SDK telemetry sinks.
   */
  protected spanName(action: string): string {
    return `sdk.${this.getServiceName()}.${action}`;
  }

  /**
   * Create a combined abort signal from multiple sources.
   *
   * @param signals - Additional abort signals to combine
   * @returns A combined abort signal
   */
  protected combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
    const controller = new AbortController();
    const allSignals = [
      this.abortController.signal,
      this.context?.abortSignal,
      ...signals.filter(Boolean),
    ].filter(Boolean) as AbortSignal[];

    for (const signal of allSignals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
      });
    }

    return controller.signal;
  }

  /**
   * Create the abort signal for one request, bounded by the request timeout.
   *
   * The signal aborts when the service signs out, the context aborts, the
   * caller's `signal` aborts, or the timeout elapses, whichever comes first.
   * A timeout aborts with a {@link RequestTimeoutError} (`TimeoutError`), which
   * `wrapError` maps to `ErrorCodes.TIMEOUT`; the other sources keep their own
   * reason (normally `AbortError`, mapped to `ErrorCodes.ABORTED`).
   *
   * The timeout is `timeoutMs` when given, otherwise `config.timeout`. Only a
   * positive, finite value (at most 2^31-1 ms) applies; `undefined`, `0`, and
   * `Infinity` mean no timeout, so a per-call `0` opts out of a configured one.
   *
   * Callers must call `dispose()` once the response body has been consumed,
   * which clears the timer and removes the listeners this adds to the
   * long-lived service and context signals.
   *
   * @param signal - The caller's abort signal for this request
   * @param timeoutMs - Per-request timeout override in milliseconds
   */
  protected createRequestSignal(
    signal?: AbortSignal,
    timeoutMs?: number
  ): RequestSignal {
    const controller = new AbortController();
    const detachers: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const dispose = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const detach of detachers.splice(0)) {
        detach();
      }
    };
    const abort = (reason: unknown): void => {
      dispose();
      controller.abort(reason);
    };
    const requestSignal: RequestSignal = { signal: controller.signal, dispose };

    const parents = [
      this.abortController.signal,
      this.context?.abortSignal,
      this.context?.operationAbortSignal,
      signal,
    ].filter((parent): parent is AbortSignal => parent !== undefined);
    for (const parent of parents) {
      if (parent.aborted) {
        abort(parent.reason);
        return requestSignal;
      }
      const onAbort = (): void => abort(parent.reason);
      parent.addEventListener("abort", onAbort, { once: true });
      detachers.push(() => parent.removeEventListener("abort", onAbort));
    }

    const timeout = timeoutMs ?? this._config.timeout;
    if (
      typeof timeout === "number" &&
      timeout > 0 &&
      timeout <= MAX_TIMER_DELAY_MS
    ) {
      timer = setTimeout(() => abort(new RequestTimeoutError(timeout)), timeout);
    }

    return requestSignal;
  }

  /**
   * Wrap an operation with error handling and telemetry.
   *
   * @param action - The action name for telemetry
   * @param key - Optional key for telemetry
   * @param operation - The operation to execute
   * @returns Result of the operation
   */
  protected async withTelemetry<T>(
    action: string,
    key: string | undefined,
    operation: () => Promise<Result<T>>
  ): Promise<Result<T>> {
    const startTime = Date.now();
    this.emitRequest(action, key);

    try {
      const result = await operation();

      if (result.ok) {
        this.emitResponse(action, true, startTime);
      } else {
        this.emitResponse(action, false, startTime);
        this.emitError(result.error, action);
      }

      return result;
    } catch (error) {
      const serviceError = wrapError(this.getServiceName(), error);
      this.emitResponse(action, false, startTime);
      this.emitError(serviceError, action);
      return err(serviceError);
    }
  }
}
