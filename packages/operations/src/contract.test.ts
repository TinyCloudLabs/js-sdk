import { expect, test } from "bun:test";

import {
  safeOperationContextSummary,
  type OperationContextSummary,
} from "./contract.js";

test("safe context summaries retain only identity fields", () => {
  const summary: OperationContextSummary = {
    profile: "delegate",
    host: "https://node.example",
    posture: "delegate-session",
    operatorType: "agent",
    principalDid: "did:key:principal",
    sessionDid: "did:key:session",
    ownerDid: "did:key:owner",
    space: "secrets",
  };

  expect(
    safeOperationContextSummary({ ...summary, privateKey: "0xcli-only" } as OperationContextSummary),
  ).toEqual(summary);
});
