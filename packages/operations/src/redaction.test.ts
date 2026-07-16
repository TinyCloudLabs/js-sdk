import { expect, test } from "bun:test";

import {
  REDACTED_VALUE,
  createSafeOperationDiagnostic,
  redactOperationError,
  redactOperationValue,
} from "./redaction.js";

const sensitivity = {
  input: ["/credentials/token", "/items/0/secret", "/not-present"],
  output: ["/value"],
} as const;

test("redacts JSON Pointer values on a clone and ignores missing pointers", () => {
  const original = {
    credentials: { token: "input-canary", region: "us-east" },
    items: [{ secret: "nested-canary", name: "first" }],
    value: "output-canary",
  };

  const redacted = redactOperationValue({ sensitivity }, original);

  expect(redacted).toEqual({
    credentials: { token: REDACTED_VALUE, region: "us-east" },
    items: [{ secret: REDACTED_VALUE, name: "first" }],
    value: REDACTED_VALUE,
  });
  expect(original).toEqual({
    credentials: { token: "input-canary", region: "us-east" },
    items: [{ secret: "nested-canary", name: "first" }],
    value: "output-canary",
  });
});

test("supports escaped JSON Pointer tokens and root replacement", () => {
  expect(
    redactOperationValue(
      { sensitivity: { input: ["/a~1b/~0key"], output: [] } },
      { "a/b": { "~key": "canary" } },
    ),
  ).toEqual({ "a/b": { "~key": REDACTED_VALUE } });
  expect(
    redactOperationValue(
      { sensitivity: { input: [""], output: [] } },
      { secret: "canary" },
    ),
  ).toBe(REDACTED_VALUE);
});

test("safe diagnostic events redact operation values and accept no target", () => {
  const diagnostic = createSafeOperationDiagnostic(
    { sensitivity },
    {
      operation: { operationId: "tinycloud.test.read", operationVersion: 1 },
      context: {
        profile: "delegate",
        host: "https://node.example",
        posture: "delegate-session",
        operatorType: "agent",
      },
      input: { credentials: { token: "input-canary" } },
      output: { value: "output-canary" },
    },
  );

  expect(JSON.stringify(diagnostic)).not.toContain("input-canary");
  expect(JSON.stringify(diagnostic)).not.toContain("output-canary");
});

test("error details use an explicit safe-field policy", () => {
  const error = redactOperationError(
    { sensitivity },
    {
      code: "DELEGATION_HOST_MISMATCH",
      message: "The delegation is for a different host.",
      retryable: false,
      details: {
        expectedHost: "https://expected.example",
        artifactHost: "https://artifact.example",
        authorization: "raw-delegation-canary",
        nested: { token: "nested-token-canary" },
      },
    },
  );

  expect(error.details).toEqual({
    expectedHost: "https://expected.example",
    artifactHost: "https://artifact.example",
  });
  expect(JSON.stringify(error)).not.toContain("canary");
});

test("error details reject attacker values in safe mismatch fields", () => {
  const canaries = [
    "raw-jwk-private-key-canary",
    "Bearer-private-auth-token-canary",
    "https://user:pass@safe.example/path?token=query-canary#fragment-canary",
    "did:key:fake-session-canary",
  ];
  const hostError = redactOperationError(
    { sensitivity },
    {
      code: "DELEGATION_HOST_MISMATCH",
      message: "The delegation is for a different host.",
      retryable: false,
      details: {
        expectedHost: canaries[2],
        artifactHost: canaries[0],
        nested: { token: canaries[1] },
      },
    },
  );
  const audienceError = redactOperationError(
    { sensitivity },
    {
      code: "DELEGATION_AUDIENCE_MISMATCH",
      message: "The delegation is for a different session.",
      retryable: false,
      details: {
        expectedSessionDid: canaries[3],
        artifactAudience: canaries[1],
      },
    },
  );

  expect(hostError.details).toBeUndefined();
  expect(audienceError.details).toBeUndefined();
  expect(JSON.stringify({ hostError, audienceError })).not.toContain("canary");
});

test("error details preserve canonical benign host and session DID mismatches", () => {
  const error = redactOperationError(
    { sensitivity },
    {
      code: "DELEGATION_AUDIENCE_MISMATCH",
      message: "The delegation is for a different session.",
      retryable: false,
      details: {
        expectedSessionDid:
          "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
        artifactAudience:
          "did:pkh:eip155:1:0x2222222222222222222222222222222222222222",
      },
    },
  );
  const host = redactOperationError(
    { sensitivity },
    {
      code: "DELEGATION_HOST_MISMATCH",
      message: "The delegation is for a different host.",
      retryable: false,
      details: {
        expectedHost: "https://expected.example/",
        artifactHost: "https://artifact.example",
      },
    },
  );

  expect(error.details).toEqual({
    expectedSessionDid:
      "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
    artifactAudience:
      "did:pkh:eip155:1:0x2222222222222222222222222222222222222222",
  });
  expect(host.details).toEqual({
    expectedHost: "https://expected.example",
    artifactHost: "https://artifact.example",
  });
});

test("input issue details omit attacker-controlled messages, paths, and keys", () => {
  const canary = "Bearer-private-auth-token-canary";
  const error = redactOperationError(
    { sensitivity },
    {
      code: "INPUT_INVALID",
      message: "The operation input is invalid.",
      retryable: false,
      details: {
        issues: [
          {
            code: "unrecognized_keys",
            message: `Unrecognized key(s): ${canary}`,
            path: [canary],
          },
        ],
      },
    },
  );

  expect(error.details).toEqual({ issues: [{ code: "unrecognized_keys" }] });
  expect(JSON.stringify(error)).not.toContain(canary);
});
