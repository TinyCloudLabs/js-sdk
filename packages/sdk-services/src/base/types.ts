/**
 * Base Service Types
 *
 * Types specific to the base service infrastructure.
 */

import {
  IService,
  IServiceContext,
  ServiceSession,
} from "../types";

/**
 * Service constructor type for registration.
 * Used by the SDK to instantiate services.
 */
export interface ServiceConstructor<
  TConfig = Record<string, unknown>,
  TService extends IService = IService
> {
  /** Service identifier used for registration */
  readonly serviceName: string;
  /** Create a new instance of the service */
  new (config?: TConfig): TService;
}

/**
 * Service registration entry.
 */
export interface ServiceRegistration {
  /** The service class constructor */
  constructor: ServiceConstructor;
  /** Configuration for this service instance */
  config?: Record<string, unknown>;
}

/**
 * Options for base service operations.
 */
export interface BaseServiceOptions {
  /** Override the default timeout for this operation */
  timeout?: number;
  /** Custom abort signal for this operation */
  signal?: AbortSignal;
}

/**
 * A per-request abort signal and the cleanup that releases it.
 * Created by `BaseService.createRequestSignal()`.
 */
export interface RequestSignal {
  /**
   * Aborts on service sign-out, context abort, the caller's signal, or when
   * the request timeout elapses (reason: a `TimeoutError`).
   */
  readonly signal: AbortSignal;
  /**
   * Clear the timeout and detach from the parent signals. Call once the
   * response has been consumed. Idempotent.
   */
  dispose(): void;
}

// Re-export common types for convenience
export type { IService, IServiceContext, ServiceSession };
