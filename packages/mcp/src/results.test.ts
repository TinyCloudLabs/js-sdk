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
