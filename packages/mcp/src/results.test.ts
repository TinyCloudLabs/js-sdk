import { expect, test } from "bun:test";
import { KVService } from "@tinycloud/node-sdk";

import { toMcpToolResult } from "./results.js";
import { TOOL_BINDINGS } from "./tools.js";

test("hosted results expose readable canonical data while local stdio stays status-only", () => {
  const envelope = {
    status: "ok" as const,
    operation: { operationId: "tinycloud.kv.get", operationVersion: 1 },
    context: {},
    output: { value: { weight: 80.5 } },
  };
  const hosted = toMcpToolResult(envelope, [], {
    surface: "hosted", readOnly: true, operationId: "tinycloud.kv.get",
  });
  expect(JSON.parse(hosted.content[0].text.split("\n").slice(1).join("\n"))).toEqual(envelope);
  expect(toMcpToolResult(envelope).content[0].text).not.toContain("80.5");
});

test("hosted secrets remain structured-only but authority links remain readable", () => {
  const options = { surface: "hosted" as const, readOnly: true, operationId: "tinycloud.secrets.get" };
  const secret = toMcpToolResult({
    status: "ok", operation: {}, context: {}, output: { value: "secret-canary" },
  }, [], options);
  expect(secret.structuredContent.output).toEqual({ value: "secret-canary" });
  expect(secret.content[0].text).not.toContain("secret-canary");
  const approval = toMcpToolResult({
    status: "authority_required", operation: {}, context: {},
    approval: { url: "https://mcp.test/connect?state=approval" },
  }, [], options);
  expect(approval.content[0].text).toContain("https://mcp.test/connect?state=approval");
});

test("hosted read cap preserves the exact boundary and reports canonical narrowing errors", () => {
  for (const [operationId, code] of [
    ["tinycloud.kv.get", "KV_RESPONSE_TOO_LARGE"],
    ["tinycloud.sql.query", "SQL_RESULT_LIMIT_EXCEEDED"],
    ["tinycloud.apps.query", "SQL_RESULT_LIMIT_EXCEEDED"],
  ]) {
    const envelope = {
      status: "ok" as const, operation: { operationId, operationVersion: 1 }, context: {}, output: { value: "" },
    };
    envelope.output.value = "x".repeat(100_000 - JSON.stringify(envelope).length);
    const options = { surface: "hosted" as const, readOnly: true, operationId };
    expect(toMcpToolResult(envelope, [], options).structuredContent).toEqual(envelope);
    envelope.output.value += "x";
    const capped = toMcpToolResult(envelope, [], options);
    expect(capped.structuredContent).toMatchObject({
      status: "error", operation: envelope.operation, context: {},
      error: { code, retryable: false },
    });
    expect(capped.structuredContent.output).toBeUndefined();
    expect(JSON.parse(capped.content[0].text.split("\n").slice(1).join("\n"))).toEqual(capped.structuredContent);
    expect(capped.structuredContent.error).toMatchObject({ message: expect.stringMatching(/fewer|narrow/i) });
    expect(toMcpToolResult(envelope).structuredContent).toEqual(envelope);
  }
});

test("large write outcomes are never replaced with a retry-inducing size error", () => {
  const envelope = {
    status: "ok" as const, operation: { operationId: "tinycloud.apps.write", operationVersion: 1 }, context: {},
    output: { ops: [{ key: "record", outcome: "ok", value: "x".repeat(100_001) }] },
  };
  for (const readOnly of [false, undefined]) {
    const projected = toMcpToolResult(envelope, [], {
      surface: "hosted", readOnly, operationId: "tinycloud.apps.write",
    });
    expect(projected.structuredContent).toEqual(envelope);
    expect(projected.content[0].text).toContain(JSON.stringify(envelope.output));
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
