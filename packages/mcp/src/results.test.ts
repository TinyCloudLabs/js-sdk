import { expect, test } from "bun:test";
import { KVService } from "@tinycloud/node-sdk";

import { toMcpToolResult } from "./results.js";
import { TOOL_BINDINGS } from "./tools.js";

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

const space = "tinycloud:pkh:eip155:1:0xabc:default";

function kvRefusal(body: string | object): KVService {
  const service = new KVService({});
  const text = typeof body === "string" ? body : JSON.stringify(body);
  service.initialize({
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: space,
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: () => ({ Authorization: "Bearer invocation" }),
    fetch: async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: { get: () => null },
      json: async () => body,
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      blob: async () => new Blob([text]),
    }),
    hosts: ["https://node.tinycloud.test"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: {
      maxAttempts: 1,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 1000,
      retryableErrors: [],
    },
  });
  return service;
}

async function projectedRefusal(error: unknown): Promise<Record<string, unknown>> {
  const { authorizationFailure } = await import(new URL(
    "../../operations/src/kv-failure.ts",
    import.meta.url,
  ).href) as {
    authorizationFailure: (error: unknown, action: string) => { status: string; error: { code: string } } | undefined;
  };
  const outcome = authorizationFailure(error, "list keys");
  if (outcome?.status !== "error") throw new Error("expected an authorization refusal");
  return toMcpToolResult({
    status: "error",
    operation: { operationId: "tinycloud.kv.list", operationVersion: 1 },
    context: { profile: "delegate" },
    error: outcome.error,
  }).structuredContent;
}

test("MCP classifies root and trailing-prefix KV list refusals as missing capability", async () => {
  for (const prefix of ["", "vault/"]) {
    const resource = `${space}/kv/${prefix}`;
    const service = kvRefusal(`Unauthorized Action: ${resource} / tinycloud.kv/list`);
    const result = await service.list(prefix ? { prefix } : {});
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.error.meta).toMatchObject({
      resource,
      requiredAction: "tinycloud.kv/list",
    });
    expect(await projectedRefusal(result.error)).toMatchObject({
      status: "error",
      error: { code: "PERMISSION_DENIED" },
    });
  }
});

test("MCP classifies matching structured and textual KV permission hints identically", async () => {
  const path = "vault/record";
  const permissionHint = {
    service: "tinycloud.kv",
    space,
    path,
    actions: ["tinycloud.kv/get"],
  };
  for (const body of [
    { permissionHint },
    `Unauthorized Action: ${path} / tinycloud.kv/get`,
  ]) {
    const result = await kvRefusal(body).get(path);
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.error.meta).toMatchObject({
      resource: `${space}/kv/${path}`,
      requiredAction: "tinycloud.kv/get",
    });
    expect(await projectedRefusal(result.error)).toMatchObject({
      status: "error",
      error: { code: "PERMISSION_DENIED" },
    });
  }
});

function migrationError(operationId: string) {
  return {
    status: "error" as const,
    operation: { operationId: "tinycloud.secrets.status", operationVersion: 1 },
    context: { profile: "agent" },
    error: {
      code: "PROFILE_MIGRATION_REQUIRED",
      message: "Profile migration is required.",
      retryable: false,
      details: {
        recovery: { action: "complete_migration", command: "tc --profile agent auth caps", operationId },
      },
    },
  };
}

test("complete_migration recovery names the bound tool from the binding table", () => {
  const projected = toMcpToolResult(migrationError("tinycloud.auth.capabilities"), TOOL_BINDINGS);
  expect(projected.structuredContent.error).toEqual({
    code: "PROFILE_MIGRATION_REQUIRED",
    message: "Profile migration is required.",
    retryable: false,
    details: {
      recovery: {
        action: "complete_migration",
        command: "tc --profile agent auth caps",
        operationId: "tinycloud.auth.capabilities",
        tool: "tinycloud_auth_capabilities",
      },
    },
  });
});

test("complete_migration recovery for an unbound operationId gets no tool", () => {
  const input = migrationError("tinycloud.unknown.operation");
  const projected = toMcpToolResult(input, TOOL_BINDINGS);
  expect(projected.structuredContent).toEqual(input);
  expect(JSON.stringify(projected)).not.toContain('"tool"');
});

test("sign_in recovery is never given a tool", () => {
  const input = {
    status: "error" as const,
    operation: { operationId: "tinycloud.secrets.status", operationVersion: 1 },
    context: { profile: "agent" },
    error: {
      code: "SESSION_NOT_FOUND",
      details: { recovery: { action: "sign_in", command: "tc --profile agent auth login --method local" } },
    },
  };
  expect(toMcpToolResult(input, TOOL_BINDINGS).structuredContent).toEqual(input);
});
