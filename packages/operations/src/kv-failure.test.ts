import { expect, test } from "bun:test";

import { authorizationFailure, nodeRevocationOf } from "./kv-failure.js";
import { REVOKED_GRANT_MESSAGE } from "./revoked-grant.js";

const revokedCid = `bafkr4i${"a".repeat(52)}`;
const ancestorCid = `bafkr4i${"b".repeat(52)}`;

function sdkError(body: string, code: string, status = 401) {
  return {
    service: "kv",
    code,
    message: `Failed to read KV changes for "vault/secrets": ${status} - ${body}`,
    meta: { status },
  };
}

test.each([
  ["delegation-revoked", `delegation-revoked: ${revokedCid}`, "AUTH_DELEGATION_REVOKED", { reason: "delegation_revoked", revokedCid }],
  ["delegation-ancestor-revoked", `delegation-ancestor-revoked: ancestor=${ancestorCid} invoked=${revokedCid}`, "AUTH_DELEGATION_ANCESTOR_REVOKED", { reason: "delegation_ancestor_revoked", revokedCid, ancestorCid }],
  ["legacy node prefix", `Invalid invocation: delegation-revoked: ${revokedCid}`, "AUTH_DELEGATION_REVOKED", { reason: "delegation_revoked", revokedCid }],
  ["legacy ancestor prefix", `Invalid invocation: delegation-ancestor-revoked: ancestor=${ancestorCid} invoked=${revokedCid}`, "AUTH_DELEGATION_ANCESTOR_REVOKED", { reason: "delegation_ancestor_revoked", revokedCid, ancestorCid }],
] as const)("projects %s as safe authentication details", (_name, body, code, details) => {
  const error = sdkError(body, code);
  expect(nodeRevocationOf(error)).toEqual(details);
  const outcome = authorizationFailure(error, "read KV changes");
  expect(outcome).toEqual({
    status: "error",
    error: {
      code: "AUTH_REQUIRED",
      message: REVOKED_GRANT_MESSAGE,
      retryable: false,
      details,
    },
  });
  expect(JSON.stringify(outcome)).not.toContain("delegation-revoked:");
  expect(JSON.stringify(outcome)).not.toContain("delegation-ancestor-revoked:");
});
test("ordinary KV get accepts a definitive whole-body 401 without a specialized SDK code", () => {
  const error = {
    service: "kv",
    code: "AUTH_UNAUTHORIZED",
    message: `Failed to get key "vault/secrets": 401 - Invalid invocation: delegation-ancestor-revoked: ancestor=${ancestorCid} invoked=${revokedCid}`,
    meta: { status: 401 },
  };
  expect(nodeRevocationOf(error)).toEqual({ reason: "delegation_ancestor_revoked", revokedCid, ancestorCid });
  expect(authorizationFailure(error, "read the KV key")).toMatchObject({
    status: "error",
    error: { code: "AUTH_REQUIRED", details: { reason: "delegation_ancestor_revoked", revokedCid, ancestorCid } },
  });
});


test("non-definitive errors never project node text or a grant CID", () => {
  const body = `delegation-revoked: ${revokedCid}`;
  const ancestorBody = `delegation-ancestor-revoked: ancestor=${ancestorCid} invoked=${revokedCid}`;
  const cases = [
    sdkError("Unauthorized", "AUTH_UNAUTHORIZED"),
    sdkError(body, "AUTH_UNAUTHORIZED", 403),
    sdkError(body, "AUTH_UNAUTHORIZED", 503),
    sdkError(body, "AUTH_DELEGATION_REVOKED", 403),
    sdkError(body, "AUTH_DELEGATION_REVOKED", 503),
    { ...sdkError(body, "AUTH_DELEGATION_REVOKED"), status: 503 },
    { ...sdkError(body, "AUTH_UNAUTHORIZED"), statusCode: 403 },
    { ...sdkError(body, "AUTH_DELEGATION_REVOKED"), service: "sql" },
    { ...sdkError(body, "AUTH_DELEGATION_REVOKED"), meta: { status: "401" } },
    sdkError(ancestorBody, "AUTH_DELEGATION_REVOKED"),
    sdkError(body, "AUTH_DELEGATION_ANCESTOR_REVOKED"),
    sdkError(`${body} appended-private-token`, "AUTH_DELEGATION_REVOKED"),
    sdkError(`Unauthorized Action: vault/secrets/${body}`, "AUTH_DELEGATION_REVOKED"),
    sdkError(`{ "error": "${body}" }`, "AUTH_DELEGATION_REVOKED"),
    sdkError(`delegation-revoked: ${revokedCid.slice(0, -1)}8`, "AUTH_DELEGATION_REVOKED"),
    sdkError(`delegation-revoked: ${revokedCid}\nprivate-token`, "AUTH_DELEGATION_REVOKED"),
    sdkError(`Unauthorized Action: vault/secrets/: 401 - ${body}`, "AUTH_UNAUTHORIZED"),
  ];
  for (const error of cases) {
    expect(nodeRevocationOf(error)).toBeUndefined();
    const outcome = authorizationFailure(error, "read KV changes");
    if (outcome?.status === "error") {
      expect(outcome.error).not.toHaveProperty("details");
      expect(JSON.stringify(outcome)).not.toContain(revokedCid);
      expect(JSON.stringify(outcome)).not.toContain("private-token");
    }
  }
  expect(authorizationFailure(sdkError(body, "AUTH_DELEGATION_REVOKED", 403), "read KV changes"))
    .toMatchObject({ status: "error", error: { code: "PERMISSION_DENIED" } });
  expect(authorizationFailure(sdkError(body, "AUTH_DELEGATION_REVOKED", 503), "read KV changes"))
    .toBeUndefined();
});
