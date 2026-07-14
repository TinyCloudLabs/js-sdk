import { expect, test } from "bun:test";

import {
  REDACTED_VALUE,
  createSafeOperationDiagnostic,
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
