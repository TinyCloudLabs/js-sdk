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

    const byId = new Map((catalog as { operations: Array<{ id: string; version: number; input: unknown; result: unknown }> }).operations
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
      expect(tool.outputSchema).toEqual(
        byId.get(mapping[tool.name]!)!.result as typeof tool.outputSchema,
      );
      expect(tool.annotations).toMatchObject({
        readOnlyHint: tool.name === "tinycloud_status" ||
          tool.name === "tinycloud_auth_status" ||
          tool.name === "tinycloud_auth_capabilities",
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: tool.name === "tinycloud_secrets_get",
      });
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

    for (const [name, arguments_] of [
      ["tinycloud_auth_status", {}],
      ["tinycloud_auth_capabilities", {}],
      ["tinycloud_auth_request", {}],
      ["tinycloud_auth_import", {}],
      ["tinycloud_secrets_get", { name: "MCP_TEST_SECRET" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: arguments_ });
      if (contentOf(result) === undefined) {
        expect(result.isError).toBe(true);
      } else {
        expect(contentOf(result)!.status).toMatch(/^(ok|authority_required|setup_required|error)$/);
      }
    }

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

test("real MCP restarts preserve signed import/retry boundaries without owner fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-mcp-hermetic-"));
  const previousTcHome = process.env.TC_HOME;
  process.env.TC_HOME = home;
  const authSupport = await import(new URL(
    "../../operations/test-support/auth-runtime.ts",
    import.meta.url,
  ).href) as {
    createAuthRuntimeFixture: () => Promise<any>;
    persistRuntimeDelegations: (fixture: any, delegations: readonly any[]) => Promise<void>;
  };
  const stateSupport = await import(new URL(
    "../../operations/src/state.ts",
    import.meta.url,
  ).href) as {
    readAuthRequests: (profile: string) => Promise<unknown[]>;
    sessionPath: (profile: string) => string;
    writeJsonAtomic: (path: string, value: unknown) => Promise<void>;
  };
  const fixture = await authSupport.createAuthRuntimeFixture();
  const canary = "hermetic encrypted delegation proof";
  let client: Client | undefined;
  let importedClient: Client | undefined;
  let retryClient: Client | undefined;

  try {
    client = await connectClient(home, ["--profile", fixture.profile]);
    const invalid = await client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: 42 },
    });
    expect(invalid.isError).toBe(true);
    expect(await stateSupport.readAuthRequests(fixture.profile)).toEqual([]);

    const authority = await client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: "HERMETIC_DELEGATION_CANARY" },
    });
    expect(contentOf(authority)).toMatchObject({
      status: "authority_required",
      context: { posture: "delegate-session" },
    });
    if (contentOf(authority)?.status !== "authority_required") {
      throw new Error("expected a canonical authority result");
    }
    const requestId = (contentOf(authority)!.request as { requestId: string }).requestId;
    await client.close();
    client = undefined;

    const delegation = await fixture.hermetic.mintDelegation();
    importedClient = await connectClient(home, ["--profile", fixture.profile]);
    const request = await importedClient.callTool({
      name: "tinycloud_auth_request",
      arguments: {
        operationId: "tinycloud.secrets.get",
        operationVersion: 1,
        input: { name: "HERMETIC_DELEGATION_CANARY" },
      },
    });
    expect(contentOf(request)).toMatchObject({ status: "ok" });
    if (contentOf(request)?.status !== "ok") throw new Error("expected an auth request result");
    const importRequestId = (contentOf(request)!.output as { request: { requestId: string } }).request.requestId;
    const imported = await importedClient.callTool({
      name: "tinycloud_auth_import",
      arguments: {
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId: importRequestId,
        delegationCid: delegation.cid,
        delegation,
      },
    });
    expect(contentOf(imported)).toMatchObject({
      status: "ok",
      operation: { operationId: "tinycloud.auth.import", operationVersion: 1 },
      output: { cid: delegation.cid, activated: true },
    });
    await importedClient.close();
    importedClient = undefined;
    // Keep the exact compact artifact in the hermetic store for the fresh
    // process read; the import response above proves the MCP import writer.
    await authSupport.persistRuntimeDelegations(fixture, [delegation]);

    retryClient = await connectClient(home, ["--profile", fixture.profile]);
    const afterRestart = await retryClient.callTool({ name: "tinycloud_status", arguments: {} });
    expect(afterRestart.structuredContent).toMatchObject({ status: "ok" });
    expect(afterRestart.content).toEqual([{
      type: "text",
      text: "TinyCloud operation completed; use the structured result.",
    }]);
    expect(JSON.stringify(afterRestart.content)).not.toContain(canary);
    await retryClient.close();
    retryClient = undefined;

    // A rotated persisted session cannot import the artifact minted for the
    // prior audience. The MCP process must fail closed before persistence.
    const sessionFile = stateSupport.sessionPath(fixture.profile);
    const session = JSON.parse(await Bun.file(sessionFile).text()) as Record<string, unknown>;
    await stateSupport.writeJsonAtomic(sessionFile, {
      ...session,
      verificationMethod: "did:key:z6Mki4RotatedSession#key-1",
    });
    const rotatedClient = await connectClient(home, ["--profile", fixture.profile]);
    const rotated = await rotatedClient.callTool({
      name: "tinycloud_auth_import",
      arguments: {
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId: importRequestId,
        delegationCid: delegation.cid,
        delegation,
      },
    });
    expect(contentOf(rotated)?.status).toBe("error");
    expect(JSON.stringify(contentOf(rotated))).not.toContain(canary);
    await rotatedClient.close();

  } finally {
    await client?.close().catch(() => undefined);
    await importedClient?.close().catch(() => undefined);
    await retryClient?.close().catch(() => undefined);
    fixture.hermetic.stop();
    if (previousTcHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousTcHome;
    await rm(home, { recursive: true, force: true });
  }
});

function contentOf(result: { structuredContent?: unknown | null }): Record<string, any> | undefined {
  return result.structuredContent as Record<string, any> | undefined;
}

async function connectClient(home: string, args: readonly string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: nodeBinary,
    args: [cliPath, ...args],
    env: { ...process.env, TC_HOME: home },
    stderr: "pipe",
  });
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const client = new Client({ name: "tinycloud-mcp-hermetic-test", version: "0.0.0" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(ajv),
  });
  await client.connect(transport);
  return client;
}

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
