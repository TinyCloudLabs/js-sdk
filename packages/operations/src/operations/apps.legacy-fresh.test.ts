import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import { createOrReusePermissionRequest } from "../artifacts.js";
import { evaluateOperationAuthority } from "../authority.js";
import type { RuntimeOperationContext } from "../contract.js";
import { operationSpaceResolver } from "../secrets.js";
import type { AppsPermission } from "../tc-apps/kv.js";
import { definition, DEFAULT_SPACE, type FakeKv, FITNESS, fixture, key, SPACE, withGrants, write } from "./apps.fixtures.js";

// A fresh connection on an account that already has records under the original
// xyz.tinycloud.agent-data/ layout (default space). OpenKey signs one space per approval, and the original layout
// lives in the default space while new apps live in the applications space, so the original app list can only be
// a separate, second approval. It is asked for only when a call names an app that is not in the new area, or
// creates an app: those are the calls where a same-named older app matters.
const ID = "xyz.tinycloud.tinyapps.";
const DISCOVERY = `${ID}catalog/`;
const OLDER_ROOT = "xyz.tinycloud.agent-data/";
const READ = ["tinycloud.kv/get", "tinycloud.kv/list"];
const kvScope = (space: string, path: string, actions: string[]) => ({ service: "tinycloud.kv", space, path, actions });
const newDiscovery = kvScope(SPACE, DISCOVERY, READ);
const legacyDiscovery = kvScope(DEFAULT_SPACE, `${OLDER_ROOT}catalog/`, READ);
const todos = { app: "todos", title: "Todos", about: "Tasks", created: "2026-11-03" };
const todoKind = { app: "todos", kind: "todo", about: "Tasks", shape: "item", states: ["open", "done"], v: 1, fields: { title: "text" }, created: "2026-11-03" };
const createTodos = [
  { op: "put", key: `${ID}todos/catalog`, value: todos },
  { op: "put", key: `${DISCOVERY}todos/entry`, value: { v: 1, app: "todos", id: `${ID}todos`, title: "Todos" } },
];
/** A complete first create, in the order the rules give: app catalog, first kind, discovery entry, first record. */
const createTodosFull = [
  createTodos[0]!,
  { op: "put", key: `${ID}todos/catalog/todo`, value: todoKind },
  createTodos[1]!,
  { op: "put", key: `${ID}todos/todo/open/2026-11-18-new`, value: { data: { title: "New" } } },
];
const fitnessUpdate = { op: "put", key: `${FITNESS}catalog`, etag: `"blake3-${"a".repeat(64)}"`, value: { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14" } };

function seedLegacy(legacy: { seed(key: string, value: unknown): string }) {
  legacy.seed(`${OLDER_ROOT}catalog/todos`, todos);
  legacy.seed(`${OLDER_ROOT}catalog/todos/todo`, todoKind);
  legacy.seed(`${OLDER_ROOT}todos/todo/open/2026-11-03-existing`, { v: 1, at: "2026-11-03", data: { title: "Existing" } });
}
/** Every default-space read fails per key the way the SDK reports a single-key read failure. */
function failLegacyReads(legacy: FakeKv, error: { code: string; message: string; meta: Record<string, unknown> }) {
  legacy.batchGet = async (keys: string[]) => {
    legacy.reads.push(keys);
    return { ok: true as const, data: { results: keys.map((key) => ({ key, result: { ok: false as const, error } })) } };
  };
}
const spacesOf = (permissions: readonly AppsPermission[]) => [...new Set(permissions.map((permission) => permission.space))];
const granted = (permissions: readonly AppsPermission[]) => permissions.map((permission) => ({ ...permission }));
const asked = async (name: "context" | "write", context: RuntimeOperationContext, input: unknown) =>
  await definition(name).authority(context, input) as AppsPermission[];
const resolver = (context: RuntimeOperationContext) => operationSpaceResolver(context.runtime!.node, context.summary.space);
const satisfied = (context: RuntimeOperationContext, wanted: readonly AppsPermission[]) =>
  evaluateOperationAuthority(context.runtime!.granted as unknown as readonly PermissionEntry[], wanted as never, resolver(context)).satisfied;
/** Grants the whole first approval a fresh connection is asked for, so the next ask is the only thing left. */
async function afterFirstApproval(context: RuntimeOperationContext, name: "context" | "write", input: unknown) {
  const first = await asked(name, context, input);
  expect(spacesOf(first)).toEqual([SPACE]);
  return withGrants(context, [...(context.runtime!.granted as AppsPermission[]), ...granted(first)]);
}
/** Records the approval request an unsatisfied call produces, the way the invocation path persists it. */
async function request(context: RuntimeOperationContext, wanted: readonly AppsPermission[], id: string) {
  const resolveSpace = resolver(context);
  const missing = evaluateOperationAuthority(context.runtime!.granted as unknown as readonly PermissionEntry[], wanted as never, resolveSpace).missing;
  return await createOrReusePermissionRequest({
    profile: context.summary.profile, posture: context.summary.posture, operatorType: "agent", host: context.summary.host,
    sessionDid: "did:key:session", spaceId: SPACE, missing: missing as unknown as PermissionEntry[],
    granted: context.runtime!.granted as unknown as PermissionEntry[], resolveSpace, createRequestId: () => id,
  });
}

describe("a fresh connection on an account with legacy records", () => {
  test("listing apps asks only for the connection's own app list, never the original one", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      expect(await asked("context", context, {})).toEqual([newDiscovery]);

      const afterFirst = withGrants(context, [newDiscovery]);
      expect(await asked("context", afterFirst, {})).toEqual([newDiscovery]);
      const listed = (await definition("context").execute(afterFirst, {})).output;
      expect(listed.legacy).toBe("not_approved");
      expect(listed.apps.map((entry: { app: string }) => entry.app)).toEqual(["fitness"]);
    });
  });

  test("naming an app that is in the new area does not ask for the original list", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      for (const access of ["change", "read"] as const) {
        const afterFirst = await afterFirstApproval(context, "context", { app: "fitness", access });
        const next = await asked("context", afterFirst, { app: "fitness", access });
        expect(next).not.toContainEqual(legacyDiscovery);
        expect(satisfied(afterFirst, next)).toBe(true);
      }
    });
  });

  test("naming an app missing from the new area asks for the original list as a second single-space approval; a legacy namesake then resolves to legacy", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      const afterFirst = await afterFirstApproval(context, "context", { app: "todos" });

      const second = await asked("context", afterFirst, { app: "todos" });
      expect(second).toEqual([legacyDiscovery]);
      expect(spacesOf(second)).toEqual([DEFAULT_SPACE]);

      const afterSecond = withGrants(context, [...(afterFirst.runtime!.granted as AppsPermission[]), legacyDiscovery]);
      const third = await asked("context", afterSecond, { app: "todos" });
      expect(third).toContainEqual(expect.objectContaining({ space: DEFAULT_SPACE, path: OLDER_ROOT }));
      expect(third).not.toContainEqual(expect.objectContaining({ space: SPACE, path: `${ID}todos/` }));

      const listed = (await definition("context").execute(afterSecond, {})).output;
      expect(listed.legacy).toBe("listed");
      expect(listed.apps).toContainEqual({ app: "todos", layout: "legacy", title: "Todos", copy: "none" });
    });
  });

  test("an account with no legacy records is asked for the original list once, then the missing app is a new one", async () => {
    await fixture(async (_kv, context) => {
      const afterFirst = await afterFirstApproval(context, "context", { app: "todos" });
      expect(await asked("context", afterFirst, { app: "todos" })).toEqual([legacyDiscovery]);
      const afterSecond = withGrants(context, [...(afterFirst.runtime!.granted as AppsPermission[]), legacyDiscovery]);
      const next = await asked("context", afterSecond, { app: "todos" });
      expect(spacesOf(next)).toEqual([SPACE]);
      expect(satisfied(afterSecond, next)).toBe(true);
    });
  });

  test("creating an app asks for its own scopes, then the original list, then refuses a same-named legacy app with nothing written", async () => {
    await fixture(async (kv, context, legacy) => {
      seedLegacy(legacy);
      const afterFirst = await afterFirstApproval(context, "write", { ops: createTodos });
      expect(await asked("write", afterFirst, { ops: createTodos })).toEqual([legacyDiscovery]);

      const result = await write(withGrants(context, [...(afterFirst.runtime!.granted as AppsPermission[]), legacyDiscovery]), createTodos);
      expect(result.output.ops.map((op: { outcome: string }) => op.outcome)).toEqual(["INVALID", "INVALID"]);
      expect(kv.writes).toEqual([]);
      expect(legacy.writes).toEqual([]);
    });
  });

  // The SDK's KV read reports a space that was never hosted as KV_NOT_FOUND with a 404 "Space not found" message
  // (sdk-services KVService.classifyNotFound). Such a space cannot hold older apps, so the create goes ahead.
  test("an owner whose default space was never hosted approves the list read, then creates the app in the new layout", async () => {
    await fixture(async (kv, context, legacy) => {
      failLegacyReads(legacy, { code: "KV_NOT_FOUND", message: "KV 404 - Space not found", meta: { status: 404, statusText: "Not Found" } });
      const afterFirst = await afterFirstApproval(context, "write", { ops: createTodosFull });
      expect(await asked("write", afterFirst, { ops: createTodosFull })).toEqual([legacyDiscovery]);

      const result = await write(withGrants(context, [...(afterFirst.runtime!.granted as AppsPermission[]), legacyDiscovery]), createTodosFull);
      expect(result.output.ops.map((op: { outcome: string }) => op.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
      expect(kv.writes.map((entry) => entry.key)).toEqual(expect.arrayContaining(createTodosFull.map((op) => op.key)));
      expect(kv.writes.every((entry) => entry.key.startsWith(ID))).toBe(true);
      expect(legacy.reads).toEqual([[`${OLDER_ROOT}catalog/todos`], [`${OLDER_ROOT}catalog/todos`]]);
      expect(legacy.writes).toEqual([]);
    });
  });

  test("any other node error on the original-list read refuses the create, with nothing written", async () => {
    const errors = [
      { code: "AUTH_UNAUTHORIZED", message: `Failed to get key "${OLDER_ROOT}catalog/todos": 403 - Unauthorized Action`, meta: { status: 403 } },
      { code: "NETWORK_ERROR", message: `Failed to get key "${OLDER_ROOT}catalog/todos": 500 - internal error`, meta: { status: 500 } },
    ];
    for (const error of errors) await fixture(async (kv, context, legacy) => {
      failLegacyReads(legacy, error);
      const afterFirst = await afterFirstApproval(context, "write", { ops: createTodosFull });
      const result = await write(withGrants(context, [...(afterFirst.runtime!.granted as AppsPermission[]), legacyDiscovery]), createTodosFull);
      expect(result.status, error.code).toBe("ok");
      const outcomes = result.output.ops.map((op: { outcome: string }) => op.outcome);
      expect(outcomes, error.code).not.toContain("ok");
      expect([outcomes[0], outcomes[2]], error.code).toEqual([expect.not.stringMatching(/^(ok|INVALID)$/), expect.not.stringMatching(/^(ok|INVALID)$/)]);
      expect(kv.writes, error.code).toEqual([]);
      expect(legacy.writes, error.code).toEqual([]);
    });
  });

  test("a catalog entry alone, with no discovery entry, also counts as creating an app", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      const catalogOnly = [createTodos[0]!];
      const afterFirst = await afterFirstApproval(context, "write", { ops: catalogOnly });
      expect(await asked("write", afterFirst, { ops: catalogOnly })).toEqual([legacyDiscovery]);
    });
  });

  test("updating an existing app, or adding its records, does not ask for the original list", async () => {
    await fixture(async (_kv, context) => {
      for (const ops of [[fitnessUpdate], [{ op: "put", key, value: { data: { kg: 70 } } }]]) {
        const afterFirst = await afterFirstApproval(context, "write", { ops });
        const next = await asked("write", afterFirst, { ops });
        expect(spacesOf(next)).toEqual([SPACE]);
        expect(satisfied(afterFirst, next)).toBe(true);
      }
    });
  });

  test("a catalog slug does not ask for the original list", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      for (const access of ["change", "read"] as const) {
        const afterFirst = await afterFirstApproval(context, "context", { app: "healthlog", access });
        const next = await asked("context", afterFirst, { app: "healthlog", access });
        expect(next).not.toContainEqual(legacyDiscovery);
        expect(satisfied(afterFirst, next)).toBe(true);
      }
    });
  });

  test("a connection that holds only the legacy list is asked for nothing in the new space", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      const legacyOnly = withGrants(context, [legacyDiscovery]);
      expect(await asked("context", legacyOnly, {})).toEqual([legacyDiscovery]);
      const named = await asked("context", legacyOnly, { app: "todos" });
      expect(spacesOf(named)).toEqual([DEFAULT_SPACE]);
      expect(named).toContainEqual(expect.objectContaining({ path: OLDER_ROOT }));
    });
  });

  test("a declined ask blocks only the calls that need it, with the same request each time; other calls still work", async () => {
    await fixture(async (kv, context, legacy) => {
      seedLegacy(legacy);
      const afterFirst = await afterFirstApproval(context, "context", { app: "todos" });
      const lookup = await asked("context", afterFirst, { app: "todos" });
      expect(lookup).toEqual([legacyDiscovery]);
      const first = await request(afterFirst, lookup, "req_legacy_list");
      expect(first).toMatchObject({ status: "created", reused: false, request: { requestId: "req_legacy_list", requested: [legacyDiscovery] } });

      // Declining grants nothing, so nothing changes: the same lookup asks again and gets the same request back.
      const again = await asked("context", afterFirst, { app: "todos" });
      expect(again).toEqual(lookup);
      expect(await request(afterFirst, again, "req_other")).toMatchObject({ status: "created", reused: true, request: { requestId: "req_legacy_list" } });
      expect(satisfied(afterFirst, again)).toBe(false);

      // Listing, an app in the new area and that app's records need no further approval and run.
      expect(satisfied(afterFirst, await asked("context", afterFirst, {}))).toBe(true);
      expect((await definition("context").execute(afterFirst, {})).output.apps).toContainEqual(expect.objectContaining({ app: "fitness", layout: "new" }));
      const withFitness = await afterFirstApproval(afterFirst, "context", { app: "fitness" });
      expect(satisfied(withFitness, await asked("context", withFitness, { app: "fitness" }))).toBe(true);
      const ops = [{ op: "put", key, value: { data: { kg: 70 } } }];
      expect(satisfied(withFitness, await asked("write", withFitness, { ops }))).toBe(true);
      expect((await write(withFitness, ops)).output.ops.map((op: { outcome: string }) => op.outcome)).toEqual(["ok"]);
      expect(kv.writes.map((entry) => entry.key)).toContain(key);
      expect(legacy.writes).toEqual([]);
    });
  });
});
