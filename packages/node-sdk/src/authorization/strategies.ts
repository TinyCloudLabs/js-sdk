/**
 * Node.js-specific SignStrategy types for TinyCloud authorization.
 *
 * This module re-exports common types from sdk-core and provides
 * Node.js-specific implementations (e.g., NodeEventEmitterStrategy
 * using Node's EventEmitter instead of browser EventTarget).
 *
 * @packageDocumentation
 */

import { EventEmitter } from "events";

// Import types for local use in SignStrategy union
import type {
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
} from "@tinycloud/sdk-core";

// Re-export common types from sdk-core (type-only — erased at runtime in sdk-core dist)
export type {
  SignRequest,
  SignResponse,
  SignCallback,
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  OpenKeySigningStrategyOptions,
  OpenKeySigningRequestBody,
  OpenKeySigningResponseBody,
  OpenKeyCallbackStrategy,
} from "@tinycloud/sdk-core";

export { createOpenKeyCallbackSigningStrategy } from "@tinycloud/sdk-core";

/**
 * Node.js event emitter strategy: emits sign requests as events.
 *
 * Uses Node.js EventEmitter for compatibility with Node.js applications.
 * For browser environments, use the EventEmitterStrategy from sdk-core
 * which uses EventTarget.
 *
 * Events emitted:
 * - 'sign-request': When a sign request is received
 *
 * Use cases:
 * - Async approval workflows in Node.js
 * - External signing services
 * - Multi-step authorization flows
 *
 * @example
 * ```typescript
 * const emitter = new EventEmitter();
 * const strategy: NodeEventEmitterStrategy = { type: 'event-emitter', emitter };
 *
 * emitter.on('sign-request', async (req, respond) => {
 *   const approved = await externalApprovalService.check(req);
 *   respond({ approved, signature: approved ? await sign(req.message) : undefined });
 * });
 * ```
 */
export interface NodeEventEmitterStrategy {
  type: "event-emitter";
  emitter: EventEmitter;
  /** Timeout in milliseconds for waiting on event response (default: 60000) */
  timeout?: number;
}

/**
 * Node.js sign strategy union type.
 *
 * Determines how sign requests are handled in NodeUserAuthorization.
 * Uses Node.js EventEmitter for the event-emitter strategy.
 */
export type SignStrategy =
  | AutoSignStrategy
  | AutoRejectStrategy
  | CallbackStrategy
  | NodeEventEmitterStrategy;

/**
 * Default sign strategy is auto-sign for convenience.
 * This is the Node.js-specific version typed with SignStrategy.
 */
export const defaultSignStrategy: SignStrategy = { type: "auto-sign" };
