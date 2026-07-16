import { describe, expect, test } from "bun:test";

import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import { explorationOperationDefinitions } from "./exploration.js";

const OWNER_PRIMARY =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:primary";
const OWNER_ACCOUNT =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:account";
const OWNER_APPLICATIONS =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";

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

function response(data: unknown) {
  return {
    ok: true as const,
    data: {
      data,
      headers: {
        contentType: "application/json",
        contentLength: 17,
        get: () => null,
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
          async list(options: { prefix: string }) {
            calls.push({ space, method: "list", value: options.prefix });
            return { ok: true, data: { keys: ["spaces/applications"] } };
          },
          async get(key: string) {
            calls.push({ space, method: "get", value: key });
            return response({
              space_id: OWNER_APPLICATIONS,
              name: "applications",
              type: "owned",
              permissions: ["tinycloud.kv/get"],
              status: "active",
            });
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
      { space: OWNER_ACCOUNT, method: "list", value: "spaces/" },
      { space: OWNER_ACCOUNT, method: "get", value: "spaces/applications" },
    ]);
  });

  test("lists inline application manifests through the explicit owner account handle", async () => {
    const spaces: string[] = [];
    const node = {
      kvForSpace(space: string) {
        spaces.push(space);
        return {
          async list() {
            return { ok: true, data: { keys: ["applications/com.example.notes"] } };
          },
          async get() {
            return response({
              app_id: "com.example.notes",
              manifests: [{ app_id: "com.example.notes", name: "Notes", knowledge: true }],
              manifest_hash: "abc123",
            });
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
});

describe("generic KV exploration operations", () => {
  test("plans root listing exactly and returns only keys", async () => {
    const handles: string[] = [];
    const node = {
      kvForSpace(space: string) {
        handles.push(space);
        return {
          async list(options: unknown) {
            expect(options).toBeUndefined();
            return { ok: true, data: { keys: ["documents/one", "documents/two"] } };
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
      },
    });
    expect(handles).toEqual([OWNER_APPLICATIONS]);
  });

  test("plans and reads one exact key", async () => {
    const node = {
      kvForSpace(space: string) {
        expect(space).toBe(OWNER_APPLICATIONS);
        return {
          async get(key: string) {
            expect(key).toBe("documents/one");
            return response({ title: "One" });
          },
        };
      },
    };
    const operation = definition("tinycloud.kv.get");
    const input = operation.input.parse({ space: "applications", key: "documents/one" });
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
        metadata: { contentType: "application/json", contentLength: 17 },
      },
    });
  });

  test("rejects generic list and get access to every secrets-space spelling", async () => {
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
