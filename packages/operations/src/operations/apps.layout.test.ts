import { describe, expect, test } from "bun:test";
import { evaluateOperationAuthority } from "../authority.js";
import type { AppsPermission } from "../tc-apps/kv.js";
import { additionalDelegationsPath, writeJsonAtomic } from "../state.js";
import { tcAppsApprovalReason, tcAppsPermissionKind } from "../tc-apps.js";
import { parseKey, parsePrefix } from "../tc-apps/layout.js";
import { definition, DEFAULT_SPACE, FakeSql, fixture, SPACE, withGrants, withSql, write } from "./apps.fixtures.js";

const ID = "xyz.tinycloud.tinyapps.";
const DISCOVERY = `${ID}catalog/`;
const OLDER_ROOT = "xyz.tinycloud.agent-data/";
const root = `${ID}books/`;
const booksApp = { app: "books", title: "Books", about: "Books I read", created: "2026-11-03" };
const readKind = { app: "books", kind: "read", about: "Books finished", shape: "log", per: "time", v: 1, fields: { title: "text" }, created: "2026-11-03" };
const entry = { v: 1, app: "books", id: `${ID}books`, title: "Books" };
const record = `${root}read/2026-11/2026-11-03T1200-dune`;
const ALL = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"];
const kvScope = (space: string, path: string, actions = ALL) => ({ service: "tinycloud.kv", space, path, actions });
const discoveryGrant = kvScope(SPACE, DISCOVERY, ["tinycloud.kv/get", "tinycloud.kv/list"]);
const entryGrant = kvScope(SPACE, `${DISCOVERY}books/entry`, ["tinycloud.kv/get", "tinycloud.kv/put"]);
const createBooks = [
  { op: "put", key: `${root}catalog`, value: booksApp },
  { op: "put", key: `${root}catalog/read`, value: readKind },
  { op: "put", key: `${DISCOVERY}books/entry`, value: entry },
  { op: "put", key: record, value: { data: { title: "Dune" } } },
];

describe("personal apps key grammar", () => {
  test("accepts exactly the record, catalog, discovery and stale-marker keys of an app folder", () => {
    expect(parseKey(`${root}catalog`)).toEqual({ layout: "new", area: "catalog", app: "books" });
    expect(parseKey(`${root}catalog/read`)).toEqual({ layout: "new", area: "catalog", app: "books", kind: "read" });
    expect(parseKey(record)).toEqual({ layout: "new", area: "record", app: "books", kind: "read", folder: "2026-11", id: "2026-11-03T1200-dune" });
    expect(parseKey(`${DISCOVERY}books/entry`)).toEqual({ layout: "new", area: "discovery", app: "books" });
    expect(parseKey(`${root}index-stale/read`)).toEqual({ layout: "new", area: "stale", app: "books", kind: "read" });
    for (const bad of [
      `${ID}healthlog/catalog`, `${ID}recipes/catalog`, `${ID}index-stale/catalog`, `${ID}Books/catalog`, `${ID}1books/catalog`,
      `${root}catalog/catalog`, `${root}catalog/index-stale`, `${root}index-stale/index-stale`, `${root}read/2026-11`, `${root}read/2026-11/a/b`,
      `${DISCOVERY}books`, `${DISCOVERY}books/other`, `${DISCOVERY}healthlog/entry`, `${root}read/2026-11/a?b`, `${root}../x/catalog`, `${ID}books`,
    ]) expect(parseKey(bad)).toBeUndefined();
  });
  test("a prefix names the discovery folder, one app or part of one app, never every app", () => {
    expect(parsePrefix(DISCOVERY)).toEqual({ layout: "new", discovery: true });
    expect(parsePrefix(`${DISCOVERY}books/`)).toEqual({ layout: "new", discovery: true, app: "books" });
    expect(parsePrefix(root)).toEqual({ layout: "new", app: "books" });
    expect(parsePrefix(`${root}read/2026-11/`)).toEqual({ layout: "new", app: "books" });
    expect(parsePrefix(`${root}catalog/`)).toEqual({ layout: "new", app: "books" });
    for (const bad of [ID, `${ID}books`, `${ID}healthlog/`, `${root}a/b/c/`, `${root}read`]) expect(parsePrefix(bad)).toBeUndefined();
  });
  test("legacy keys retain their original grammar and reject traversal and malformed segments", () => {
    expect(parseKey(`${OLDER_ROOT}catalog/todos`)).toEqual({ layout: "legacy", area: "catalog", app: "todos" });
    expect(parseKey(`${OLDER_ROOT}catalog/todos/todo`)).toEqual({ layout: "legacy", area: "catalog", app: "todos", kind: "todo" });
    expect(parseKey(`${OLDER_ROOT}todos/todo/open/2026-11-03-buy-milk`)).toEqual({ layout: "legacy", area: "record", app: "todos", kind: "todo", folder: "open", id: "2026-11-03-buy-milk" });
    expect(parseKey(`${OLDER_ROOT}index-stale/todos/todo`)).toEqual({ layout: "legacy", area: "stale", app: "todos", kind: "todo" });
    expect(parsePrefix(OLDER_ROOT)).toEqual({ layout: "legacy" });
    expect(parsePrefix(`${OLDER_ROOT}catalog/`)).toEqual({ layout: "legacy" });
    expect(parsePrefix(`${OLDER_ROOT}todos/`)).toEqual({ layout: "legacy", app: "todos" });
    for (const bad of [`${OLDER_ROOT}todos/todo/../x`, `${OLDER_ROOT}todos//open/x`, `${OLDER_ROOT}catalog/`, `${OLDER_ROOT}todos/todo/open/a/b`]) expect(parseKey(bad)).toBeUndefined();
  });
});

