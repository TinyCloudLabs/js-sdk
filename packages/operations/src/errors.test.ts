import { expect, test } from "bun:test";

import {
  OperationInvocationError,
  internalOperationError,
  nodeRetryOperationError,
  operationError,
  sanitizeThrownOperationError,
} from "./errors.js";
import { appsFailure } from "./tc-apps/kv.js";

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
