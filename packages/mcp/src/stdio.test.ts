import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    const expectedToolResults = [
      ["tinycloud_auth_status", {}, { status: "ok", operation: { operationId: "tinycloud.auth.status", operationVersion: 1 } }],
      ["tinycloud_auth_capabilities", {}, { status: "error", operation: { operationId: "tinycloud.auth.capabilities", operationVersion: 1 }, error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" } }],
      ["tinycloud_auth_request", { requestId: "missing-request" }, { status: "error", operation: { operationId: "tinycloud.auth.request", operationVersion: 1 }, error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" } }],
      ["tinycloud_auth_import", validImportProbe(), { status: "error", operation: { operationId: "tinycloud.auth.import", operationVersion: 1 }, error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" } }],
      ["tinycloud_secrets_get", { name: "MCP_TEST_SECRET" }, { status: "error", operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 }, error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" } }],
    ] as const;
    for (const [name, arguments_, expected] of expectedToolResults) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(contentOf(result)).toMatchObject(expected);
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

test("owner data requires opt-in and explicit opt-in passes the gate for both owner postures", async () => {
  const defaultHome = await fixtureHome();
  const defaultClient = await connectClient(defaultHome, []);
  try {
    const status = await defaultClient.client.callTool({ name: "tinycloud_auth_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ status: "ok" });
    const secret = await defaultClient.client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: "MCP_TEST_SECRET" },
    });
    expect(secret.structuredContent).toMatchObject({
      status: "error",
      error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" },
    });
  } finally {
    await defaultClient.client.close();
  }

  for (const posture of ["owner-openkey", "local-owner-key"] as const) {
    const home = await fixtureHome({
      profile: posture,
      posture,
      ...(posture === "local-owner-key"
        ? { authMethod: "local", privateKey: `0x${"1".repeat(64)}` }
        : {}),
    });
    const connected = await connectClient(home, ["--profile", posture, "--allow-owner-profile"]);
    try {
      const result = await connected.client.callTool({
        name: "tinycloud_secrets_get",
        arguments: { name: "MCP_TEST_SECRET" },
      });
      const envelope = contentOf(result);
      expect(envelope).toBeDefined();
      expect(envelope?.error?.code).not.toBe("PROFILE_OWNER_OPT_IN_REQUIRED");
      expect(connected.stderr()).not.toContain("MCP_TEST_SECRET");
      expect(connected.stderr().length).toBeLessThanOrEqual(4096);
    } finally {
      await connected.client.close();
      await rm(home, { recursive: true, force: true });
    }
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

test("three real MCP processes request, import, restart, and retry the original secret", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-mcp-hermetic-"));
  const previousTcHome = process.env.TC_HOME;
  process.env.TC_HOME = home;
  const authSupport = await import(new URL(
    "../../operations/test-support/auth-runtime.ts",
    import.meta.url,
  ).href) as {
    createAuthRuntimeFixture: (options?: Record<string, unknown>) => Promise<any>;
  };
  const stateSupport = await import(new URL(
    "../../operations/src/state.ts",
    import.meta.url,
  ).href) as {
    readAuthRequests: (profile: string) => Promise<unknown[]>;
    readAdditionalDelegations: (profile: string) => Promise<unknown[]>;
  };
  const canary = "hermetic encrypted delegation proof";
  const fixture = await authSupport.createAuthRuntimeFixture({ secretPayloadValue: canary });
  let client: ConnectedClient | undefined;
  let importedClient: ConnectedClient | undefined;
  let retryClient: ConnectedClient | undefined;

  try {
    client = await connectClient(home, ["--profile", fixture.profile]);
    const invalid = await client.client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: 42 },
    });
    expect(invalid.isError).toBe(true);
    expect(await stateSupport.readAuthRequests(fixture.profile)).toEqual([]);

    const authority = await client.client.callTool({
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
    expect((contentOf(authority)!.request as Record<string, unknown>).kind).toBe("tinycloud.auth.request");
    await client.client.close();
    client = undefined;

    const delegation = await fixture.hermetic.mintDelegation();
    importedClient = await connectClient(home, ["--profile", fixture.profile]);
    const imported = await importedClient.client.callTool({
      name: "tinycloud_auth_import",
      arguments: {
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId,
        delegationCid: delegation.cid,
        delegation,
      },
    });
    expect(contentOf(imported)).toMatchObject({
      status: "ok",
      operation: { operationId: "tinycloud.auth.import", operationVersion: 1 },
      output: { cid: delegation.cid, activated: true },
    });
    expect(await stateSupport.readAdditionalDelegations(fixture.profile)).toEqual([
      expect.objectContaining({ delegation: expect.objectContaining({ cid: delegation.cid }) }),
    ]);
    await importedClient.client.close();
    importedClient = undefined;

    retryClient = await connectClient(home, ["--profile", fixture.profile]);
    const afterRestart = await retryClient.client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: "HERMETIC_DELEGATION_CANARY" },
    });
    expect(contentOf(afterRestart)).toMatchObject({
      status: "ok",
      output: { value: canary },
    });
    expect(JSON.stringify(afterRestart.content)).not.toContain(canary);
    expect(JSON.stringify({ ...afterRestart, structuredContent: undefined })).not.toContain(canary);
    expect(retryClient.stderr()).not.toContain(canary);
    expect(retryClient.stderr().length).toBeLessThanOrEqual(4096);
    fixture.hermetic.assertNarrowDelegatedReadAndDecrypt(delegation, fixture.sessionDid);
    for (const file of ["profile.json", "session.json", "auth-requests.json", "additional-delegations.json"]) {
      const persisted = await readFile(join(home, ".tinycloud/profiles", fixture.profile, file), "utf8");
      expect(persisted).not.toContain(canary);
    }
    await retryClient.client.close();
    retryClient = undefined;

    // An artifact minted for another session audience must fail closed before
    // persistence, as a stale artifact does after session rotation.
    const rotatedDelegation = await fixture.hermetic.mintDelegationForAudience(
      fixture.hermetic.unrelatedAudience,
    );
    const rotatedClient = await connectClient(home, ["--profile", fixture.profile]);
    const beforeRotatedImport = JSON.stringify(await stateSupport.readAdditionalDelegations(fixture.profile));
    const rotated = await rotatedClient.client.callTool({
      name: "tinycloud_auth_import",
      arguments: {
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId,
        delegationCid: rotatedDelegation.cid,
        delegation: rotatedDelegation,
      },
    });
    expect(contentOf(rotated)).toMatchObject({
      status: "error",
      error: { code: "DELEGATION_AUDIENCE_MISMATCH" },
    });
    expect(JSON.stringify(await stateSupport.readAdditionalDelegations(fixture.profile))).toBe(beforeRotatedImport);
    expect(JSON.stringify(contentOf(rotated))).not.toContain(canary);
    expect(rotatedClient.stderr()).not.toContain(canary);
    await rotatedClient.client.close();

  } finally {
    await client?.client.close().catch(() => undefined);
    await importedClient?.client.close().catch(() => undefined);
    await retryClient?.client.close().catch(() => undefined);
    fixture.hermetic.stop();
    if (previousTcHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousTcHome;
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

test("an authorized missing secret returns only the value-free setup action", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-mcp-setup-"));
  const previousTcHome = process.env.TC_HOME;
  process.env.TC_HOME = home;
  const authSupport = await import(new URL(
    "../../operations/test-support/auth-runtime.ts",
    import.meta.url,
  ).href) as {
    createAuthRuntimeFixture: (options?: Record<string, unknown>) => Promise<any>;
  };
  const fixture = await authSupport.createAuthRuntimeFixture({ secretPresent: false });
  let requestClient: ConnectedClient | undefined;
  let importClient: ConnectedClient | undefined;
  try {
    requestClient = await connectClient(home, ["--profile", fixture.profile]);
    const authority = await requestClient.client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: "HERMETIC_DELEGATION_CANARY" },
    });
    expect(contentOf(authority)?.status).toBe("authority_required");
    const requestId = (contentOf(authority)!.request as { requestId: string }).requestId;
    const delegation = await fixture.hermetic.mintDelegation();
    await requestClient.client.close();
    requestClient = undefined;

    importClient = await connectClient(home, ["--profile", fixture.profile]);
    const imported = await importClient.client.callTool({
      name: "tinycloud_auth_import",
      arguments: {
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId,
        delegationCid: delegation.cid,
        delegation,
      },
    });
    expect(contentOf(imported)).toMatchObject({ status: "ok", output: { cid: delegation.cid } });
    const absent = await importClient.client.callTool({
      name: "tinycloud_secrets_get",
      arguments: { name: "HERMETIC_DELEGATION_CANARY" },
    });
    expect(contentOf(absent)).toMatchObject({
      status: "setup_required",
      setup: {
        kind: "secret_manager",
        url: expect.stringMatching(/^https:\/\//),
        message: expect.any(String),
      },
    });
    const setup = contentOf(absent)!.setup as Record<string, any>;
    expect(JSON.stringify(setup)).toContain("HERMETIC_DELEGATION_CANARY");
    expect(JSON.stringify(setup)).not.toContain("value");
    expect(JSON.stringify(absent.content)).not.toContain("HERMETIC_DELEGATION_CANARY");
    expect(importClient.stderr()).not.toContain("HERMETIC_DELEGATION_CANARY");
  } finally {
    await requestClient?.client.close().catch(() => undefined);
    await importClient?.client.close().catch(() => undefined);
    fixture.hermetic.stop();
    if (previousTcHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousTcHome;
    await rm(home, { recursive: true, force: true });
  }
});

function contentOf(result: { structuredContent?: unknown | null }): Record<string, any> | undefined {
  return result.structuredContent as Record<string, any> | undefined;
}

interface ConnectedClient {
  readonly client: Client;
  readonly stderr: () => string;
}

async function connectClient(home: string, args: readonly string[]): Promise<ConnectedClient> {
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
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

function validImportProbe(): Record<string, unknown> {
  return {
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: "missing-request",
    delegationCid: "bafy-probe",
    delegation: {
      cid: "bafy-probe",
      spaceId: "tinycloud:space",
      path: "vault/secrets/MCP_TEST_SECRET",
      actions: ["tinycloud.kv/get"],
      delegateDID: "did:key:z6MkiSession",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      chainId: 1,
      expiry: "2030-01-01T00:00:00.000Z",
      delegationHeader: { Authorization: "Bearer probe" },
    },
  };
}

async function fixtureHome(options: Readonly<{
  profile?: string;
  posture?: "owner-openkey" | "local-owner-key";
  authMethod?: "openkey" | "local";
  privateKey?: string;
}> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-mcp-i4-"));
  homes.push(home);
  const profile = options.profile ?? "default";
  const profileDirectory = join(home, ".tinycloud/profiles", profile);
  await Bun.write(join(profileDirectory, "profile.json"), JSON.stringify({
    name: profile,
    host: "https://node.example",
    chainId: 1,
    spaceName: "secrets",
    did: "did:key:z6MkjMCPFixture",
    createdAt: "2026-07-16T00:00:00.000Z",
    posture: options.posture ?? "owner-openkey",
    operatorType: "agent",
    ...(options.authMethod === undefined ? {} : { authMethod: options.authMethod }),
    ...(options.privateKey === undefined ? {} : { privateKey: options.privateKey }),
  }, null, 2));
  await writeFile(join(home, ".tinycloud/config.json"), JSON.stringify({ defaultProfile: profile }));
  return home;
}