describe("personal apps approvals", () => {
  test("a named task bundles only its app and app list, with read-only access when requested", async () => {
    await fixture(async (kv, context) => {
      const change = await definition("context").authority(context, { app: "books" });
      expect(change).toEqual([discoveryGrant, entryGrant, kvScope(SPACE, root)]);
      const read = await definition("context").authority(context, { app: "books", access: "read" });
      expect(read).toEqual([kvScope(SPACE, DISCOVERY, ALL.slice(0, 2)), kvScope(SPACE, root, ALL.slice(0, 2))]);
      kv.seed(`${root}catalog`, booksApp);
      kv.seed(`${root}catalog/read`, readKind);
      kv.seed(`${DISCOVERY}books/entry`, entry);
      kv.seed(record, { v: 1, data: { title: "Dune" } });
      for (const bundle of [change, read]) {
        const granted = withGrants(context, bundle as AppsPermission[]);
        const plan = await definition("read").authority(granted, { keys: [record] });
        expect(evaluateOperationAuthority(bundle as AppsPermission[], plan as AppsPermission[]).missing).toEqual([]);
        expect((await definition("read").execute(granted, { keys: [record] })).output.records[0]).toMatchObject({ key: record, value: { data: { title: "Dune" } } });
      }
      const edit = { ops: [{ op: "put", key: record, etag: kv.values.get(record)!.etag, value: { data: { title: "Dune edited" } } }] };
      const plan = await definition("write").authority(withGrants(context, change as AppsPermission[]), edit);
      expect(evaluateOperationAuthority(change as AppsPermission[], plan as AppsPermission[]).missing).toEqual([]);
      expect((await definition("write").execute(withGrants(context, change as AppsPermission[]), edit)).output.ops[0]?.outcome).toBe("ok");
      expect(await definition("write").authority(withGrants(context, read as AppsPermission[]), edit)).toEqual([kvScope(SPACE, root, ALL.slice(2))]);
      expect(await definition("read").authority(context, { keys: [record] })).toEqual([kvScope(SPACE, root)]);
    });
  });
  test("a first record in a new app needs one approval with app and two without; a later new app needs one", async () => {
    for (const named of [true, false]) await fixture(async (kv, context) => {
      let grants: AppsPermission[] = [];
      const requests: AppsPermission[][] = [];
      const approved = async (name: "context" | "write", input: unknown) => {
        for (let round = 0; round < 4; round++) {
          const active = withGrants(context, grants);
          const plan = await definition(name).authority(active, input);
          const missing = evaluateOperationAuthority(grants, plan as AppsPermission[]).missing;
          if (!missing.length) {
            expect((await definition(name).execute(active, input)).status).toBe("ok");
            return;
          }
          requests.push([...missing] as AppsPermission[]);
          grants = [...grants, ...missing] as AppsPermission[];
        }
        throw new Error("App task kept requesting approval");
      };
      await approved("context", named ? { app: "books" } : {});
      await approved("write", { ops: createBooks });
      expect(kv.values.has(record)).toBe(true);
      expect(requests).toHaveLength(named ? 1 : 2);
      expect(requests.flat().every((scope) => scope.space === SPACE)).toBe(true);
      const before = requests.length;
      await approved("context", { app: "films" });
      await approved("write", { ops: createBooks.map((op) => ({ ...op, key: (op.key as string & { replaceAll(search: string, replacement: string): string }).replaceAll("books", "films"), value: { ...op.value, ...("app" in op.value ? { app: "films" } : {}), ...("id" in op.value ? { id: `${ID}films` } : {}) } })) });
      expect(requests.length - before).toBe(1);
      expect(kv.values.has(record.replace("books", "films"))).toBe(true);
    });
  });
  test("invalid context app ids and access fail validation before reading storage", async () => {
    await fixture(async (kv, context) => {
      for (const app of ["", "Books", "../books", "catalog", "index-stale"]) {
        expect((await definition("context").execute(context, { app })).error.code).toBe("INPUT_INVALID");
      }
      expect((await definition("context").execute(context, { app: "books", access: "write" })).error.code).toBe("INPUT_INVALID");
      expect(kv.lists).toEqual([]);
    });
  });
  test("each call asks only for the scopes of the apps it names, all in the applications space", async () => {
    await fixture(async (_kv, context) => {
      const booksRoot = kvScope(SPACE, root);
      expect(await definition("context").authority(context, {})).toEqual([discoveryGrant]);
      const create = { ops: createBooks } as never;
      expect(await definition("write").authority(context, create)).toEqual([booksRoot, entryGrant]);
      expect(await definition("write").authority(withGrants(context, [booksRoot, entryGrant]), create)).toEqual([booksRoot, entryGrant]);
      expect(await definition("write").authority(context, { ops: [{ op: "put", key: record, etag: `"blake3-${"a".repeat(64)}"`, value: { data: {} } }] } as never)).toEqual([booksRoot]);
      const mixed = { keys: [record], prefixes: [`${DISCOVERY}books/`] } as never;
      expect(await definition("read").authority(context, mixed)).toEqual([discoveryGrant, booksRoot]);
      const sql = (path: string) => ({ service: "tinycloud.sql", space: SPACE, path, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] });
      expect(await definition("query").authority(context, { kinds: [{ app: "books", kind: "read" }], sql: "SELECT 1" } as never)).toEqual([booksRoot, sql(`${root}index`)]);
    });
  });
  test("permission classification rejects anything outside the connector scopes", async () => {
    await fixture(async () => {
      const books = kvScope(SPACE, root);
      expect(tcAppsApprovalReason([{ ...books, path: ID }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${ID}healthlog/` }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${root}read/` }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, space: "other" }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, actions: ["tinycloud.kv/metadata"] }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, service: "tinycloud.sql" }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: OLDER_ROOT }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${OLDER_ROOT}catalog/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] }])).toBeUndefined();
      const discovery = kvScope(SPACE, `${DISCOVERY}qa/entry`, ["tinycloud.kv/put"]);
      expect(tcAppsPermissionKind(discovery)).toEqual({ kind: "app-discovery", app: "qa" });
      for (const path of [`${DISCOVERY}qa/entry-extra`, `${DISCOVERY}qa/entry/`, `${DISCOVERY}qa/other`, `${DISCOVERY}qa/`, DISCOVERY]) {
        expect(tcAppsPermissionKind({ ...discovery, path })).toBeUndefined();
      }
    });
  });
  test("a qa task permits its exact entry and records, never neighboring or unrelated writes", async () => {
    await fixture(async (_kv, context) => {
      const plan = await definition("context").authority(context, { app: "qa" }) as AppsPermission[];
      const allows = (grants: AppsPermission[], path: string, action: string) =>
        evaluateOperationAuthority(grants, [kvScope(SPACE, path, [action])]).satisfied;
      for (const path of [`${DISCOVERY}qa/entry`, `${ID}qa/catalog`, `${ID}qa/task/open/one`]) {
        expect(allows(plan, path, "tinycloud.kv/put")).toBe(true);
      }
      for (const path of [DISCOVERY, `${DISCOVERY}other/entry`, `${DISCOVERY}qa/entry-extra`, `${DISCOVERY}qa/entry/child`, `${DISCOVERY}qa-extra/entry`, `${ID}other/task/open/one`, `${ID}qa-extra/task/open/one`]) {
        expect(allows(plan, path, "tinycloud.kv/put")).toBe(false);
      }
      for (const action of ALL) expect(allows(plan, `${ID}qa/task/open/one`, action)).toBe(true);
      expect(allows(plan, DISCOVERY, "tinycloud.kv/list")).toBe(true);
      expect(allows(plan, `${DISCOVERY}other/entry`, "tinycloud.kv/get")).toBe(true);
      expect(allows(plan, `${DISCOVERY}qa/entry`, "tinycloud.kv/del")).toBe(false);
      for (const input of [{}, { app: "qa", access: "read" }]) {
        const read = await definition("context").authority(context, input) as AppsPermission[];
        expect(allows(read, DISCOVERY, "tinycloud.kv/list")).toBe(true);
        expect(allows(read, `${DISCOVERY}qa/entry`, "tinycloud.kv/put")).toBe(false);
        expect(allows(read, `${ID}qa/task/open/one`, "tinycloud.kv/put")).toBe(false);
      }
      const targets = ["qa", "second"].map((app) => ({ op: "put", key: `${DISCOVERY}${app}/entry`, value: {} }));
      const batch = await definition("write").authority(context, { ops: targets }) as AppsPermission[];
      for (const app of ["qa", "second"]) expect(allows(batch, `${DISCOVERY}${app}/entry`, "tinycloud.kv/put")).toBe(true);
      expect(allows(batch, `${DISCOVERY}third/entry`, "tinycloud.kv/put")).toBe(false);
      const legacy = [kvScope(SPACE, DISCOVERY, ALL.slice(0, 3)), kvScope(SPACE, `${ID}qa/`)];
      expect(evaluateOperationAuthority(legacy, plan).satisfied).toBe(true);
      expect(allows(legacy, `${DISCOVERY}other/entry`, "tinycloud.kv/put")).toBe(true);
      const active = withGrants(context, plan);
      const requested = await definition("write").authority(active, { ops: [targets[0]] }) as AppsPermission[];
      expect(evaluateOperationAuthority(plan, requested).satisfied).toBe(true);
    });
  });
});

