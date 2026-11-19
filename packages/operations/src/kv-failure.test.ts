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
  // A node since 1.25.17 answers a revocation with a JSON envelope, and the KV service does not type it.
  ["node envelope, cited delegation", JSON.stringify({ code: "delegation_revoked", error: `delegation-revoked: ${revokedCid}` }), "AUTH_UNAUTHORIZED", { reason: "delegation_revoked", revokedCid }],
  ["node envelope, revoked parent", JSON.stringify({ code: "parent_revoked", error: `delegation-ancestor-revoked: ancestor=${ancestorCid} invoked=${revokedCid}` }), "AUTH_UNAUTHORIZED", { reason: "delegation_ancestor_revoked", revokedCid, ancestorCid }],
  ["node envelope, revoked higher ancestor", `${JSON.stringify({ code: "ancestor_revoked", error: `delegation-ancestor-revoked: ancestor=${ancestorCid} invoked=${revokedCid}` })}\n`, "AUTH_UNAUTHORIZED", { reason: "delegation_ancestor_revoked", revokedCid, ancestorCid }],
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

test("a revoked SQL grant is classified from the SQL service's 401, in either body form", () => {
  for (const body of [
    JSON.stringify({ code: "delegation_revoked", error: `delegation-revoked: ${revokedCid}` }),
    `delegation-revoked: ${revokedCid}`,
  ]) {
    const error = { service: "sql", code: "AUTH_UNAUTHORIZED", message: `SQL query failed: 401 - ${body}`, meta: { status: 401, statusText: "Unauthorized" } };
    expect(nodeRevocationOf(error)).toEqual({ reason: "delegation_revoked", revokedCid });
    const outcome = authorizationFailure(error, "query the SQLite database");
    expect(outcome).toEqual({
      status: "error",
      error: { code: "AUTH_REQUIRED", message: REVOKED_GRANT_MESSAGE, retryable: false, details: { reason: "delegation_revoked", revokedCid } },
    });
  }
  // A SQL failure the service describes itself has no node body to read.
  expect(nodeRevocationOf({ service: "sql", code: "AUTH_UNAUTHORIZED", message: `delegation-revoked: ${revokedCid}`, meta: { status: 401 } }))
    .toBeUndefined();
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
    { ...sdkError(body, "AUTH_DELEGATION_REVOKED"), service: "vault" },
    { ...sdkError(body, "AUTH_DELEGATION_REVOKED"), meta: { status: "401" } },
    sdkError(ancestorBody, "AUTH_DELEGATION_REVOKED"),
    sdkError(body, "AUTH_DELEGATION_ANCESTOR_REVOKED"),
    sdkError(`${body} appended-private-token`, "AUTH_DELEGATION_REVOKED"),
    sdkError(`Unauthorized Action: vault/secrets/${body}`, "AUTH_DELEGATION_REVOKED"),
    sdkError(`{ "error": "${body}" }`, "AUTH_DELEGATION_REVOKED"),
    // Only the node's exact revocation envelope is opened.
    sdkError(JSON.stringify({ code: "delegation_expired", error: body }), "AUTH_UNAUTHORIZED"),
    sdkError(JSON.stringify({ code: "delegation_revoked", error: { text: body } }), "AUTH_UNAUTHORIZED"),
    sdkError(JSON.stringify({ code: "delegation_revoked", error: `${body} appended-private-token` }), "AUTH_UNAUTHORIZED"),
    sdkError(`${JSON.stringify({ code: "delegation_revoked", error: body })} appended-private-token`, "AUTH_UNAUTHORIZED"),
    sdkError(JSON.stringify([{ code: "delegation_revoked", error: body }]), "AUTH_UNAUTHORIZED"),
    sdkError(JSON.stringify({ code: "delegation_revoked", error: body }), "AUTH_UNAUTHORIZED", 403),
    sdkError(`Unauthorized Action: vault/secrets/${JSON.stringify({ code: "delegation_revoked", error: body })}`, "AUTH_UNAUTHORIZED"),
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
