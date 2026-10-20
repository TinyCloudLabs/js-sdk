import { authorizationVerdictOf, validatedCapabilityOf } from "@tinycloud/sdk-services";

import { DELEGATION_CID_PATTERN } from "./contract.js";
import type { OperationExecutionOutcome } from "./contract.js";
import { operationError } from "./errors.js";

export type NodeRevocation =
  | Readonly<{ reason: "delegation_revoked"; revokedCid: string }>
  | Readonly<{ reason: "delegation_ancestor_revoked"; revokedCid: string; ancestorCid: string }>;

const DELEGATION_CID = new RegExp(DELEGATION_CID_PATTERN);
const NODE_REVOCATION_BODY =
  /^(?:Invalid invocation: )?delegation-(?:(revoked): ([A-Za-z0-9]+)|(ancestor-revoked): ancestor=([A-Za-z0-9]+) invoked=([A-Za-z0-9]+))$/;

/**
 * Classify a definite node refusal from a KV SDK service error. The SDK puts
 * the entire node response after its `: 401 - ` separator; never search for a
 * marker within arbitrary error prose or accept a different HTTP status.
 */
export function nodeRevocationOf(error: unknown): NodeRevocation | undefined {
  if (
    typeof error !== "object" || error === null ||
    !("service" in error) || error.service !== "kv" ||
    !("code" in error) ||
    (error.code !== "AUTH_UNAUTHORIZED" && error.code !== "AUTH_DELEGATION_REVOKED" && error.code !== "AUTH_DELEGATION_ANCESTOR_REVOKED") ||
    !("message" in error) || typeof error.message !== "string" ||
    !("meta" in error) || typeof error.meta !== "object" || error.meta === null ||
    !("status" in error.meta) || error.meta.status !== 401 ||
    authorizationVerdictOf(error) !== "unauthenticated"
  ) return undefined;
  const { code, message } = error;

  const separator = ": 401 - ";
  const start = message.indexOf(separator);
  if (start < 0) return undefined;
  const body = message.slice(start + separator.length);
  const match = NODE_REVOCATION_BODY.exec(body);
  if (match === null || match[0] !== body) return undefined;
  if (match[1] !== undefined && code !== "AUTH_DELEGATION_ANCESTOR_REVOKED") {
    const revokedCid = match[2]!;
    return DELEGATION_CID.test(revokedCid) ? { reason: "delegation_revoked", revokedCid } : undefined;
  }
  if (match[3] !== undefined && code !== "AUTH_DELEGATION_REVOKED") {
    const ancestorCid = match[4]!;
    const revokedCid = match[5]!;
    return DELEGATION_CID.test(ancestorCid) && DELEGATION_CID.test(revokedCid)
      ? { reason: "delegation_ancestor_revoked", revokedCid, ancestorCid }
      : undefined;
  }
  return undefined;
}

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
    case "auth_required": {
      const revocation = nodeRevocationOf(error);
      return {
        status: "error",
        error: operationError("AUTH_REQUIRED", `Authentication is required to ${action}.`, {
          ...(revocation === undefined ? {} : { details: revocation }),
        }),
      };
    }
    case "permission_denied":
      return { status: "error", error: operationError("PERMISSION_DENIED", `Permission is denied to ${action}.`) };
    case undefined:
      return undefined;
  }
}
