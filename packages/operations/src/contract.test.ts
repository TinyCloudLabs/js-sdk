import { expect, test } from "bun:test";

import {
  safeOperationContextSummary,
  type InvocationTarget,
  type OperationContextSummary,
} from "./contract.js";

test("InvocationTarget contains only caller selection and the nonpersistable CLI key override", () => {
  const target: InvocationTarget = {
    profile: "delegate",
    host: "https://node.example",
    allowOwnerProfile: true,
    privateKey: "0xcli-only",
  };

  expect(target).toEqual({
    profile: "delegate",
    host: "https://node.example",
    allowOwnerProfile: true,
    privateKey: "0xcli-only",
  });
});

test("safe context summaries retain only identity fields", () => {
  const summary: OperationContextSummary = {
    profile: "delegate",
    host: "https://node.example",
    posture: "delegate-session",
    operator: "delegate",
    principalDid: "did:key:principal",
    sessionDid: "did:key:session",
    ownerDid: "did:key:owner",
    space: "secrets",
  };

  expect(safeOperationContextSummary(summary)).toEqual(summary);
});
