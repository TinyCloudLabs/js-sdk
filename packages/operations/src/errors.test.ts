import { expect, test } from "bun:test";

import {
  OPERATION_ERROR_CODES,
  OperationInvocationError,
  internalOperationError,
  operationError,
  sanitizeThrownOperationError,
} from "./errors.js";

test("defines every stable v1 operation error code", () => {
  expect(OPERATION_ERROR_CODES).toEqual([
    "INPUT_INVALID",
    "OPERATION_NOT_FOUND",
    "OPERATION_VERSION_UNSUPPORTED",
    "PROFILE_NOT_FOUND",
    "PROFILE_POSTURE_NOT_ALLOWED",
    "PROFILE_OWNER_OPT_IN_REQUIRED",
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
    "KV_NOT_FOUND",
    "KV_PRECONDITION_FAILED",
    "KV_RESPONSE_TOO_LARGE",
    "SQL_QUERY_INVALID",
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
