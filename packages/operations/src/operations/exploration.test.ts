import { describe, expect, test } from "bun:test";

import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import { explorationOperationDefinitions } from "./exploration.js";

const OWNER_PRIMARY =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:primary";
const OWNER_ACCOUNT =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:account";
const OWNER_APPLICATIONS =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";
const ETAG = `"blake3-${"a".repeat(64)}"`;

function definition(id: string) {
  const found = explorationOperationDefinitions.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found as any;
}

function context(node: Record<string, unknown>): RuntimeOperationContext {
  return {
    summary: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:delegate",
      space: OWNER_PRIMARY,
    },
    runtime: { node, granted: [] },
  };
}

function response(data: unknown, headers: Readonly<Record<string, unknown>> = {}) {
  return {
    ok: true as const,
    data: {
      data,
      headers: {
        contentType: "application/json",
        contentLength: 17,
        get: () => null,
        ...headers,
      },
    },
  };
}

describe("account exploration operations", () => {
  test("planner and executor use the same owner account space", async () => {
    const calls: Array<{ space: string; method: string; value?: string }> = [];
    const node = {
      kvForSpace(space: string) {
        calls.push({ space, method: "handle" });
        return {
          async list(options: { prefix: string; limit: number }) {
            calls.push({ space, method: "list", value: `${options.prefix}:${options.limit}` });
            return { ok: true, data: { keys: ["spaces/applications"], truncated: false } };
          },
          async get(key: string, options: { binary: true; maxResponseBytes: number }) {
            calls.push({ space, method: "get", value: `${key}:${options.maxResponseBytes}` });
            return response(new TextEncoder().encode(JSON.stringify({
              space_id: OWNER_APPLICATIONS,
              name: "applications",
              type: "owned",
              permissions: ["tinycloud.kv/get"],
              status: "active",
            })));
          },
        };
      },
    };
    const operation = definition("tinycloud.account.spaces.list");
    const planned = await operation.authority(context(node), {});

    expect(planned).toEqual([{
      service: "tinycloud.kv",
      space: OWNER_ACCOUNT,
      path: "spaces/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
    }]);
    const result = await operation.execute(context(node) as OperationContext, {});
    expect(result).toMatchObject({
      status: "ok",
      output: {
        count: 1,
        spaces: [{ spaceId: OWNER_APPLICATIONS, name: "applications", ownerDid: "", type: "owned" }],
      },
    });
    expect(operation.output.safeParse(result.output).success).toBe(true);
    expect(calls).toEqual([
      { space: OWNER_ACCOUNT, method: "handle" },
      { space: OWNER_ACCOUNT, method: "list", value: "spaces/:1000" },
      { space: OWNER_ACCOUNT, method: "get", value: "spaces/applications:1048576" },
    ]);
  });

  test("lists inline application manifests through the explicit owner account handle", async () => {
    const spaces: string[] = [];
    const node = {
      kvForSpace(space: string) {
        spaces.push(space);
        return {
          async list(options: unknown) {
            expect(options).toEqual({ prefix: "applications/", limit: 1000 });
            return { ok: true, data: { keys: ["applications/com.example.notes"], truncated: false } };
          },
          async get(_key: string, options: unknown) {
            expect(options).toEqual({ binary: true, maxResponseBytes: 1024 * 1024 });
            return response(new TextEncoder().encode(JSON.stringify({
              app_id: "com.example.notes",
              manifests: [{ app_id: "com.example.notes", name: "Notes", knowledge: true }],
              manifest_hash: "abc123",
            })));
          },
        };
      },
    };
    const operation = definition("tinycloud.account.applications.list");
    expect(await operation.authority(context(node), {})).toEqual([{
      service: "tinycloud.kv",
      space: OWNER_ACCOUNT,
      path: "applications/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
    }]);
    expect(await operation.execute(context(node), {})).toMatchObject({
      status: "ok",
      output: {
        count: 1,
        applications: [{ appId: "com.example.notes", name: "Notes", manifestHash: "abc123" }],
      },
    });
    expect(spaces).toEqual([OWNER_ACCOUNT]);
  });

  test("fails closed on truncated or oversized account registries", async () => {
    const operation = definition("tinycloud.account.spaces.list");
    const truncated = await operation.execute(context({
      kvForSpace() {
        return {
          async list(options: unknown) {
            expect(options).toEqual({ prefix: "spaces/", limit: 1000 });
            return { ok: true, data: { keys: [], truncated: true } };
          },
        };
      },
    }), {});
    expect(truncated).toMatchObject({ status: "error", error: { code: "OUTPUT_INVALID" } });

    const oversized = await operation.execute(context({
      kvForSpace() {
        return {
          async list() {
            return { ok: true, data: { keys: ["spaces/oversized"], truncated: false } };
          },
          async get(_key: string, options: unknown) {
            expect(options).toEqual({ binary: true, maxResponseBytes: 1024 * 1024 });
            return response(new Uint8Array(1024 * 1024 + 1));
          },
        };
      },
    }), {});
    expect(oversized).toMatchObject({ status: "error", error: { code: "KV_RESPONSE_TOO_LARGE" } });
  });
});

