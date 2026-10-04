import { afterEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { KVService, SQLService, SpaceService } from "@tinycloud/sdk-core";
import type { SpaceServiceConfig } from "@tinycloud/sdk-core";

const SPACE = "tinycloud:pkh:eip155:1:0xabc:default";
let node: Record<string, unknown>;

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "cli-review", host: "https://node.test" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => node }));
mock.module("../lib/space.js", () => ({ resolveSpaceUri: async () => undefined }));
mock.module("../lib/host.js", () => ({
  unhostedSpaceError: async () => null,
  isRootAuthority: async () => false,
  ownerDidFromSpaceUri: () => null,
  resolveHostSpace: async (value: string) => value,
  spaceNameFromUri: (value: string) => value,
}));

// The CLI command modules must load after the profile and SDK boundary mocks.
const { registerKvCommand } = await import("./kv.js");
const { registerSqlCommand } = await import("./sql.js");
const { registerSpaceCommand } = await import("./space.js");

function serviceContext(status: number, body: string) {
  return {
    session: { delegationHeader: { Authorization: "Bearer fixture" }, spaceId: SPACE },
    isAuthenticated: true,
    invoke: () => ({ Authorization: "Bearer fixture" }),
    fetch: async () => new Response(body, { status }),
    hosts: ["https://node.test"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
  } as unknown as Parameters<KVService["initialize"]>[0];
}

function kvNode(status: number, body: string): void {
  const kv = new KVService();
  kv.initialize(serviceContext(status, body));
  node = { kv };
}

async function captureCommand(command: "kv" | "sql" | "space", args: string[]) {
  const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const originalWrite = stderr.write;
  const originalExit = process.exit;
  let rendered = "";
  let exitCode: number | undefined;
  stderr.write = (chunk: unknown) => { rendered += String(chunk); return true; };
  process.exit = ((code?: number): never => {
    exitCode = code;
    throw new Error("expected process exit");
  }) as typeof process.exit;
  try {
    const program = new Command();
    ({ kv: registerKvCommand, sql: registerSqlCommand, space: registerSpaceCommand })[command](program);
    await expect(program.parseAsync(["node", "tc", command, ...args], { from: "node" })).rejects.toThrow("expected process exit");
  } finally {
    stderr.write = originalWrite;
    process.exit = originalExit;
  }
  return { exitCode, error: JSON.parse(rendered).error as { code: string; message: string; hint?: string; meta?: Record<string, unknown> } };
}

afterEach(() => { node = {}; });

test("KV 403 JWK wording remains permission denied through real handleError", async () => {
  kvNode(403, "Missing private key parameter in JWK");
  const result = await captureCommand("kv", ["get", "vault/item"]);
  expect(result.exitCode).toBe(5);
  expect(result.error).toMatchObject({ code: "PERMISSION_DENIED", meta: { status: 403 } });
});

test("KV 500 JWK wording remains a non-auth service failure", async () => {
  kvNode(500, "Missing private key parameter in JWK");
  const result = await captureCommand("kv", ["get", "vault/item"]);
  expect(result.exitCode).toBe(1);
  expect(result.error.code).toBe("NETWORK_ERROR");
});

test.each([401, 403].flatMap((status) =>
  (["empty", "forbidden", "expired", "capability"] as const).map((bodyKind) => ({ status, bodyKind }))
))("KV HTTP $status ($bodyKind) keeps the verdict through all five commands", async ({ status, bodyKind }) => {
  const commands = [
    { args: ["get", "vault/item"], path: "vault/item", action: "get" },
    { args: ["put", "vault/item", "value"], path: "vault/item", action: "put" },
    { args: ["head", "vault/item"], path: "vault/item", action: "metadata" },
    { args: ["delete", "vault/item"], path: "vault/item", action: "del" },
    { args: ["list", "--prefix", "vault"], path: "vault", action: "list" },
  ] as const;
  for (const { args, path, action } of commands) {
    const body = bodyKind === "capability"
      ? `Unauthorized Action: ${SPACE}/kv/${path} / tinycloud.kv/${action}`
      : bodyKind === "expired" ? "session expired" : bodyKind === "forbidden" ? "Forbidden" : "";
    kvNode(status, body);
    const result = await captureCommand("kv", [...args]);
    const denied = status === 403 || bodyKind === "capability";
    expect(result.exitCode).toBe(denied ? 5 : 3);
    expect(result.error.code).toBe(denied ? "PERMISSION_DENIED" : "AUTH_REQUIRED");
    expect(result.error.meta).toEqual(bodyKind === "capability"
      ? { status, resource: `${SPACE}/kv/${path}`, requiredAction: `tinycloud.kv/${action}` }
      : { status });
    expect(result.error.hint === undefined).toBe(bodyKind !== "capability");
  }
});

test("KV 401 with an exact missing capability requests a grant rather than a login", async () => {
  kvNode(401, `Unauthorized Action: ${SPACE}/kv/vault/item / tinycloud.kv/get`);
  const result = await captureCommand("kv", ["get", "vault/item"]);
  expect(result.exitCode).toBe(5);
  expect(result.error).toMatchObject({ code: "PERMISSION_DENIED", meta: {
    status: 401,
    resource: `${SPACE}/kv/vault/item`,
    requiredAction: "tinycloud.kv/get",
  } });
  expect(result.error.hint).toContain("tc auth request --cap");
});

test("KV body cannot inject a foreign resource into JSON capability metadata or hint", async () => {
  kvNode(403, "Unauthorized Action: https://foreign.invalid/path#fragment / tinycloud.kv/get");
  const result = await captureCommand("kv", ["get", "vault/item"]);
  expect(result.exitCode).toBe(5);
  expect(result.error.meta).toEqual({ status: 403 });
  expect(result.error.hint).toBeUndefined();
});

test("SQL 401 preserves the validated capability hint through real handleError", async () => {
  const sql = new SQLService();
  sql.initialize(serviceContext(401, `Unauthorized Action: ${SPACE}/sql/default / tinycloud.sql/read`));
  node = { sql };
  const result = await captureCommand("sql", ["query", "SELECT 1"]);
  expect(result.exitCode).toBe(5);
  expect(result.error).toMatchObject({ code: "PERMISSION_DENIED", meta: {
    status: 401,
    resource: `${SPACE}/sql/default`,
    requiredAction: "tinycloud.sql/read",
  } });
  expect(result.error.hint).toContain("tinycloud.sql:default:default:read");
});

test.each([
  { status: 401, body: "Forbidden", code: "AUTH_REQUIRED", exitCode: 3 },
  { status: 403, body: "session expired", code: "PERMISSION_DENIED", exitCode: 5 },
] as const)("SQL $status without a valid capability follows status over wording", async ({ status, body, code, exitCode }) => {
  const sql = new SQLService();
  sql.initialize(serviceContext(status, body));
  node = { sql };
  const result = await captureCommand("sql", ["query", "SELECT 1"]);
  expect(result.exitCode).toBe(exitCode);
  expect(result.error).toMatchObject({ code, meta: { status } });
  expect(result.error.hint).toBeUndefined();
});

test.each([401, 403] as const)("space list HTTP %i from real SpaceService cannot print an empty success", async (status) => {
  const spaces = new SpaceService({
    session: { delegationHeader: { Authorization: "Bearer fixture" }, spaceId: SPACE } as SpaceServiceConfig["session"],
    hosts: ["https://node.test"],
    invoke: () => ({ Authorization: "Bearer fixture" }),
    fetch: async () => new Response("session expired", { status }),
  });
  node = { spaces };
  const result = await captureCommand("space", ["list"]);
  expect(result.exitCode).toBe(status === 401 ? 3 : 5);
  expect(result.error).toMatchObject({ code: status === 401 ? "AUTH_REQUIRED" : "PERMISSION_DENIED", meta: { status } });
});
