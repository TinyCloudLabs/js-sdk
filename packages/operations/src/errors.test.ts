import { expect, test } from "bun:test";

import {
  OPERATION_ERROR_CODES,
  OperationInvocationError,
  internalOperationError,
  nodeRetryOperationError,
  operationError,
  sanitizeThrownOperationError,
} from "./errors.js";
import { appsFailure } from "./tc-apps/kv.js";

test("defines every stable v1 operation error code", () => {
  expect(OPERATION_ERROR_CODES).toEqual([
    "INPUT_INVALID",
    "OPERATION_NOT_FOUND",
    "OPERATION_VERSION_UNSUPPORTED",
    "PROFILE_NOT_FOUND",
    "PROFILE_POSTURE_NOT_ALLOWED",
    "PROFILE_OWNER_OPT_IN_REQUIRED",
    "PROFILE_MIGRATION_REQUIRED",
    "AUTH_REQUIRED",
    "PERMISSION_DENIED",
    "SESSION_NOT_FOUND",
    "PERMISSION_HINT_INVALID",
    "DELEGATION_ARTIFACT_INVALID",
    "DELEGATION_EXPIRED",
    "DELEGATION_AUDIENCE_MISMATCH",
    "DELEGATION_HOST_MISMATCH",
    "DELEGATION_REJECTED",
    "ENCRYPTION_NETWORK_UNRESOLVED",
    "NODE_UNREACHABLE",
    "NODE_ERROR",
    "STORAGE_QUOTA_EXCEEDED",
    "KV_NOT_FOUND",
    "KV_PRECONDITION_FAILED",
    "KV_CONFLICT",
    "KV_RESPONSE_TOO_LARGE",
    "SQL_QUERY_INVALID",
    "SQL_EXECUTION_FAILED",
    "SQL_RESULT_LIMIT_EXCEEDED",
    "SQL_VALUE_UNSAFE",
    "SECRET_READ_FAILED",
    "SECRET_DECRYPT_FAILED",
    "OUTPUT_INVALID",
    "INTERNAL_ERROR",
  ]);
});

test("preserves only typed expected failures and sanitizes generic exceptions", () => {
  const expected = operationError("NODE_UNREACHABLE", "The node is unavailable.", {
    retryable: true,
  });

  expect(
    sanitizeThrownOperationError(new OperationInvocationError(expected)),
  ).toEqual(expected);
  expect(sanitizeThrownOperationError(new Error("private details"))).toEqual(
    internalOperationError(),
  );
});

test("maps the SDK's node retry codes to NODE_ERROR with the SDK's retry verdict, and nothing else", () => {
  expect(nodeRetryOperationError({ code: "NODE_BUSY" })).toMatchObject({ code: "NODE_ERROR", retryable: true });
  expect(nodeRetryOperationError({ code: "REQUEST_TIMEOUT" })).toMatchObject({ code: "NODE_ERROR", retryable: true });
  const unknown = nodeRetryOperationError({ code: "OUTCOME_UNKNOWN" });
  expect(unknown).toMatchObject({ code: "NODE_ERROR", retryable: false });
  expect(unknown?.message).toContain("read the data back");
  for (const other of [{ code: "NETWORK_ERROR" }, { code: "TIMEOUT" }, "NODE_BUSY", null, undefined, {}]) {
    expect(nodeRetryOperationError(other)).toBeUndefined();
  }
});

test("a personal-record failure with an unknown write outcome is not retryable", () => {
  expect(appsFailure({ code: "OUTCOME_UNKNOWN", meta: { status: 500 } })).toMatchObject({ code: "NODE_ERROR", retryable: false });
  expect(appsFailure({ code: "NODE_BUSY", meta: { status: 503 } })).toMatchObject({ code: "NODE_ERROR", retryable: true });
  expect(appsFailure({ code: "NETWORK_ERROR" })).toMatchObject({ code: "NODE_ERROR", retryable: true });
});