describe("personal apps records", () => {
  test("a new app is written catalog, kind, discovery entry, record into the applications space only", async () => {
    await fixture(async (kv, context) => {
      const spaces: string[] = [];
      const node = context.runtime!.node as { kvForSpace: (space: string) => unknown };
      const watched = { ...context, runtime: { ...context.runtime, node: { kvForSpace: (space: string) => { spaces.push(space); return node.kvForSpace(space); } } } } as typeof context;
      const result = await write(watched, createBooks);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
      expect(kv.writes.map((entryWrite) => entryWrite.key)).toEqual([`${root}catalog`, `${root}catalog/read`, `${DISCOVERY}books/entry`, record, `${root}index-stale/read`]);
      expect(kv.writes.slice(0, 4).every((entryWrite) => entryWrite.options.ifNoneMatch === "*")).toBe(true);
      expect(JSON.parse(kv.values.get(`${DISCOVERY}books/entry`)!.text)).toEqual(entry);
      expect(JSON.parse(kv.values.get(record)!.text)).toMatchObject({ v: 1, data: { title: "Dune" }, by: "tinycloud-mcp" });
      expect(JSON.parse(kv.values.get(`${root}catalog`)!.text).by).toBe("tinycloud-mcp");
      expect(new Set(spaces)).toEqual(new Set([SPACE]));
    });
  });
  test("the discovery entry waits for its app and a kind, and must repeat the app's own title", async () => {
    await fixture(async (kv, context) => {
      const discovery = { op: "put", key: `${DISCOVERY}books/entry`, value: entry };
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("INVALID");
      await write(context, [createBooks[0]!]);
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("INVALID");
      await write(context, [createBooks[1]!]);
      expect((await write(context, [{ ...discovery, value: { ...entry, title: "Library" } }])).output.ops[0]?.outcome).toBe("INVALID");
      expect(kv.values.has(`${DISCOVERY}books/entry`)).toBe(false);
      expect((await write(context, [{ ...discovery, value: { ...entry, extra: 1 } }])).error.code).toBe("INPUT_INVALID");
      expect((await write(context, [{ op: "put", key: `${DISCOVERY}books/entry`, value: { ...entry, app: "other" } }])).error.code).toBe("INPUT_INVALID");
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("ok");
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("EXISTS");
    });
  });
  test("a record is not created in an app that has no discovery entry yet, when the app list is readable", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${root}catalog`, booksApp);
      kv.seed(`${root}catalog/read`, readKind);
      const create = [{ op: "put", key: record, value: { data: { title: "Dune" } } }];
      const early = await write(withGrants(context, [discoveryGrant]), create);
      expect(early.output.ops[0]?.outcome).toBe("INVALID");
      expect(kv.values.has(record)).toBe(false);
      // Without read access to the app list the check is skipped; it never asks for another approval.
      expect((await write(context, create)).output.ops[0]?.outcome).toBe("ok");
      kv.values.delete(record);
      kv.seed(`${DISCOVERY}books/entry`, entry);
      expect((await write(withGrants(context, [discoveryGrant]), create)).output.ops[0]?.outcome).toBe("ok");
    });
  });
  test("with a readable app list, a whole new app in one batch is accepted in order and refused when its first record comes before its entry", async () => {
    // The node reports a grant one action at a time; both shapes must count as a readable app list.
    const perAction = discoveryGrant.actions.map((action) => ({ ...discoveryGrant, actions: [action] }));
    for (const granted of [[discoveryGrant], perAction]) {
      await fixture(async (kv, context) => {
        const ordered = await write(withGrants(context, granted), createBooks);
        expect(ordered.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
        expect(kv.values.has(record)).toBe(true);
      });
      await fixture(async (kv, context) => {
        const [catalog, kind, discovery, firstRecord] = createBooks;
        const early = await write(withGrants(context, granted), [catalog!, kind!, firstRecord!, discovery!]);
        expect(early.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok", "INVALID", "ok"]);
        expect(kv.values.has(record)).toBe(false);
        expect(kv.values.has(`${DISCOVERY}books/entry`)).toBe(true);
      });
    }
  });
  test("moves and deletes stay inside one app", async () => {
    await fixture(async (_kv, context) => {
      const from = `${root}read/2026-11/2026-11-03T1200-dune`;
      const result = await write(context, [{ op: "move", from, to: `${ID}films/read/2026-11/x`, etag: `"blake3-${"c".repeat(64)}"`, value: { data: {} } }]);
      expect(result.error.code).toBe("INPUT_INVALID");
      expect((await write(context, [{ op: "delete", key: `${root}catalog` }])).error.code).toBe("INPUT_INVALID");
    });
  });
  test("read returns records in request order and lists the discovery folder", async () => {
    await fixture(async (kv, context) => {
      kv.seed(record, { v: 1, data: { title: "Dune" } });
      kv.seed(`${DISCOVERY}books/entry`, entry);
      const result = await definition("read").execute(context, { prefixes: [DISCOVERY], keys: [record, `${root}catalog`] });
      expect(result.output.lists).toEqual([{ prefix: DISCOVERY, keys: [`${DISCOVERY}fitness/entry`, `${DISCOVERY}books/entry`] }]);
      expect(result.output.records.map((entryRead) => entryRead.key)).toEqual([record, `${root}catalog`]);
      expect(result.output.records[1]).toEqual({ key: `${root}catalog`, outcome: "NOT_FOUND" });
    });
  });
});

describe("personal apps context", () => {
  test("lists apps from their discovery entries with their titles and copy state, and reads nothing else", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${DISCOVERY}books/entry`, entry);
      kv.seed(`${DISCOVERY}films/entry`, { v: 1, app: "films" });
      const permissions = [{ service: "tinycloud.sql", space: SPACE, path: `${root}index`, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] }];
      await writeJsonAtomic(additionalDelegationsPath("apps"), [{ permissions, delegation: { expiry: "2999-01-01T00:00:00Z" } }]);
      const result = await definition("context").execute(withGrants(context, [discoveryGrant]), {});
      expect(result.output.apps).toEqual([
        { app: "books", layout: "new", title: "Books", copy: "present" },
        { app: "films", layout: "new", copy: "none" },
        { app: "fitness", layout: "new", title: "Fitness", copy: "none" },
      ]);
      expect(result.output.legacy).toBe("not_approved");
      expect(result.output.discovery).toBe("listed");
      expect(kv.lists).toEqual([{ prefix: DISCOVERY, limit: 1000 }]);
    });
  });
});

