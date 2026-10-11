import { authorizationVerdictOf, validatedCapabilityOf } from "@tinycloud/sdk-services";

import type { OperationExecutionOutcome } from "./contract.js";
import { operationError } from "./errors.js";

/**
 * The TC-634 split of a node refusal: a 403, or a 401 that names a validated
 * missing capability, is a permission denial; any other 401 means the caller
 * must authenticate again. `undefined` when the error is not a refusal.
 */
export function kvRefusal(error: unknown): "permission_denied" | "auth_required" | undefined {
  const verdict = authorizationVerdictOf(error);
  if (verdict === "unauthenticated") {
    return validatedCapabilityOf(error) === undefined ? "auth_required" : "permission_denied";
  }
  return verdict === "forbidden" ? "permission_denied" : undefined;
}

/** The canonical error for a node refusal, or `undefined` when `error` is not one. */
export function authorizationFailure(error: unknown, action: string): OperationExecutionOutcome<never> | undefined {
  switch (kvRefusal(error)) {
    case "auth_required":
      return { status: "error", error: operationError("AUTH_REQUIRED", `Authentication is required to ${action}.`) };
    case "permission_denied":
      return { status: "error", error: operationError("PERMISSION_DENIED", `Permission is denied to ${action}.`) };
    case undefined:
      return undefined;
  }
}