describe("generic KV exploration operations", () => {
  test("plans root listing exactly and returns only keys", async () => {
    const handles: string[] = [];
    const node = {
      kvForSpace(space: string) {
        handles.push(space);
        return {
          async list(options: unknown) {
            expect(options).toEqual({ limit: 100 });
            return { ok: true, data: { keys: ["documents/one", "documents/two"], truncated: true } };
          },
        };
      },
    };
    const operation = definition("tinycloud.kv.list");
    const input = operation.input.parse({ space: "applications" });
    expect(await operation.authority(context(node), input)).toEqual([{
      service: "tinycloud.kv",
      space: OWNER_APPLICATIONS,
      path: "",
      actions: ["tinycloud.kv/list"],
    }]);
    expect(await operation.execute(context(node), input)).toEqual({
      status: "ok",
      output: {
        space: OWNER_APPLICATIONS,
        prefix: "",
        keys: ["documents/one", "documents/two"],
        count: 2,
        truncated: true,
      },
    });
    expect(handles).toEqual([OWNER_APPLICATIONS]);
  });

  test("plans and reads one exact key", async () => {
    const node = {
      kvForSpace(space: string) {
        expect(space).toBe(OWNER_APPLICATIONS);
        return {
          async get(key: string, options: unknown) {
            expect(key).toBe("documents/one");
            expect(options).toEqual({ binary: true, maxResponseBytes: 1024 * 1024 });
            return response(new TextEncoder().encode(JSON.stringify({ title: "One" })));
          },
        };
      },
    };
    const operation = definition("tinycloud.kv.get");
    const input = operation.input.parse({
      space: "applications",
      key: "documents/one",
      representation: "json",
    });
    expect(await operation.authority(context(node), input)).toEqual([{
      service: "tinycloud.kv",
      space: OWNER_APPLICATIONS,
      path: "documents/one",
      actions: ["tinycloud.kv/get"],
    }]);
    expect(await operation.execute(context(node), input)).toMatchObject({
      status: "ok",
      output: {
        space: OWNER_APPLICATIONS,
        key: "documents/one",
        value: { title: "One" },
        encoding: "json",
        byteLength: 15,
        metadata: { contentType: "application/json", contentLength: 17 },
      },
    });
  });

  test("defaults to a byte-exact base64 representation", async () => {
    const bytes = Uint8Array.from([0, 255, 1, 2]);
    const operation = definition("tinycloud.kv.get");
    const input = operation.input.parse({ space: "applications", key: "files/data.bin" });
    const result = await operation.execute(context({
      kvForSpace() {
        return { async get() { return response(bytes); } };
      },
    }), input);
    expect(result).toMatchObject({
      status: "ok",
      output: { value: "AP8BAg==", encoding: "base64", byteLength: 4 },
    });
  });

  test("plans and executes exact-key head, put, and conditional delete", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const node = {
      kvForSpace(space: string) {
        expect(space).toBe(OWNER_APPLICATIONS);
        return {
          async head(key: string) {
            calls.push({ method: "head", key });
            return response(undefined);
          },
          async put(key: string, value: Uint8Array, options: unknown) {
            calls.push({ method: "put", key, value: [...value], options });
            return response(undefined);
          },
          async delete(key: string, options: unknown) {
            calls.push({ method: "delete", key, options });
            return response(undefined, { etag: ETAG });
          },
        };
      },
    };
    const runtime = context(node);
    const cases = [
      ["tinycloud.kv.head", { space: "applications", key: "documents/one" }, "tinycloud.kv/metadata"],
      ["tinycloud.kv.put", {
        space: "applications", key: "documents/one", mode: "create",
        content: { encoding: "utf8", value: "hello" },
      }, "tinycloud.kv/put"],
      ["tinycloud.kv.delete", {
        space: "applications", key: "documents/one", etag: ETAG,
      }, "tinycloud.kv/del"],
    ] as const;
    for (const [id, raw, action] of cases) {
      const operation = definition(id);
      const input = operation.input.parse(raw);
      expect(await operation.authority(runtime, input)).toEqual([{
        service: "tinycloud.kv", space: OWNER_APPLICATIONS, path: "documents/one", actions: [action],
      }]);
      const result = await operation.execute(runtime, input);
      expect(result.status).toBe("ok");
      if (id === "tinycloud.kv.delete") {
        expect(result).toMatchObject({
          output: { deleted: true, etag: ETAG },
        });
      }
    }
    expect(calls).toEqual([
      { method: "head", key: "documents/one" },
      {
        method: "put", key: "documents/one", value: [104, 101, 108, 108, 111],
        options: { contentType: "text/plain;charset=UTF-8", ifNoneMatch: "*" },
      },
      { method: "delete", key: "documents/one", options: { ifMatch: ETAG } },
    ]);
  });

  test("requires canonical bounded content and an ETag for replace mode", () => {
    const operation = definition("tinycloud.kv.put");
    for (const input of [
      { space: "applications", key: "a", mode: "replace", content: { encoding: "utf8", value: "x" } },
      { space: "applications", key: "a", mode: "create", content: { encoding: "base64", value: "not-base64" } },
      { space: "applications", key: "a", mode: "create", content: { encoding: "utf8", value: "x".repeat(1024 * 1024 + 1) } },
      { space: "applications", key: "a", mode: "create", content: { encoding: "json", value: Number.MAX_SAFE_INTEGER + 1 } },
      { space: "applications", key: "a", mode: "replace", etag: '"v1"', content: { encoding: "utf8", value: "x" } },
    ]) {
      expect(operation.input.safeParse(input).success).toBe(false);
    }
  });

  test("rejects oversized responses and unsafe JSON integers under node version skew", async () => {
    const operation = definition("tinycloud.kv.get");
    for (const [bytes, representation, code] of [
      [new Uint8Array(1024 * 1024 + 1), "base64", "KV_RESPONSE_TOO_LARGE"],
      [new TextEncoder().encode('{"id":9007199254740993}'), "json", "OUTPUT_INVALID"],
    ] as const) {
      const input = operation.input.parse({
        space: "applications",
        key: "documents/one",
        representation,
      });
      const result = await operation.execute(context({
        kvForSpace() {
          return { async get() { return response(bytes); } };
        },
      }), input);
      expect(result).toMatchObject({ status: "error", error: { code } });
    }
  });

  test("surfaces conditional write conflicts as retryable ETag refreshes", async () => {
    const operation = definition("tinycloud.kv.put");
    const input = operation.input.parse({
      space: "applications",
      key: "documents/one",
      mode: "create",
      content: { encoding: "utf8", value: "hello" },
    });
    const result = await operation.execute(context({
      kvForSpace() {
        return {
          async put() {
            return { ok: false, error: { code: "KV_CONFLICT", meta: { status: 503 } } };
          },
        };
      },
    }), input);
    expect(result).toMatchObject({
      status: "error",
      error: { code: "KV_CONFLICT", retryable: true },
    });
  });

  test("rejects every generic KV operation for account and secrets spaces", async () => {
    let handles = 0;
    const runtime = context({
      kvForSpace() {
        handles += 1;
        throw new Error("must not execute");
      },
    });
    for (const [id, input] of [
      ["tinycloud.kv.list", { space: "secrets" }],
      [
        "tinycloud.kv.get",
        {
          space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:secrets",
          key: "vault/secrets/API_KEY",
        },
      ],
      ["tinycloud.kv.head", { space: "account", key: "spaces/applications" }],
      ["tinycloud.kv.put", {
        space: OWNER_ACCOUNT, key: "spaces/applications", mode: "upsert",
        content: { encoding: "json", value: {} },
      }],
      ["tinycloud.kv.delete", { space: "secrets", key: "vault/secrets/API_KEY" }],
    ] as const) {
      const operation = definition(id);
      const parsed = operation.input.parse(input);
      await expect(operation.authority(runtime, parsed)).rejects.toMatchObject({
        operationError: { code: "INPUT_INVALID" },
      });
      expect(await operation.execute(runtime, parsed)).toMatchObject({
        status: "error",
        error: { code: "INPUT_INVALID" },
      });
    }
    expect(handles).toBe(0);
  });
});