describe("personal apps fast copy", () => {
  test("queries open the app's own database and keep keys relative to the app root", async () => {
    await fixture(async (kv, context) => {
      kv.seed(record, { v: 1, at: "2026-11-03", data: { title: "Dune" } });
      const sql = new FakeSql();
      sql.table = false;
      sql.view = false;
      const active = withSql(context, sql, { space: SPACE, path: `${root}index` });
      const result = await definition("query").execute(active, { kinds: [{ app: "books", kind: "read" }], sql: "SELECT 1 FROM entries" });
      expect(result.output).toMatchObject({ kinds: [{ app: "books", kind: "read", records: 1 }] });
      expect([...new Set(sql.databases)]).toEqual([`${root}index`]);
      expect([...sql.rows.keys()]).toEqual(["read/2026-11/2026-11-03T1200-dune"]);
      expect(kv.values.has(`${root}index-stale/read`)).toBe(false);
    });
  });
  test("a write keeps the copy in step with the new record, or marks its kind stale inside the app root", async () => {
    await fixture(async (kv, context) => {
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: SPACE, path: `${root}index` });
      const result = await write(active, createBooks);
      expect(sql.rows.get("read/2026-11/2026-11-03T1200-dune")).toEqual(result.output.ops[3]?.value);
      expect(kv.values.has(`${root}index-stale/read`)).toBe(false);
      await write(withSql(context, sql, false), [{ op: "put", key: `${root}read/2026-11/2026-11-03T1300-emma`, value: { data: { title: "Emma" } } }]);
      expect(kv.values.has(`${root}index-stale/read`)).toBe(true);
    });
  });
  test("one query covers one app, and a reserved app is refused before any SQL", async () => {
    await fixture(async (_kv, context) => {
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: SPACE, path: `${root}index` });
      const two = [{ app: "books", kind: "read" }, { app: "films", kind: "seen" }];
      expect((await definition("query").execute(active, { kinds: two, sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      expect((await definition("query").execute(active, { kinds: [{ app: "healthlog", kind: "meal" }], sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      expect(sql.calls).toEqual([]);
    });
  });
  test("the copy follows a move and a delete using keys relative to the app root", async () => {
    await fixture(async (kv, context) => {
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: SPACE, path: `${root}index` });
      const open = `${root}goal/open/2026-11-03-read-dune`;
      const done = `${root}goal/done/2026-11-03-read-dune`;
      const goalKind = { app: "books", kind: "goal", about: "Reading goals", shape: "item", states: ["open", "done"], v: 1, fields: { title: "text" }, created: "2026-11-03" };
      const created = await write(active, [createBooks[0]!, { op: "put", key: `${root}catalog/goal`, value: goalKind }, { op: "put", key: open, value: { data: { title: "Dune" } } }]);
      expect(created.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok", "ok"]);
      expect([...sql.rows.keys()]).toEqual(["goal/open/2026-11-03-read-dune"]);
      const moved = await write(active, [{ op: "move", from: open, to: done, etag: created.output.ops[2]!.etag!, value: { data: { title: "Dune", done: "2026-11-04" } } }]);
      expect(moved.output.ops[0]?.steps).toEqual(["written", "deleted"]);
      expect([...sql.rows.keys()]).toEqual(["goal/done/2026-11-03-read-dune"]);
      await write(active, [{ op: "delete", key: done }]);
      expect([...sql.rows.keys()]).toEqual([]);
      expect(kv.values.has(`${root}index-stale/goal`)).toBe(false);
    });
  });
  test("a failed sync of one app's copy leaves committed outcomes and marks the kinds of both apps stale", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${root}catalog`, booksApp);
      kv.seed(`${root}catalog/read`, readKind);
      const sql = new FakeSql();
      sql.failures.push({ code: "AUTH_UNAUTHORIZED" }, { code: "AUTH_UNAUTHORIZED" });
      const both = withSql(context, sql, [{ space: SPACE, path: `${root}index` }, { space: SPACE, path: `${ID}fitness/index` }]);
      const fitnessRecord = `${ID}fitness/weight/2026-10/2026-10-14`;
      const result = await write(both, [{ op: "put", key: record, value: { data: { title: "Dune" } } }, { op: "put", key: fitnessRecord, value: { data: { kg: 70 } } }]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok"]);
      expect(kv.values.has(`${root}index-stale/read`)).toBe(true);
      expect(kv.values.has(`${ID}fitness/index-stale/weight`)).toBe(true);
      expect(kv.values.has(record)).toBe(true);
      expect(kv.values.has(fitnessRecord)).toBe(true);
    });
  });
  test("reading a discovery entry needs only the app list, and query kinds named catalog or index-stale are refused", async () => {
    await fixture(async (_kv, context) => {
      expect(await definition("read").authority(context, { keys: [`${DISCOVERY}books/entry`] } as never)).toEqual([discoveryGrant]);
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: SPACE, path: `${root}index` });
      for (const kind of ["catalog", "index-stale"]) {
        expect((await definition("query").execute(active, { kinds: [{ app: "books", kind }], sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      }
      expect(sql.calls).toEqual([]);
    });
  });
});

describe("personal apps guards", () => {
  test("a folder that already holds another app's manifest cannot become a generic app, and deletes need the app's catalog", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${ID}food/manifest.json`, { app_id: "xyz.tinycloud.tinyapps.food" });
      kv.seed(`${ID}food/records/meals/pizza.json`, { id: "pizza" });
      const created = await write(context, [{ op: "put", key: `${ID}food/catalog`, value: { app: "food", title: "Food", about: "x", created: "2026-11-03" } }]);
      expect(created.output.ops[0]?.outcome).toBe("INVALID");
      const deleted = await write(context, [{ op: "delete", key: `${ID}food/records/meals/pizza.json` }]);
      expect(deleted.output.ops[0]?.outcome).toBe("INVALID");
      expect(kv.writes).toEqual([]);
      expect(kv.deletes).toEqual([]);
    });
  });
  test("another app's files in a folder cannot be replaced or moved either: every record change needs the app's catalog record", async () => {
    await fixture(async (kv, context) => {
      const etagOf = `"blake3-${"d".repeat(64)}"`;
      kv.seed(`${ID}food/manifest.json`, { app_id: "xyz.tinycloud.tinyapps.food" });
      const meal = kv.seed(`${ID}food/records/meals/a.json`, { id: "a", title: "pizza" });
      kv.seed(`${ID}food/records/meals/b.json`, { id: "b" });
      const result = await write(context, [
        { op: "put", key: `${ID}food/records/meals/a.json`, etag: meal, value: { data: {} } },
        { op: "move", from: `${ID}food/records/meals/b.json`, to: `${ID}food/records/meals/c.json`, etag: etagOf, value: { data: {} } },
        { op: "delete", key: `${ID}food/records/meals/a.json` },
      ]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["INVALID", "INVALID", "INVALID"]);
      expect(kv.writes).toEqual([]);
      expect(kv.deletes).toEqual([]);
    });
  });
});

