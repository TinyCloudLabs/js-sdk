import { expect, test } from "bun:test";
import { NodeIdentityMismatchError, NodeNotRespondingError, PartialNodeWriteError } from "@tinycloud/sdk-services";

import {
  activationRoutingOperationError,
  OperationInvocationError,
  internalOperationError,
  nodeRetryOperationError,
  operationError,
  routingOperationError,
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

test("activation-only partial registration preserves availability, accepted outcomes and redacts private causes", () => {
  const accepted = "https://accepted.fixture.invalid";
  const offline = "https://offline.fixture.invalid";
  const unavailable = new PartialNodeWriteError([accepted], [{
    url: offline, cause: new NodeNotRespondingError([offline], new Error("PRIVATE_ACTIVATION_CAUSE")),
  }]);
  const projected = activationRoutingOperationError(unavailable);
  expect(projected).toMatchObject({
    code: "NODE_NOT_RESPONDING", retryable: true,
    details: { succeeded: [accepted], failed: [{ url: offline, code: "NODE_NOT_RESPONDING" }] },
  });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_ACTIVATION_CAUSE");
  const dataFailure = routingOperationError(unavailable);
  expect(dataFailure).toMatchObject({
    code: "PARTIAL_NODE_WRITE", retryable: false,
    details: { succeeded: [accepted], failed: [{ url: offline, code: "NODE_NOT_RESPONDING" }] },
  });
  expect(JSON.stringify(dataFailure)).not.toContain("PRIVATE_ACTIVATION_CAUSE");

  const wrongIdentity = new PartialNodeWriteError([accepted], [
    ...unavailable.failed,
    { url: "https://wrong.fixture.invalid", cause: new NodeIdentityMismatchError("PRIVATE_IDENTITY_URL", "did:key:private") },
  ]);
  expect(activationRoutingOperationError(wrongIdentity)).toMatchObject({
    code: "PARTIAL_NODE_WRITE", retryable: false,
    details: { failed: [
      { code: "NODE_NOT_RESPONDING" },
      { code: "NODE_IDENTITY_MISMATCH" },
    ] },
  });
  expect(JSON.stringify(activationRoutingOperationError(wrongIdentity))).not.toContain("PRIVATE_IDENTITY_URL");
});
