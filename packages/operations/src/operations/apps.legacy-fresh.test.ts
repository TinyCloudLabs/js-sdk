import { describe, expect, test } from "bun:test";
import type { AppsPermission } from "../tc-apps/kv.js";
import { definition, DEFAULT_SPACE, fixture, SPACE, withGrants, write } from "./apps.fixtures.js";

// A fresh connection on an account that already has records under the original
// xyz.tinycloud.agent-data/ layout (default space). It holds no grant yet, so the
// first call has to ask for what it needs to see those records.
const ID = "xyz.tinycloud.tinyapps.";
const DISCOVERY = `${ID}catalog/`;
const OLDER_ROOT = "xyz.tinycloud.agent-data/";
const READ = ["tinycloud.kv/get", "tinycloud.kv/list"];
const kvScope = (space: string, path: string, actions: string[]) => ({ service: "tinycloud.kv", space, path, actions });
const newDiscovery = kvScope(SPACE, DISCOVERY, READ);
const legacyDiscovery = kvScope(DEFAULT_SPACE, `${OLDER_ROOT}catalog/`, READ);
const todos = { app: "todos", title: "Todos", about: "Tasks", created: "2026-11-03" };
const todoKind = { app: "todos", kind: "todo", about: "Tasks", shape: "item", states: ["open", "done"], v: 1, fields: { title: "text" }, created: "2026-11-03" };
const legacyTodo = `${OLDER_ROOT}todos/todo/open/2026-11-03-existing`;
const createTodos = [
  { op: "put", key: `${ID}todos/catalog`, value: todos },
  { op: "put", key: `${ID}todos/catalog/todo`, value: todoKind },
  { op: "put", key: `${DISCOVERY}todos/entry`, value: { v: 1, app: "todos", id: `${ID}todos`, title: "Todos" } },
  { op: "put", key: `${ID}todos/todo/open/2026-11-18-new`, value: { data: { title: "New" } } },
];

function seedLegacy(legacy: { seed(key: string, value: unknown): string }) {
  legacy.seed(`${OLDER_ROOT}catalog/todos`, todos);
  legacy.seed(`${OLDER_ROOT}catalog/todos/todo`, todoKind);
  legacy.seed(legacyTodo, { v: 1, at: "2026-11-03", data: { title: "Existing" } });
}
const spacesOf = (permissions: AppsPermission[]) => [...new Set(permissions.map((permission) => permission.space))];
const granted = (permissions: AppsPermission[]) => permissions.map((permission) => ({ ...permission }));

// OpenKey signs one space per approval, and the original layout lives in the default space while new apps live
// in the applications space, so the legacy app list is asked for as a second approval, never bundled with the first.
describe("a fresh connection on an account with legacy records", () => {
  test("the app list is asked for in two single-space steps, then the legacy apps are listed", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      const first = await definition("context").authority(context, {}) as AppsPermission[];
      expect(first).toEqual([newDiscovery]);

      const afterFirst = withGrants(context, granted(first));
      const second = await definition("context").authority(afterFirst, {}) as AppsPermission[];
      expect(second).toEqual([legacyDiscovery]);
      expect(spacesOf(second)).toEqual([DEFAULT_SPACE]);

      const afterBoth = withGrants(context, [newDiscovery, legacyDiscovery]);
      expect(await definition("context").authority(afterBoth, {})).toEqual([newDiscovery, legacyDiscovery]);
      const listed = (await definition("context").execute(afterBoth, {})).output;
      expect(listed.legacy).toBe("listed");
      expect(listed.apps).toContainEqual({ app: "todos", layout: "legacy", title: "Todos", copy: "none" });
      expect(listed.apps.map((entry: { app: string }) => entry.app)).toEqual(["fitness", "todos"]);
    });
  });

  test("naming an app asks for that app's scopes in one space, then the legacy list; a legacy namesake is then found", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      const first = await definition("context").authority(context, { app: "todos" }) as AppsPermission[];
      expect(spacesOf(first)).toEqual([SPACE]);

      const second = await definition("context").authority(withGrants(context, granted(first)), { app: "todos" }) as AppsPermission[];
      expect(second).toEqual([legacyDiscovery]);

      const third = await definition("context").authority(withGrants(context, [...granted(first), legacyDiscovery]), { app: "todos" }) as AppsPermission[];
      expect(third).toContainEqual(expect.objectContaining({ space: DEFAULT_SPACE, path: OLDER_ROOT }));
    });
  });

  test("creating a new app asks for its own scopes first, then the legacy list, then refuses a same-named legacy app", async () => {
    await fixture(async (kv, context, legacy) => {
      seedLegacy(legacy);
      const create = [createTodos[0]!, createTodos[2]!];
      const first = await definition("write").authority(context, { ops: create }) as AppsPermission[];
      expect(spacesOf(first)).toEqual([SPACE]);

      const afterFirst = withGrants(context, granted(first));
      const second = await definition("write").authority(afterFirst, { ops: create }) as AppsPermission[];
      expect(second).toEqual([legacyDiscovery]);

      const result = await write(withGrants(context, [...granted(first), legacyDiscovery]), create);
      expect(result.output.ops.map((op: { outcome: string }) => op.outcome)).toEqual(["INVALID", "INVALID"]);
      expect(kv.writes).toEqual([]);
      expect(legacy.writes).toEqual([]);
    });
  });

  test("changing an app that already has a discovery entry does not ask for the legacy list", async () => {
    await fixture(async (_kv, context) => {
      const asked = await definition("write").authority(context, { ops: [
        { op: "put", key: `${ID}fitness/catalog`, etag: `"blake3-${"a".repeat(64)}"`, value: { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14" } },
      ] }) as AppsPermission[];
      expect(spacesOf(asked)).toEqual([SPACE]);
      const after = await definition("write").authority(withGrants(context, granted(asked)), { ops: [
        { op: "put", key: `${ID}fitness/catalog`, etag: `"blake3-${"a".repeat(64)}"`, value: { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14" } },
      ] }) as AppsPermission[];
      expect(spacesOf(after)).toEqual([SPACE]);
    });
  });

  test("a connection that holds only the legacy list is not asked for new-space approval", async () => {
    await fixture(async (_kv, context, legacy) => {
      seedLegacy(legacy);
      const legacyOnly = withGrants(context, [legacyDiscovery]);
      expect(await definition("context").authority(legacyOnly, {})).toEqual([legacyDiscovery]);
    });
  });
});
