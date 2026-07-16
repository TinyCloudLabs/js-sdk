import { expect, test } from "bun:test";

import catalog from "@tinycloud/operations/operations.json";

import { TOOL_NAMES, toolBindingsForTest } from "./tools.js";

test("has exactly the reviewed ten-tool operation mapping", () => {
  const bindings = toolBindingsForTest();
  expect(bindings.map((binding) => binding.name)).toEqual([...TOOL_NAMES]);
  expect(bindings).toEqual([
    expect.objectContaining({ name: "tinycloud_status", operationId: "tinycloud.status.get", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_auth_status", operationId: "tinycloud.auth.status", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_auth_capabilities", operationId: "tinycloud.auth.capabilities", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_auth_request", operationId: "tinycloud.auth.request", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_auth_import", operationId: "tinycloud.auth.import", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_account_spaces_list", operationId: "tinycloud.account.spaces.list", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_account_applications_list", operationId: "tinycloud.account.applications.list", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_kv_list", operationId: "tinycloud.kv.list", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_kv_get", operationId: "tinycloud.kv.get", operationVersion: 1 }),
    expect.objectContaining({ name: "tinycloud_secrets_get", operationId: "tinycloud.secrets.get", operationVersion: 1 }),
  ]);
  expect((catalog as { operations: unknown[] }).operations).toHaveLength(10);
});

test("does not register a continuation tool or any non-tool MCP surface", async () => {
  const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();
  const toolSource = await Bun.file(new URL("./tools.ts", import.meta.url)).text();
  expect(source).not.toContain("registerResource");
  expect(source).not.toContain("registerPrompt");
  expect(source).not.toContain("continuation");
  expect(toolSource.match(/registerTool\(/g)).toHaveLength(1);
  expect(toolSource).not.toContain("@tinycloud/node-sdk");
  expect(toolSource).not.toContain("new TinyCloudNode");
  expect(toolSource).not.toContain("registerResource");
  expect(toolSource).not.toContain("registerPrompt");
  expect(toolSource).not.toContain("elicitation");
});
