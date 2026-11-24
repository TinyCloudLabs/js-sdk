import { expect, test } from "bun:test";

import { redactOperationError } from "./redaction.js";

const sensitivity = {
  input: ["/credentials/token", "/items/0/secret", "/not-present"],
  output: ["/value"],
} as const;

test("preserves the known SQL missing-database reason for install rules", () => {
  const failure = (reason: unknown) => redactOperationError(
    { sensitivity },
    {
      code: "NODE_ERROR",
      message: "The database or table does not exist in this space.",
      retryable: false,
      details: { reason, nodeResponse: "private-node-canary" },
    },
  );

  expect(failure("sql_database_missing").details).toEqual({ reason: "sql_database_missing" });
  expect(failure("private-node-canary").details).toBeUndefined();
  expect(JSON.stringify(failure("sql_database_missing"))).not.toContain("private-node-canary");
});
