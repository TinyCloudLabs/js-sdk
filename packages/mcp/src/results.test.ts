import { expect, test } from "bun:test";

import { toMcpToolResult } from "./results.js";

test("uses one structured envelope and never copies a successful value into text", () => {
  const canary = "mcp-secret-canary-results";
  const result = toMcpToolResult({
    status: "ok",
    operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
    context: { profile: "default", host: "https://node.example", posture: "local-owner-key" },
    output: { value: canary },
  });

  expect(result.structuredContent.output).toEqual({ value: canary });
  expect(JSON.stringify(result.content)).not.toContain(canary);
  expect(result.content).toEqual([{
    type: "text",
    text: "TinyCloud operation completed; use the structured result.",
  }]);
});

test("does not serialize authority or setup artifacts into text", () => {
  const result = toMcpToolResult({
    status: "setup_required",
    operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
    context: {},
    setup: { kind: "secret_manager", url: "https://secrets.example/setup?name=canary" },
  });

  expect(result.content[0]?.text).not.toContain("secrets.example");
  expect(result.structuredContent.setup).toBeDefined();
});

test("projects every canonical envelope category through the same fixed text channel", () => {
  const samples = [
    {
      status: "authority_required",
      operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
      context: { profile: "delegate", host: "https://node.example", posture: "delegate-session" },
      missing: [{ service: "tinycloud.kv", path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] }],
      request: {
        kind: "tinycloud.auth.request", version: 1, requestId: "req-1",
        createdAt: "2026-07-16T00:00:00.000Z", profile: "delegate", posture: "delegate-session",
        operatorType: "agent", host: "https://node.example", sessionDid: "did:key:session",
        requested: [{ service: "tinycloud.kv", path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] }],
      },
      approval: { kind: "openkey", requestId: "req-1", fallback: "tc auth grant <request-artifact>" },
      retry: { operationId: "tinycloud.secrets.get", operationVersion: 1, inputDigest: "a".repeat(64), requiresCallerInput: false },
    },
    {
      status: "error",
      operation: { operationId: "tinycloud.status.get", operationVersion: 1 },
      context: { profile: "missing", host: "https://node.example", posture: "unauthenticated" },
      error: { code: "PROFILE_NOT_FOUND", message: "Profile is not available.", retryable: false },
    },
  ] as const;

  for (const sample of samples) {
    const projected = toMcpToolResult(sample);
    expect(projected.content[0]?.text).not.toContain(JSON.stringify(sample));
    expect(projected.structuredContent.status).toBe(sample.status);
  }
});
