import { describe, expect, test } from "bun:test";
import { evaluateOperationAuthority } from "../authority.js";
import type { AppsPermission } from "../tc-apps/kv.js";
import { additionalDelegationsPath, writeJsonAtomic } from "../state.js";
import { tcAppsApprovalMessage, tcAppsApprovalReason } from "../tc-apps.js";
import { parseKey, parsePrefix } from "../tc-apps/layout.js";
import { definition, FakeSql, fixture, SPACE, withGrants, withSql, write } from "./apps.fixtures.js";

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
const discoveryGrant = kvScope(SPACE, DISCOVERY, ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"]);
const createBooks = [
  { op: "put", key: `${root}catalog`, value: booksApp },
  { op: "put", key: `${root}catalog/read`, value: readKind },
  { op: "put", key: `${DISCOVERY}books/entry`, value: entry },
  { op: "put", key: record, value: { data: { title: "Dune" } } },
];

describe("personal apps key grammar", () => {
  test("accepts exactly the record, catalog, discovery and stale-marker keys of an app folder", () => {
    expect(parseKey(`${root}catalog`)).toEqual({ area: "catalog", app: "books" });
    expect(parseKey(`${root}catalog/read`)).toEqual({ area: "catalog", app: "books", kind: "read" });
    expect(parseKey(record)).toEqual({ area: "record", app: "books", kind: "read", folder: "2026-11", id: "2026-11-03T1200-dune" });
    expect(parseKey(`${DISCOVERY}books/entry`)).toEqual({ area: "discovery", app: "books" });
    expect(parseKey(`${root}index-stale/read`)).toEqual({ area: "stale", app: "books", kind: "read" });
    for (const bad of [
      `${ID}healthlog/catalog`, `${ID}recipes/catalog`, `${ID}index-stale/catalog`, `${ID}Books/catalog`, `${ID}1books/catalog`,
      `${root}catalog/catalog`, `${root}catalog/index-stale`, `${root}index-stale/index-stale`, `${root}read/2026-11`, `${root}read/2026-11/a/b`,
      `${DISCOVERY}books`, `${DISCOVERY}books/other`, `${DISCOVERY}healthlog/entry`, `${root}read/2026-11/a?b`, `${root}../x/catalog`, `${ID}books`,
    ]) expect(parseKey(bad)).toBeUndefined();
  });
  test("a prefix names the discovery folder, one app or part of one app, never every app", () => {
    expect(parsePrefix(DISCOVERY)).toEqual({ discovery: true });
    expect(parsePrefix(`${DISCOVERY}books/`)).toEqual({ discovery: true, app: "books" });
    expect(parsePrefix(root)).toEqual({ app: "books" });
    expect(parsePrefix(`${root}read/2026-11/`)).toEqual({ app: "books" });
    expect(parsePrefix(`${root}catalog/`)).toEqual({ app: "books" });
    for (const bad of [ID, `${ID}books`, `${ID}healthlog/`, `${root}a/b/c/`, `${root}read`]) expect(parsePrefix(bad)).toBeUndefined();
  });
  test("the older agent-data folder is not a personal-record place: no key or prefix under it parses", () => {
    for (const older of [`${OLDER_ROOT}catalog/todos`, `${OLDER_ROOT}catalog/todos/todo`, `${OLDER_ROOT}todos/todo/open/2026-11-03-buy-milk`, `${OLDER_ROOT}index-stale/todos/todo`]) {
      expect(parseKey(older)).toBeUndefined();
    }
    for (const older of [OLDER_ROOT, `${OLDER_ROOT}catalog/`, `${OLDER_ROOT}todos/`]) expect(parsePrefix(older)).toBeUndefined();
  });
});

describe("personal apps approvals", () => {
  test("a named task bundles only its app and app list, with read-only access when requested", async () => {
    await fixture(async (kv, context) => {
      const change = await definition("context").authority(context, { app: "books" });
      expect(change).toEqual([discoveryGrant, kvScope(SPACE, root)]);
      const read = await definition("context").authority(context, { app: "books", access: "read" });
      expect(read).toEqual([kvScope(SPACE, DISCOVERY, ALL.slice(0, 2)), kvScope(SPACE, root, ALL.slice(0, 2))]);
      expect(tcAppsApprovalReason(change)).toContain("add books to it");
      expect(tcAppsApprovalReason(change)).toContain("add, change or delete");
      expect(tcAppsApprovalReason(read)).toContain("It cannot change them");
      for (const bundle of [change, read]) {
        expect(tcAppsApprovalReason(bundle)).toContain("30 days");
        expect(tcAppsApprovalReason(bundle)).not.toContain("agent-data");
        expect(tcAppsApprovalMessage(bundle)).toContain("OpenKey");
      }
      // A request that only partly matches a bundle (app-list write with a read-only folder) falls back to the per-grant wording.
      const mixed = [change[0]!, kvScope(SPACE, root, ALL.slice(0, 2))];
      expect(tcAppsApprovalReason(mixed)).not.toContain("add books to it");
      expect(tcAppsApprovalReason(mixed)).toContain("add or change entries in your app list");
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
      for (const app of ["", "Books", "1books", "../books", "catalog", "index-stale"]) {
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
      expect(await definition("write").authority(context, create)).toEqual([booksRoot, discoveryGrant]);
      expect(await definition("write").authority(withGrants(context, [booksRoot, discoveryGrant]), create)).toEqual([booksRoot, discoveryGrant]);
      expect(await definition("write").authority(context, { ops: [{ op: "put", key: record, etag: `"blake3-${"a".repeat(64)}"`, value: { data: {} } }] } as never)).toEqual([booksRoot]);
      const mixed = { keys: [record], prefixes: [`${DISCOVERY}books/`] } as never;
      expect(await definition("read").authority(context, mixed)).toEqual([discoveryGrant, booksRoot]);
      const sql = (path: string) => ({ service: "tinycloud.sql", space: SPACE, path, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] });
      expect(await definition("query").authority(context, { kinds: [{ app: "books", kind: "read" }], sql: "SELECT 1" } as never)).toEqual([booksRoot, sql(`${root}index`)]);
    });
  });
  test("consent text names the exact app and list paths, and rejects anything outside them", async () => {
    await fixture(async (_kv, context) => {
      const permissions = await definition("write").authority(context, { ops: createBooks } as never);
      const reason = tcAppsApprovalReason(permissions)!;
      for (const path of [root, DISCOVERY]) expect(reason).toContain(path);
      expect(reason).not.toContain("agent-data");
      expect(reason).toContain("30 days");
      expect(tcAppsApprovalMessage(permissions)).toContain("OpenKey");
      const books = kvScope(SPACE, root);
      expect(tcAppsApprovalReason([{ ...books, path: ID }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${ID}healthlog/` }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${root}read/` }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, space: "other" }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, actions: ["tinycloud.kv/metadata"] }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, service: "tinycloud.sql" }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: OLDER_ROOT }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${OLDER_ROOT}catalog/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] }])).toBeUndefined();
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
  test("keys under the older agent-data folder are refused by read, write and query before any storage or SQL is touched", async () => {
    await fixture(async (kv, context) => {
      const older = `${OLDER_ROOT}todos/todo/open/2026-11-03-buy-milk`;
      expect((await definition("read").execute(context, { keys: [older] })).error.code).toBe("INPUT_INVALID");
      expect((await definition("read").execute(context, { prefixes: [OLDER_ROOT] })).error.code).toBe("INPUT_INVALID");
      expect((await write(context, [{ op: "put", key: `${OLDER_ROOT}catalog/todos`, value: { app: "todos" } }])).error.code).toBe("INPUT_INVALID");
      expect((await write(context, [{ op: "put", key: older, value: { data: {} } }])).error.code).toBe("INPUT_INVALID");
      const sql = new FakeSql();
      expect((await definition("query").execute(withSql(context, sql), { layout: "legacy", kinds: [{ app: "todos", kind: "todo" }], sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      expect(kv.reads).toEqual([]);
      expect(kv.writes).toEqual([]);
      expect(sql.calls).toEqual([]);
    });
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
        { app: "books", title: "Books", copy: "present" },
        { app: "films", copy: "none" },
        { app: "fitness", title: "Fitness", copy: "none" },
      ]);
      expect(Object.keys(result.output).sort()).toEqual(["apps", "now", "rules", "timezone", "utc"]);
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
      const view = sql.calls.find((call) => call.sql.startsWith("CREATE VIEW"))!;
      expect(view.sql).not.toContain(" app,");
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
      expect(result.output.ops[0]?.warnings?.join(" ")).toContain("fast-copy upkeep failed");
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
      expect(created.output.ops[0]?.warnings?.[0]).toContain("manifest.json");
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
