import { describe, expect, test } from "bun:test";
import { additionalDelegationsPath, writeJsonAtomic } from "../state.js";
import { tcAppsApprovalMessage, tcAppsApprovalReason } from "../tc-apps.js";
import { parseKey, parsePrefix } from "../tc-apps/layout.js";
import { app as fitnessApp, definition, FakeSql, fixture, key as legacyKey, LEGACY_ROOT_GRANT, NEW_SPACE, SPACE, withGrants, withSql, write } from "./apps.fixtures.js";

const ID = "xyz.tinycloud.tinyapps.";
const DISCOVERY = `${ID}catalog/`;
const LEGACY = "xyz.tinycloud.agent-data/";
const root = `${ID}books/`;
const booksApp = { app: "books", title: "Books", about: "Books I read", created: "2026-11-03" };
const readKind = { app: "books", kind: "read", about: "Books finished", shape: "log", per: "time", v: 1, fields: { title: "text" }, created: "2026-11-03" };
const entry = { v: 1, app: "books", id: `${ID}books`, title: "Books" };
const record = `${root}read/2026-11/2026-11-03T1200-dune`;
const ALL = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"];
const kvScope = (space: string, path: string, actions = ALL) => ({ service: "tinycloud.kv", space, path, actions });
const discoveryGrant = kvScope(NEW_SPACE, DISCOVERY, ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"]);
const createBooks = [
  { op: "put", key: `${root}catalog`, value: booksApp },
  { op: "put", key: `${root}catalog/read`, value: readKind },
  { op: "put", key: `${DISCOVERY}books/entry`, value: entry },
  { op: "put", key: record, value: { data: { title: "Dune" } } },
];

describe("personal apps key grammar", () => {
  test("accepts exactly the record, catalog, discovery and stale-marker keys of the new layout", () => {
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
    expect(parsePrefix(LEGACY)).toEqual({ layout: "legacy" });
    for (const bad of [ID, `${ID}books`, `${ID}healthlog/`, `${root}a/b/c/`, `${root}read`]) expect(parsePrefix(bad)).toBeUndefined();
  });
});

describe("personal apps new layout: approvals", () => {
  test("each call asks for one space at a time, only the scopes of the apps it names; a new app also reads the older catalog", async () => {
    await fixture(async (_kv, context) => {
      const booksRoot = kvScope(NEW_SPACE, root);
      const legacyRoot = kvScope(SPACE, LEGACY);
      const legacyCatalog = kvScope(SPACE, `${LEGACY}catalog/`, ["tinycloud.kv/get", "tinycloud.kv/list"]);
      expect(await definition("context").authority(context, {})).toEqual([discoveryGrant]);
      const create = { ops: createBooks } as never;
      expect(await definition("write").authority(context, create)).toEqual([booksRoot, discoveryGrant]);
      expect(await definition("write").authority(withGrants(context, [booksRoot, discoveryGrant]), create)).toEqual([legacyCatalog]);
      expect(await definition("write").authority(withGrants(context, [booksRoot, discoveryGrant, legacyRoot]), create)).toEqual([booksRoot, discoveryGrant, legacyCatalog]);
      expect(await definition("write").authority(context, { ops: [{ op: "put", key: record, etag: `"blake3-${"a".repeat(64)}"`, value: { data: {} } }] } as never)).toEqual([booksRoot]);
      const mixed = { keys: [legacyKey, record], prefixes: [`${DISCOVERY}books/`] } as never;
      expect(await definition("read").authority(context, mixed)).toEqual([discoveryGrant, booksRoot]);
      expect(await definition("read").authority(withGrants(context, [discoveryGrant, booksRoot]), mixed)).toEqual([legacyRoot]);
      const sql = (space: string, path: string) => ({ service: "tinycloud.sql", space, path, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] });
      expect(await definition("query").authority(context, { layout: "new", kinds: [{ app: "books", kind: "read" }], sql: "SELECT 1" } as never)).toEqual([booksRoot, sql(NEW_SPACE, `${root}index`)]);
      expect(await definition("query").authority(context, { layout: "legacy", kinds: [{ app: "fitness", kind: "weight" }], sql: "SELECT 1" } as never)).toEqual([legacyRoot, sql(SPACE, "xyz.tinycloud.agent-data.index")]);
    });
  });
  test("consent text names the exact app, list and older-catalog paths, and rejects anything outside them", async () => {
    await fixture(async (_kv, context) => {
      const permissions = await definition("write").authority(context, { ops: createBooks } as never);
      const reason = tcAppsApprovalReason(permissions)!;
      for (const path of [root, DISCOVERY]) expect(reason).toContain(path);
      const older = await definition("write").authority(withGrants(context, permissions as never[]), { ops: createBooks } as never);
      expect(tcAppsApprovalReason(older)).toContain(`${LEGACY}catalog/`);
      expect(reason).toContain("30 days");
      expect(tcAppsApprovalMessage(permissions)).toContain("OpenKey");
      const books = kvScope(NEW_SPACE, root);
      expect(tcAppsApprovalReason([{ ...books, path: ID }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${ID}healthlog/` }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, path: `${root}read/` }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, space: SPACE }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, actions: ["tinycloud.kv/metadata"] }])).toBeUndefined();
      expect(tcAppsApprovalReason([{ ...books, service: "tinycloud.sql" }])).toBeUndefined();
    });
  });
});

describe("personal apps new layout: records", () => {
  test("a new app is written catalog, kind, discovery entry, record into the applications space only", async () => {
    await fixture(async (kv, context, applications) => {
      const result = await write(context, createBooks);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
      expect(applications.writes.map((entryWrite) => entryWrite.key)).toEqual([`${root}catalog`, `${root}catalog/read`, `${DISCOVERY}books/entry`, record, `${root}index-stale/read`]);
      expect(applications.writes.slice(0, 4).every((entryWrite) => entryWrite.options.ifNoneMatch === "*")).toBe(true);
      expect(JSON.parse(applications.values.get(`${DISCOVERY}books/entry`)!.text)).toEqual(entry);
      expect(JSON.parse(applications.values.get(record)!.text)).toMatchObject({ v: 1, data: { title: "Dune" }, by: "tinycloud-mcp" });
      expect(JSON.parse(applications.values.get(`${root}catalog`)!.text).by).toBe("tinycloud-mcp");
      expect(kv.writes).toEqual([]);
    });
  });
  test("the discovery entry waits for its app and a kind, and must repeat the app's own title", async () => {
    await fixture(async (_kv, context, applications) => {
      const discovery = { op: "put", key: `${DISCOVERY}books/entry`, value: entry };
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("INVALID");
      await write(context, [createBooks[0]!]);
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("INVALID");
      await write(context, [createBooks[1]!]);
      expect((await write(context, [{ ...discovery, value: { ...entry, title: "Library" } }])).output.ops[0]?.outcome).toBe("INVALID");
      expect(applications.values.has(`${DISCOVERY}books/entry`)).toBe(false);
      expect((await write(context, [{ ...discovery, value: { ...entry, extra: 1 } }])).error.code).toBe("INPUT_INVALID");
      expect((await write(context, [{ op: "put", key: `${DISCOVERY}books/entry`, value: { ...entry, app: "other" } }])).error.code).toBe("INPUT_INVALID");
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("ok");
      expect((await write(context, [discovery])).output.ops[0]?.outcome).toBe("EXISTS");
    });
  });
  test("an app that already exists in the older layout is not created again in the new one", async () => {
    await fixture(async (_kv, context, applications) => {
      const result = await write(context, [{ op: "put", key: `${ID}fitness/catalog`, value: fitnessApp }]);
      expect(result.output.ops[0]).toMatchObject({ outcome: "INVALID" });
      expect(result.output.ops[0]?.warnings?.[0]).toContain("older layout");
      expect(applications.writes).toEqual([]);
    });
  });
  test("a record write through the older root is refused once the app has moved, when the entry is readable", async () => {
    await fixture(async (kv, context, applications) => {
      const attempt = [{ op: "put", key: legacyKey, value: { data: { kg: 70 } } }];
      expect((await write(withGrants(context, []), attempt)).output.ops[0]?.outcome).toBe("ok");
      applications.seed(`${DISCOVERY}fitness/entry`, { v: 1, app: "fitness", id: `${ID}fitness`, title: "Fitness" });
      const writesBefore = kv.writes.length;
      // The node reports a grant one action at a time; a grant on the whole applications space also covers the app list.
      const perAction = discoveryGrant.actions.map((action) => ({ ...discoveryGrant, actions: [action] }));
      const wholeSpace = { service: "tinycloud.kv", space: NEW_SPACE, path: "", actions: ["tinycloud.kv/get"] };
      for (const granted of [[discoveryGrant], perAction, [wholeSpace]]) {
        const moved = await write(withGrants(context, granted), [{ op: "put", key: legacyKey, etag: `"blake3-${"b".repeat(64)}"`, value: { data: { kg: 71 } } }]);
        expect(moved.output.ops[0]?.outcome).toBe("INVALID");
        expect(moved.output.ops[0]?.warnings?.[0]).toContain(`${ID}fitness/`);
        expect(kv.writes.length).toBe(writesBefore);
      }
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
  test("read returns records of both layouts in request order and lists the discovery folder", async () => {
    await fixture(async (kv, context, applications) => {
      kv.seed(legacyKey, { v: 1, data: { kg: 70 } });
      applications.seed(record, { v: 1, data: { title: "Dune" } });
      applications.seed(`${DISCOVERY}books/entry`, entry);
      const result = await definition("read").execute(context, { prefixes: [DISCOVERY], keys: [record, legacyKey, `${root}catalog`] });
      expect(result.output.lists).toEqual([{ prefix: DISCOVERY, keys: [`${DISCOVERY}books/entry`] }]);
      expect(result.output.records.map((entryRead) => entryRead.key)).toEqual([record, legacyKey, `${root}catalog`]);
      expect(result.output.records[2]).toEqual({ key: `${root}catalog`, outcome: "NOT_FOUND" });
    });
  });
});

describe("personal apps context across layouts", () => {
  test("lists older apps when readable, new apps from their discovery entries, and a moved app only once as new", async () => {
    await fixture(async (kv, context, applications) => {
      kv.seed(`${LEGACY}catalog/todos`, { app: "todos", title: "Todos", about: "x", created: "2026-10-01" });
      applications.seed(`${DISCOVERY}books/entry`, entry);
      applications.seed(`${DISCOVERY}fitness/entry`, { v: 1, app: "fitness", id: `${ID}fitness`, title: "Fitness moved" });
      applications.seed(`${DISCOVERY}films/entry`, { v: 1, app: "films" });
      const permissions = [{ service: "tinycloud.sql", space: NEW_SPACE, path: `${root}index`, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] }];
      await writeJsonAtomic(additionalDelegationsPath("apps"), [{ permissions, delegation: { expiry: "2999-01-01T00:00:00Z" } }]);
      const result = await definition("context").execute(withGrants(context, [discoveryGrant, LEGACY_ROOT_GRANT]), {});
      expect(result.output.legacy).toBe("listed");
      expect(result.output.apps).toEqual([
        { app: "books", layout: "new", title: "Books", copy: "present" },
        { app: "films", layout: "new", copy: "none" },
        { app: "fitness", layout: "new", title: "Fitness moved", copy: "none" },
        { app: "todos", layout: "legacy", title: "Todos", copy: "none" },
      ]);
      const unapproved = await definition("context").execute(withGrants(context, [discoveryGrant]), {});
      expect(unapproved.output.legacy).toBe("not_approved");
      expect(unapproved.output.catalog).toEqual({ keys: [] });
      expect(unapproved.output.apps.map((listed) => listed.app)).toEqual(["books", "films", "fitness"]);
      expect(kv.lists).toEqual([{ prefix: `${LEGACY}catalog/`, limit: 1000 }]);
    });
  });
});

describe("personal apps new layout: fast copy", () => {
  test("queries open the app's own database and keep keys relative to the app root", async () => {
    await fixture(async (_kv, context, applications) => {
      applications.seed(record, { v: 1, at: "2026-11-03", data: { title: "Dune" } });
      const sql = new FakeSql();
      sql.table = false;
      sql.view = false;
      const active = withSql(context, sql, { space: NEW_SPACE, path: `${root}index` });
      const result = await definition("query").execute(active, { layout: "new", kinds: [{ app: "books", kind: "read" }], sql: "SELECT 1 FROM entries" });
      expect(result.output).toMatchObject({ kinds: [{ app: "books", kind: "read", records: 1 }] });
      expect([...new Set(sql.databases)]).toEqual([`${root}index`]);
      expect([...sql.rows.keys()]).toEqual(["read/2026-11/2026-11-03T1200-dune"]);
      const view = sql.calls.find((call) => call.sql.startsWith("CREATE VIEW"))!;
      expect(view.sql).not.toContain(" app,");
      expect(applications.values.has(`${root}index-stale/read`)).toBe(false);
    });
  });
  test("a write keeps the copy in step with the new record, or marks its kind stale inside the app root", async () => {
    await fixture(async (_kv, context, applications) => {
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: NEW_SPACE, path: `${root}index` });
      const result = await write(active, createBooks);
      expect(sql.rows.get("read/2026-11/2026-11-03T1200-dune")).toEqual(result.output.ops[3]?.value);
      expect(applications.values.has(`${root}index-stale/read`)).toBe(false);
      await write(withSql(context, sql, false), [{ op: "put", key: `${root}read/2026-11/2026-11-03T1300-emma`, value: { data: { title: "Emma" } } }]);
      expect(applications.values.has(`${root}index-stale/read`)).toBe(true);
    });
  });
  test("one query covers one app, and a reserved or moved app is refused before any SQL", async () => {
    await fixture(async (_kv, context, applications) => {
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: NEW_SPACE, path: `${root}index` });
      const two = [{ app: "books", kind: "read" }, { app: "films", kind: "seen" }];
      expect((await definition("query").execute(active, { layout: "new", kinds: two, sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      expect((await definition("query").execute(active, { layout: "new", kinds: [{ app: "healthlog", kind: "meal" }], sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      applications.seed(`${DISCOVERY}fitness/entry`, { v: 1, app: "fitness", id: `${ID}fitness`, title: "Fitness" });
      const legacyQuery = withGrants(withSql(context, sql, true), [discoveryGrant, ...withSql(context, sql, true).runtime!.granted]);
      expect((await definition("query").execute(legacyQuery, { layout: "legacy", kinds: [{ app: "fitness", kind: "weight" }], sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      expect(sql.calls).toEqual([]);
    });
  });
});

describe("personal apps new layout: copy upkeep and scopes", () => {
  test("the copy follows a move and a delete using keys relative to the app root", async () => {
    await fixture(async (_kv, context, applications) => {
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: NEW_SPACE, path: `${root}index` });
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
      expect(applications.values.has(`${root}index-stale/goal`)).toBe(false);
    });
  });
  test("a failed sync of one app's copy leaves committed outcomes and marks the kinds of both layouts stale", async () => {
    await fixture(async (kv, context, applications) => {
      applications.seed(`${root}catalog`, booksApp);
      applications.seed(`${root}catalog/read`, readKind);
      const sql = new FakeSql();
      sql.failures.push({ code: "AUTH_UNAUTHORIZED" }, { code: "AUTH_UNAUTHORIZED" });
      const both = withSql(context, sql, [{ space: NEW_SPACE, path: `${root}index` }, { space: SPACE, path: "xyz.tinycloud.agent-data.index" }]);
      const result = await write(both, [{ op: "put", key: record, value: { data: { title: "Dune" } } }, { op: "put", key: legacyKey, value: { data: { kg: 70 } } }]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok"]);
      expect(result.output.ops[0]?.warnings?.join(" ")).toContain("fast-copy upkeep failed");
      expect(applications.values.has(`${root}index-stale/read`)).toBe(true);
      expect(kv.values.has(`${LEGACY}index-stale/fitness/weight`)).toBe(true);
      expect(applications.values.has(record)).toBe(true);
      expect(kv.values.has(legacyKey)).toBe(true);
    });
  });
  test("reading a discovery entry needs only the app list, and query kinds named catalog or index-stale are refused", async () => {
    await fixture(async (_kv, context) => {
      expect(await definition("read").authority(context, { keys: [`${DISCOVERY}books/entry`] } as never)).toEqual([discoveryGrant]);
      const sql = new FakeSql();
      const active = withSql(context, sql, { space: NEW_SPACE, path: `${root}index` });
      for (const kind of ["catalog", "index-stale"]) {
        expect((await definition("query").execute(active, { layout: "new", kinds: [{ app: "books", kind }], sql: "SELECT 1" })).error.code).toBe("INPUT_INVALID");
      }
      expect(sql.calls).toEqual([]);
    });
  });
});

describe("personal apps: guards found in the security review", () => {
  const fitnessCatalog = { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14" };
  const fitnessEntry = { v: 1, app: "fitness", id: `${ID}fitness`, title: "Fitness" };

  test("an app the older layout still holds cannot get its discovery entry from a write: only a completed move may add it", async () => {
    await fixture(async (_kv, context, applications) => {
      applications.seed(`${ID}fitness/catalog`, fitnessCatalog);
      applications.seed(`${ID}fitness/catalog/weight`, { app: "fitness", kind: "weight", about: "w", shape: "log", per: "day", v: 1, fields: { kg: "number" }, created: "2026-10-14" });
      const attempt = [{ op: "put", key: `${DISCOVERY}fitness/entry`, value: fitnessEntry }];
      const refused = await write(context, attempt);
      expect(refused.output.ops[0]?.outcome).toBe("INVALID");
      expect(refused.output.ops[0]?.warnings?.[0]).toContain("tinycloud_apps_move");
      expect(applications.values.has(`${DISCOVERY}fitness/entry`)).toBe(false);
      // The write asks for the older catalog first, so the check can run.
      const root = kvScope(NEW_SPACE, `${ID}fitness/`);
      expect(await definition("write").authority(withGrants(context, [root, discoveryGrant]), { ops: attempt } as never)).toEqual([kvScope(SPACE, `${LEGACY}catalog/`, ["tinycloud.kv/get", "tinycloud.kv/list"])]);
    });
  });
  test("older-layout access to an app also needs the app list, and a moved app's older records are not served", async () => {
    await fixture(async (kv, context, applications) => {
      const legacyRoot = kvScope(SPACE, LEGACY);
      const input = { keys: [legacyKey] } as never;
      expect(await definition("read").authority(context, input)).toEqual([legacyRoot]);
      expect(await definition("read").authority(withGrants(context, [LEGACY_ROOT_GRANT]), input)).toEqual([discoveryGrant]);
      expect(await definition("read").authority(context, { prefixes: [`${LEGACY}catalog/`] } as never)).toEqual([legacyRoot]);
      expect(await definition("write").authority(withGrants(context, [LEGACY_ROOT_GRANT]), { ops: [{ op: "put", key: legacyKey, value: { data: {} } }] } as never)).toEqual([discoveryGrant]);
      kv.seed(legacyKey, { v: 1, data: { kg: 70 } });
      expect((await definition("read").execute(withGrants(context, [LEGACY_ROOT_GRANT, discoveryGrant]), input)).output.records).toHaveLength(1);
      applications.seed(`${DISCOVERY}fitness/entry`, fitnessEntry);
      const moved = await definition("read").execute(withGrants(context, [LEGACY_ROOT_GRANT, discoveryGrant]), input);
      expect(moved.error.code).toBe("INPUT_INVALID");
      expect(moved.error.message).toContain(`${ID}fitness/`);
    });
  });
  test("a folder that already holds another app's manifest cannot become a generic app, and deletes need the app's catalog", async () => {
    await fixture(async (_kv, context, applications) => {
      applications.seed(`${ID}food/manifest.json`, { app_id: "xyz.tinycloud.tinyapps.food" });
      applications.seed(`${ID}food/records/meals/pizza.json`, { id: "pizza" });
      const created = await write(context, [{ op: "put", key: `${ID}food/catalog`, value: { app: "food", title: "Food", about: "x", created: "2026-11-03" } }]);
      expect(created.output.ops[0]?.outcome).toBe("INVALID");
      expect(created.output.ops[0]?.warnings?.[0]).toContain("manifest.json");
      const deleted = await write(context, [{ op: "delete", key: `${ID}food/records/meals/pizza.json` }]);
      expect(deleted.output.ops[0]?.outcome).toBe("INVALID");
      expect(applications.writes).toEqual([]);
      expect(applications.deletes).toEqual([]);
    });
  });
});

describe("personal apps: second-round guards", () => {
  const etagOf = `"blake3-${"d".repeat(64)}"`;
  test("another app's files in a folder cannot be replaced or moved either: every record change needs the app's catalog record", async () => {
    await fixture(async (_kv, context, applications) => {
      applications.seed(`${ID}food/manifest.json`, { app_id: "xyz.tinycloud.tinyapps.food" });
      const meal = applications.seed(`${ID}food/records/meals/a.json`, { id: "a", title: "pizza" });
      applications.seed(`${ID}food/records/meals/b.json`, { id: "b" });
      const result = await write(context, [
        { op: "put", key: `${ID}food/records/meals/a.json`, etag: meal, value: { data: {} } },
        { op: "move", from: `${ID}food/records/meals/b.json`, to: `${ID}food/records/meals/c.json`, etag: etagOf, value: { data: {} } },
        { op: "delete", key: `${ID}food/records/meals/a.json` },
      ]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["INVALID", "INVALID", "INVALID"]);
      expect(applications.writes).toEqual([]);
      expect(applications.deletes).toEqual([]);
    });
  });
  test("a record is not created in an app that has no discovery entry yet, when the app list is readable", async () => {
    await fixture(async (_kv, context, applications) => {
      applications.seed(`${root}catalog`, booksApp);
      applications.seed(`${root}catalog/read`, readKind);
      const create = [{ op: "put", key: record, value: { data: { title: "Dune" } } }];
      const early = await write(withGrants(context, [discoveryGrant]), create);
      expect(early.output.ops[0]?.outcome).toBe("INVALID");
      expect(early.output.ops[0]?.warnings?.[0]).toContain("discovery entry");
      expect(applications.values.has(record)).toBe(false);
      applications.seed(`${DISCOVERY}books/entry`, entry);
      expect((await write(withGrants(context, [discoveryGrant]), create)).output.ops[0]?.outcome).toBe("ok");
    });
  });
  test("a query of an older-layout app also needs the app list, so a moved app is not answered from its old copy", async () => {
    await fixture(async (_kv, context) => {
      const input = { layout: "legacy", kinds: [{ app: "fitness", kind: "weight" }], sql: "SELECT 1" } as never;
      const first = await definition("query").authority(context, input);
      expect(first.map((scope) => scope.path)).toEqual([LEGACY, "xyz.tinycloud.agent-data.index"]);
      const withSqlGrant = withGrants(context, [LEGACY_ROOT_GRANT, { service: "tinycloud.sql", space: SPACE, path: "xyz.tinycloud.agent-data.index", actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] }]);
      expect(await definition("query").authority(withSqlGrant, input)).toEqual([discoveryGrant]);
    });
  });
});
