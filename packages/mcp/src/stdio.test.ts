import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { addFormats, Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import catalog from "@tinycloud/operations/operations.json";

const packageDirectory = new URL("..", import.meta.url).pathname;
const cliPath = join(packageDirectory, "dist/cli.js");
const nodeBinary = process.env.NODE_BINARY ?? "node";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("official v2 client lists exactly six generated-schema tools over stdio", async () => {
  const home = await fixtureHome();
  const transport = new StdioClientTransport({
    command: nodeBinary,
    args: [cliPath, "--profile", "default"],
    env: { ...process.env, TC_HOME: home },
    stderr: "pipe",
  });
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const client = new Client({ name: "tinycloud-mcp-i4-test", version: "0.0.0" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(ajv),
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "tinycloud_status",
      "tinycloud_auth_status",
      "tinycloud_auth_capabilities",
      "tinycloud_auth_request",
      "tinycloud_auth_import",
      "tinycloud_secrets_get",
    ]);
    expect(listed.tools).toHaveLength(6);

    const byId = new Map((catalog as { operations: Array<{ id: string; version: number; input: unknown }> }).operations
      .map((operation) => [`${operation.id}@${operation.version}`, operation]));
    const mapping: Record<string, string> = {
      tinycloud_status: "tinycloud.status.get@1",
      tinycloud_auth_status: "tinycloud.auth.status@1",
      tinycloud_auth_capabilities: "tinycloud.auth.capabilities@1",
      tinycloud_auth_request: "tinycloud.auth.request@1",
      tinycloud_auth_import: "tinycloud.auth.import@1",
      tinycloud_secrets_get: "tinycloud.secrets.get@1",
    };
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toEqual(
        byId.get(mapping[tool.name]!)!.input as typeof tool.inputSchema,
      );
    }

    const status = await client.callTool({ name: "tinycloud_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      status: "ok",
      operation: { operationId: "tinycloud.status.get", operationVersion: 1 },
      context: { profile: "default" },
    });
    expect(status.content).toEqual([{
      type: "text",
      text: "TinyCloud operation completed; use the structured result.",
    }]);

    const unknownField = await client.callTool({
      name: "tinycloud_status",
      arguments: { unexpected: "fixture-secret-canary" },
    });
    expect(unknownField.isError).toBe(true);
    expect(JSON.stringify(unknownField)).not.toContain("fixture-secret-canary");

    const freeFormPermission = await client.callTool({
      name: "tinycloud_auth_request",
      arguments: { permissions: [{ service: "wildcard", path: "*", actions: ["*" ] }] },
    });
    expect(freeFormPermission.isError).toBe(true);

    await writeFile(join(home, ".tinycloud/config.json"), JSON.stringify({ defaultProfile: "missing-after-startup" }));
    const stillPinned = await client.callTool({ name: "tinycloud_status", arguments: {} });
    expect(stillPinned.structuredContent).toMatchObject({
      status: "ok",
      context: { profile: "default" },
    });
    expect(stderr).toBe("");
  } finally {
    await client.close();
  }
});

test("owner data requires explicit startup profile and opt-in while status stays callable", async () => {
  const home = await fixtureHome();
  const transport = new StdioClientTransport({
    command: nodeBinary,
    args: [cliPath],
    env: { ...process.env, TC_HOME: home },
  });
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const client = new Client({ name: "tinycloud-mcp-owner-gate-test", version: "0.0.0" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(ajv),
  });
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "tinycloud_auth_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ status: "ok" });

    const secret = await client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: "MCP_TEST_SECRET" },
    });
    expect(secret.structuredContent).toMatchObject({
      status: "error",
      error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" },
    });
  } finally {
    await client.close();
  }
});

test("an explicitly pinned missing profile never falls back to config.defaultProfile", async () => {
  const home = await fixtureHome();
  const transport = new StdioClientTransport({
    command: nodeBinary,
    args: [cliPath, "--profile", "missing"],
    env: { ...process.env, TC_HOME: home },
  });
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const client = new Client({ name: "tinycloud-mcp-pinned-profile-test", version: "0.0.0" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(ajv),
  });
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "tinycloud_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      status: "error",
      error: { code: "PROFILE_NOT_FOUND" },
    });
  } finally {
    await client.close();
  }
});

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-mcp-i4-"));
  homes.push(home);
  const profileDirectory = join(home, ".tinycloud/profiles/default");
  await Bun.write(join(profileDirectory, "profile.json"), JSON.stringify({
    name: "default",
    host: "https://node.example",
    chainId: 1,
    spaceName: "secrets",
    did: "did:key:z6MkjMCPFixture",
    createdAt: "2026-07-16T00:00:00.000Z",
    posture: "owner-openkey",
    operatorType: "agent",
  }, null, 2));
  await writeFile(join(home, ".tinycloud/config.json"), JSON.stringify({ defaultProfile: "default" }));
  return home;
}
