/**
 * Helpers shared by DelegationManager and the lazily loaded issued-delegation
 * module. Kept free of other imports so neither bundle drags the other in.
 *
 * @packageDocumentation
 */

import type { DelegationError } from "./types.schema";

/**
 * Delegation action constants.
 */
export const DelegationAction = {
  REVOKE: "tinycloud.delegation/revoke",
  STATUS: "tinycloud.delegation/status",
  LIST: "tinycloud.delegation/list",
  GET: "tinycloud.delegation/get",
  CHECK: "tinycloud.delegation/check",
} as const;

/**
 * Creates a DelegationError with the given parameters.
 */
export function createError(
  code: string,
  message: string,
  cause?: Error,
  meta?: Record<string, unknown>
): DelegationError {
  return {
    code,
    message,
    service: "delegation",
    cause,
    meta,
  };
}