describe("legacy personal records recovery", () => {
  const legacyGrant = kvScope(DEFAULT_SPACE, OLDER_ROOT);
  const legacyCatalogGrant = kvScope(DEFAULT_SPACE, `${OLDER_ROOT}catalog/`, ALL.slice(0, 2));
  const appKey = `${OLDER_ROOT}catalog/books`;
  const kindKey = `${appKey}/read`;
  const legacyRecord = `${OLDER_ROOT}books/read/2026-11/2026-11-03T1200-dune`;

  test("legacy-only grants discover, read and conditionally update records in place without touching applications", async () => {
    await fixture(async (kv, context, legacy) => {
      legacy.seed(appKey, booksApp);
      legacy.seed(kindKey, readKind);
      const etag = legacy.seed(legacyRecord, { v: 1, at: "2026-11-03", data: { title: "Dune" } });
      const active = withGrants(context, [legacyGrant]);
      for (const input of [{}, { app: "books" }, { app: "books", access: "read" }]) {
        const authority = await definition("context").authority(active, input) as AppsPermission[];
        expect(evaluateOperationAuthority([legacyGrant], authority).satisfied).toBe(true);
        expect(authority.every((permission) => permission.space === DEFAULT_SPACE)).toBe(true);
      }
      const listed = (await definition("context").execute(active, {})).output;
      expect(listed.apps).toEqual([{ app: "books", layout: "legacy", title: "Books", copy: "none" }]);
      expect(listed.legacy).toBe("listed");
      expect(listed.discovery).toBe("not_approved");
      expect(listed.catalog.records).toContainEqual({ key: kindKey, etag: legacy.values.get(kindKey)!.etag, value: readKind });
      expect(definition("context").output.safeParse(listed).success).toBe(true);
      const input = { prefixes: [`${OLDER_ROOT}books/read/`], keys: [legacyRecord] };
      expect(evaluateOperationAuthority([legacyGrant], await definition("read").authority(active, input) as AppsPermission[]).satisfied).toBe(true);
      const read = (await definition("read").execute(active, input)).output;
      expect(read.lists).toEqual([{ prefix: `${OLDER_ROOT}books/read/`, keys: [legacyRecord] }]);
      expect(read.records[0]).toMatchObject({ key: legacyRecord, etag, value: { data: { title: "Dune" } } });
      const ops = [
        { op: "put", key: legacyRecord, etag, value: { data: { title: "Dune revised" } } },
        { op: "put", key: legacyRecord, etag, value: { data: { title: "Stale edit" } } },
      ];
      expect(evaluateOperationAuthority([legacyGrant], await definition("write").authority(active, { ops }) as AppsPermission[]).satisfied).toBe(true);
      const changed = await write(active, ops);
      expect(changed.output.ops.map((op) => op.outcome)).toEqual(["ok", "CHANGED"]);
      expect(JSON.parse(legacy.values.get(legacyRecord)!.text)).toMatchObject({ by: "tinycloud-mcp", v: 1, data: { title: "Dune revised" } });
      expect(legacy.values.has(`${OLDER_ROOT}index-stale/books/read`)).toBe(true);
      expect(legacy.deletes).toEqual([]);
      expect(kv.reads).toEqual([]);
      expect(kv.lists).toEqual([]);
      expect(kv.writes).toEqual([]);
    });
  });

  test("catalog-only discovery stays read-only and cannot grant record writes or sibling app mutations", async () => {
    await fixture(async (_kv, context, legacy) => {
      legacy.seed(appKey, booksApp);
      legacy.seed(kindKey, readKind);
      const active = withGrants(context, [legacyCatalogGrant]);
      const authority = await definition("context").authority(active, {}) as AppsPermission[];
      expect(evaluateOperationAuthority([legacyCatalogGrant], authority).satisfied).toBe(true);
      expect((await definition("context").execute(active, {})).output.apps[0]).toMatchObject({ app: "books", layout: "legacy" });
      const read = await definition("read").authority(active, { keys: [kindKey] }) as AppsPermission[];
      expect(evaluateOperationAuthority([legacyCatalogGrant], read).satisfied).toBe(true);
      const writePlan = await definition("write").authority(active, { ops: [{ op: "put", key: legacyRecord, value: { data: {} } }] }) as AppsPermission[];
      expect(evaluateOperationAuthority([legacyCatalogGrant], writePlan).satisfied).toBe(false);
      for (const scope of [kvScope(DEFAULT_SPACE, legacyRecord, ["tinycloud.kv/put"]), entryGrant, kvScope(SPACE, root)]) {
        expect(evaluateOperationAuthority([legacyCatalogGrant], [scope]).satisfied).toBe(false);
      }
    });
  });

  test("a catalog past the hosted result budget still lists every app and leaves kind catalogs as keys", async () => {
    await fixture(async (_kv, context, legacy) => {
      legacy.seed(appKey, booksApp);
      const kindKeys = Array.from({ length: 40 }, (_, index) => `${appKey}/kind-${index}`);
      for (const [index, key] of kindKeys.entries()) legacy.seed(key, { ...readKind, kind: `kind-${index}`, about: "x".repeat(2_500) });
      const listed = (await definition("context").execute(withGrants(context, [legacyGrant]), {})).output;
      expect(listed.apps).toEqual([{ app: "books", layout: "legacy", title: "Books", copy: "none" }]);
      expect([...listed.catalog.keys].sort()).toEqual([appKey, ...kindKeys].sort());
      expect(listed.catalog.records.map((entry) => entry.key)).toEqual([appKey]);
      expect(JSON.stringify(listed).length).toBeLessThan(100_000);
    });
  });

  test("new discovery entries win over namesakes without hiding other authorized legacy apps", async () => {
    await fixture(async (kv, context, legacy) => {
      legacy.seed(appKey, booksApp);
      legacy.seed(`${OLDER_ROOT}catalog/todos`, { ...booksApp, app: "todos", title: "Todos" });
      kv.seed(`${DISCOVERY}books/entry`, entry);
      const active = withGrants(context, [legacyGrant, discoveryGrant]);
      const listed = (await definition("context").execute(active, {})).output;
      expect(listed.apps).toContainEqual({ app: "books", layout: "new", title: "Books", copy: "none" });
      expect(listed.apps).toContainEqual({ app: "todos", layout: "legacy", title: "Todos", copy: "none" });
      const plan = await definition("context").authority(active, { app: "books" }) as AppsPermission[];
      expect(plan).toEqual([discoveryGrant, entryGrant, kvScope(SPACE, root)]);
      expect(evaluateOperationAuthority(plan, [kvScope(SPACE, `${ID}other/`, ["tinycloud.kv/put"])]).satisfied).toBe(false);
    });
  });

  test("an exact readable discovery entry selects the new app over its legacy namesake", async () => {
    await fixture(async (kv, context, legacy) => {
      legacy.seed(appKey, booksApp);
      kv.seed(`${root}catalog`, booksApp);
      kv.seed(`${root}catalog/read`, readKind);
      kv.seed(`${DISCOVERY}books/entry`, entry);
      const active = withGrants(context, [legacyGrant, entryGrant, kvScope(SPACE, root)]);
      const plan = await definition("context").authority(active, { app: "books" }) as AppsPermission[];
      expect(plan).toEqual([discoveryGrant, entryGrant, kvScope(SPACE, root)]);
      const result = await write(active, [{
        op: "put", key: `${root}catalog`, etag: kv.values.get(`${root}catalog`)!.etag,
        value: { ...booksApp, about: "Updated new-layout books" },
      }]);
      expect(result.output.ops[0]?.outcome).toBe("ok");
      expect(JSON.parse(kv.values.get(`${root}catalog`)!.text).about).toBe("Updated new-layout books");
      expect(JSON.parse(legacy.values.get(appKey)!.text)).toEqual(booksApp);
      expect(legacy.writes).toEqual([]);
    });
  });

  test("a known legacy app cannot acquire a replacement new catalog or discovery entry", async () => {
    await fixture(async (kv, context, legacy) => {
      legacy.seed(appKey, booksApp);
      const active = withGrants(context, [legacyGrant, discoveryGrant, entryGrant, kvScope(SPACE, root)]);
      const result = await write(active, [createBooks[0]!, createBooks[2]!]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["INVALID", "INVALID"]);
      expect(kv.writes).toEqual([]);
      expect(legacy.writes).toEqual([]);
      const moved = await write(active, [{ op: "move", from: legacyRecord, to: record, etag: legacy.values.get(appKey)!.etag, value: { data: {} } }]);
      expect(moved.error.code).toBe("INPUT_INVALID");
    });
  });

  test("legacy permissions recognize only original default-space scopes", () => {
    expect(tcAppsPermissionKind(legacyGrant)).toEqual({ kind: "legacy-records" });
    expect(tcAppsPermissionKind({ ...legacyGrant, actions: ALL.slice(0, 2) })).toEqual({ kind: "legacy-read" });
    expect(tcAppsPermissionKind(legacyCatalogGrant)).toEqual({ kind: "legacy-catalog-read" });
    expect(tcAppsPermissionKind({ service: "tinycloud.sql", space: DEFAULT_SPACE, path: "xyz.tinycloud.agent-data.index", actions: ["tinycloud.sql/read"] })).toEqual({ kind: "legacy-copy" });
    for (const permission of [
      { ...legacyGrant, space: SPACE }, { ...legacyGrant, path: `${OLDER_ROOT}books/` },
      { ...legacyCatalogGrant, actions: ["tinycloud.kv/put"] }, { ...legacyGrant, actions: ["tinycloud.kv/metadata"] },
    ]) expect(tcAppsPermissionKind(permission)).toBeUndefined();
    expect(tcAppsPermissionKind({ ...legacyGrant, space: "default" })).toEqual({ kind: "legacy-records" });
  });
});
