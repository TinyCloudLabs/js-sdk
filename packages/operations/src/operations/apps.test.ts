import { Database } from "bun:sqlite";
import type { SqlValue } from "@tinycloud/node-sdk";
import { describe, expect, test } from "bun:test";
import type { RuntimeOperationContext } from "../contract.js";
import { additionalDelegationsPath, writeJsonAtomic } from "../state.js";
import { copyKey, recordPrefix, staleKey as copyStaleKey, TC_APPS_DISCOVERY_ROOT, TC_APPS_LEGACY_DATABASE, TC_APPS_LEGACY_ROOT } from "../tc-apps/layout.js";
import { appsNow, appsTimezone, withLocalOffset } from "../tc-apps/state.js";
import { checkCopyKinds, copyRowChunks, COPY_INSERT, COPY_DELETE, COPY_REQUEST_LIMIT, queryCopy, syncCopyRows, type AppsDatabase } from "../tc-apps/copy.js";
import { copyFailure } from "../tc-apps/copy.js";
import { markAppsKindStale } from "../tc-apps/kv.js";
import { app, definition, FakeKv, FakeSql, FITNESS, FITNESS_GRANT, fixture, itemKind, key, kind, SPACE, withGrants, withSql, write } from "./apps.fixtures.js";

const DISCOVERY_GRANT = { service: "tinycloud.kv", space: SPACE, path: TC_APPS_DISCOVERY_ROOT, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] };

describe("personal apps records", () => {
  test("context returns records rules, persists a tenant-local timezone, and lists apps from their discovery entries with the copy state", async () => {
    await fixture(async (_kv, context) => {
      const readable = withGrants(context, [FITNESS_GRANT, DISCOVERY_GRANT]);
      const first = await definition("context").execute(readable, {});
      expect(first.output.timezone).toBeNull();
      expect(first.output.now).toMatch(/\+00:00$/);
      expect(first.output.apps).toEqual([{ app: "fitness", title: "Fitness", layout: "new", copy: "none" }]);
      const zoned = await definition("context").execute(readable, { timezone: "America/New_York" });
      expect(zoned.output.timezone).toBe("America/New_York");
      expect(await appsTimezone("apps")).toBe("America/New_York");
      expect(await appsTimezone("another")).toBeNull();
      expect((await definition("context").execute(readable, { timezone: "not/a-zone" })).error.code).toBe("INPUT_INVALID");
      const permissions = [{ service: "tinycloud.sql", space: SPACE, path: `${FITNESS}index`, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] }];
      await writeJsonAtomic(additionalDelegationsPath("apps"), [{ permissions, delegation: { expiry: "2000-01-01T00:00:00Z" } }]);
      expect((await definition("context").execute(readable, {})).output.apps[0]?.copy).toBe("expired");
      await writeJsonAtomic(additionalDelegationsPath("apps"), [{ permissions, delegation: { expiry: "2999-01-01T00:00:00Z" } }]);
      expect((await definition("context").execute(readable, {})).output.apps[0]?.copy).toBe("present");
    }, null);
  });
  test("local dates get the offset on that date, not the current season", () => {
    expect(withLocalOffset("2026-01-14T12:00", "Europe/Berlin")).toBe("2026-01-14T12:00+01:00");
    expect(withLocalOffset("2026-07-14T12:00", "Europe/Berlin")).toBe("2026-07-14T12:00+02:00");
    expect(withLocalOffset("2026-01-14", "Europe/Berlin")).toBe("2026-01-14");
    expect(appsNow("Asia/Kolkata", new Date("2026-01-14T12:00:00Z"))).toBe("2026-01-14T17:30+05:30");
  });
  test("reads CLI-format strings as objects, reports malformed/missing records, and follows list cursors", async () => {
    await fixture(async (kv, context) => {
      kv.seed(key, { v: 1, data: { kg: 70 }, at: "2026-10-14", by: "codex" });
      const malformed = `${FITNESS}weight/2026-10/2026-10-13`;
      kv.seed(malformed, [1]);
      kv.listPages = [[key], [malformed]];
      const result = await definition("read").execute(context, { prefixes: [`${FITNESS}weight/`], keys: [key, malformed, `${FITNESS}weight/2026-10/2026-10-12`] });
      expect(result.output.lists[0].keys).toEqual([key, malformed]);
      expect(kv.lists).toEqual([{ prefix: `${FITNESS}weight/`, limit: 1000 }, { prefix: `${FITNESS}weight/`, limit: 1000, cursor: "1" }]);
      expect(result.output.records).toMatchObject([{ key, value: { data: { kg: 70 } } }, { key: malformed, outcome: "MALFORMED" }, { outcome: "NOT_FOUND" }]);
      expect(kv.reads).toHaveLength(1);
      expect((await definition("read").execute(context, { keys: Array(101).fill(key) })).error.code).toBe("INPUT_INVALID");
    });
  });
  test("validates every op before any effects", async () => {
    await fixture(async (kv, context) => {
      for (const bad of [
        { op: "put", key: `${FITNESS}weight/2026-10/a?b`, value: { data: {} } },
        { op: "put", key: `${FITNESS}weight/../bad`, value: { data: {} } },
        { op: "put", key, value: { data: [] } },
        { op: "put", key, value: { data: {}, by: "client" } },
        { op: "put", key: `${FITNESS}catalog/weight`, value: { ...kind, app: "other" } },
        { op: "delete", key: `${FITNESS}catalog` },
        { op: "put", key: `${FITNESS}index-stale/weight`, value: {} },
      ]) {
        const result = await write(context, [{ op: "put", key, value: { data: { kg: 70 } } }, bad]);
        expect(result.error.code).toBe("INPUT_INVALID");
      }
      expect(kv.writes).toEqual([]);
      expect(kv.reads).toEqual([]);
    });
  });
  test("creates app, kind and first record sequentially, preserves attribution and marks the kind stale", async () => {
    await fixture(async (kv, context) => {
      kv.values.clear();
      const result = await write(context, [
        { op: "put", key: `${FITNESS}catalog`, value: app },
        { op: "put", key: `${FITNESS}catalog/weight`, value: kind },
        { op: "put", key, value: { at: "2026-10-14T12:30", data: { kg: 70 } } },
      ]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok", "ok"]);
      const stored = result.output.ops[2].value;
      expect(stored).toEqual({ by: "tinycloud-mcp", v: 1, at: "2026-10-14T12:30+02:00", data: { kg: 70 } });
      expect(kv.values.has(`${FITNESS}index-stale/weight`)).toBe(true);
      expect(kv.reads.flat()).not.toContain(key);
    });
  });
  test("timezone is required for record ops but not catalog ops", async () => {
    await fixture(async (_kv, context) => {
      const result = await write(context, [{ op: "put", key: `xyz.tinycloud.tinyapps.books/catalog`, value: { ...app, app: "books" } }, { op: "put", key, value: { data: {} } }, { op: "delete", key }]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "TIMEZONE_REQUIRED", "TIMEZONE_REQUIRED"]);
    }, null);
  });
  test("warns about unknown fields and date slips rather than refusing them", async () => {
    await fixture(async (_kv, context) => {
      const result = await write(context, [{ op: "put", key, value: { at: "2026-10-13", data: { "Odd-field": 1, due: "October", done: "2026-10-14" } } }]);
      expect(result.output.ops[0].outcome).toBe("ok");
      expect(result.output.ops[0].warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("Odd-field"), expect.stringContaining("due"), expect.stringContaining("at"),
      ]));
    });
  });
  test("only timed creates suffix after 412; other creates expose EXISTS and replacements expose CHANGED", async () => {
    await fixture(async (kv, context) => {
      const original = kv.seed(key, { v: 1, data: { kg: 69 } });
      const result = await write(context, [{ op: "put", key, value: { data: { kg: 70 } } }]);
      expect(result.output.ops[0]).toMatchObject({ outcome: "EXISTS", etag: original, value: { data: { kg: 69 } } });
      kv.seed(`${FITNESS}catalog/session`, { ...kind, kind: "session", per: "time" });
      const timed = `${FITNESS}session/2026-10/2026-10-14T1200-run`;
      kv.seed(timed, {});
      const suffixed = await write(context, [{ op: "put", key: timed, value: { data: {} } }]);
      expect(suffixed.output.ops[0]).toMatchObject({ outcome: "ok", key: `${timed}-2` });
      kv.beforePut = (writing) => { if (writing === key) { kv.beforePut = undefined; kv.seed(key, { data: { kg: 68 } }); } };
      const race = await write(context, [{ op: "put", key, etag: original, value: { data: { kg: 71 } } }]);
      expect(race.output.ops[0]).toMatchObject({ outcome: "CHANGED", value: { data: { kg: 68 } } });
      expect(kv.writes.find((entry) => entry.options.ifMatch === original)?.options).toEqual({ ifMatch: original });
    });
  });
  test("catalog guard preserves field meanings and states ordering unless version rises with history", async () => {
    await fixture(async (kv, context) => {
      const catalogKey = `${FITNESS}catalog/goal`;
      const original = kv.seed(catalogKey, itemKind);
      const clean = JSON.parse(JSON.stringify(itemKind));
      for (const value of [{ ...clean, fields: {} }, { ...clean, fields: { kg: "pounds" } }, { ...clean, states: ["done", "open"] }, { ...clean, shape: "log", per: "day" }]) {
        const result = await write(context, [{ op: "put", key: catalogKey, etag: original, value }]);
        expect(result.output.ops[0]).toMatchObject({ outcome: "CATALOG_CHANGE", etag: original });
      }
      const extended = await write(context, [{ op: "put", key: catalogKey, etag: original, value: { ...clean, states: ["open", "waiting", "done"], fields: { kg: "number", note: "text" } } }]);
      expect(extended.output.ops[0].outcome).toBe("ok");
      const changed = await write(context, [{ op: "put", key: catalogKey, etag: extended.output.ops[0].etag, value: { ...clean, v: 2, shape: "log", per: "time", history: "v1 was an item", fields: {} } }]);
      expect(changed.output.ops[0].outcome).toBe("ok");
    });
  });
  test("existing records may be edited, moved and deleted regardless of current kind shape", async () => {
    await fixture(async (kv, context) => {
      const legacy = `${FITNESS}weight/old-state/legacy`;
      const etag = kv.seed(legacy, { v: 1, data: {} });
      const edited = await write(context, [{ op: "put", key: legacy, etag, value: { data: { kg: 70 } } }]);
      expect(edited.output.ops[0].outcome).toBe("ok");
      const to = `${FITNESS}weight/another-state/legacy`;
      const moved = await write(context, [{ op: "move", from: legacy, to, etag: edited.output.ops[0].etag, value: { data: { kg: 70 } } }]);
      expect(moved.output.ops[0]).toMatchObject({ outcome: "ok", steps: ["written", "deleted"] });
      expect(kv.values.has(legacy)).toBe(false);
      expect((await write(context, [{ op: "delete", key: to, etag: moved.output.ops[0].etag }])).output.ops[0].outcome).toBe("ok");
    });
  });
  test("moves stop before deletion when destination exists, and expose committed destination when source changed or deletion fails", async () => {
    await fixture(async (kv, context) => {
      const from = `${FITNESS}weight/open/legacy`;
      const to = `${FITNESS}weight/done/legacy`;
      const sourceEtag = kv.seed(from, { data: {} });
      kv.seed(to, { data: { kg: 2 } });
      const op = { op: "move", from, to, etag: sourceEtag, value: { data: { kg: 1 } } };
      expect((await write(context, [op])).output.ops[0]).toMatchObject({ outcome: "EXISTS", steps: [] });
      expect(kv.deletes).toEqual([]);
      kv.values.delete(to);
      kv.seed(from, { data: { kg: 3 } });
      const raced = await write(context, [op]);
      expect(raced.output.ops[0]).toMatchObject({ outcome: "CHANGED", steps: ["written"], value: { data: { kg: 1 } } });
      expect(kv.values.has(from)).toBe(true);
      expect(kv.values.has(to)).toBe(true);
      kv.values.delete(to);
      kv.deleteFailure = "AUTH_REQUIRED";
      const refused = await write(context, [op]);
      expect(refused.status).toBe("ok");
      expect(refused.output.ops[0]).toMatchObject({ outcome: "AUTH_REQUIRED", steps: ["written"] });
      expect(kv.values.has(`${FITNESS}index-stale/weight`)).toBe(true);
    });
  });
  test("node refusals and stale-mark failure never hide previous effects", async () => {
    await fixture(async (kv, context) => {
      const second = `${FITNESS}weight/2026-10/2026-10-15`;
      kv.putFailure = (key) => key === second ? "PERMISSION_DENIED" : key.includes("index-stale/") ? "AUTH_REQUIRED" : undefined;
      const result = await write(context, [{ op: "put", key, value: { data: {} } }, { op: "put", key: second, value: { data: {} } }]);
      expect(result.status).toBe("ok");
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "PERMISSION_DENIED"]);
      expect(result.output.ops[0].warnings).toEqual(expect.arrayContaining([expect.stringContaining("AUTH_REQUIRED")]));
      expect(kv.values.has(key)).toBe(true);
    });
  });
  test("new records require catalogs and fit log frequency, month and item states", async () => {
    await fixture(async (kv, context) => {
      const invalid = await write(context, [
        { op: "put", key: `xyz.tinycloud.tinyapps.unknown/weight/2026-10/2026-10-14`, value: { data: {} } },
        { op: "put", key: `${FITNESS}weight/2026-11/2026-10-14`, value: { data: {} } },
        { op: "put", key: `${FITNESS}weight/2026-10/2026-10-14T1200-weight`, value: { data: {} } },
      ]);
      expect(invalid.output.ops.map((op) => op.outcome)).toEqual(["INVALID", "INVALID", "INVALID"]);
      expect(kv.writes).toEqual([]);
      kv.seed(`${FITNESS}catalog/goal`, itemKind);
      const state = await write(context, [{ op: "put", key: `${FITNESS}goal/unknown/2026-10-14-weight`, value: { data: {} } }]);
      expect(state.output.ops[0].outcome).toBe("INVALID");
      const allowed = await write(context, [{ op: "put", key: `${FITNESS}goal/open/2026-10-14-weight`, value: { data: {} } }]);
      expect(allowed.output.ops[0].outcome).toBe("ok");
    });
  });
  test("destination refusal preserves a move source, and a thrown delete preserves completed steps", async () => {
    await fixture(async (kv, context) => {
      const from = `${FITNESS}weight/open/legacy`;
      const to = `${FITNESS}weight/done/legacy`;
      const original = kv.seed(from, { data: {} });
      const op = { op: "move", from, to, etag: original, value: { data: {} } };
      kv.putFailure = (key) => key === to ? "AUTH_REQUIRED" : undefined;
      const refused = await write(context, [op]);
      expect(refused.output.ops[0]).toMatchObject({ outcome: "AUTH_REQUIRED", steps: [] });
      expect(kv.deletes).toEqual([]);
      expect(kv.values.has(from)).toBe(true);
      kv.putFailure = undefined;
      kv.delete = async () => { throw new Error("connection lost"); };
      const interrupted = await write(context, [op]);
      expect(interrupted.output.ops[0]).toMatchObject({ outcome: "NODE_ERROR", steps: ["written"] });
      expect(kv.values.has(from)).toBe(true);
      expect(kv.values.has(to)).toBe(true);
    });
  });
  test("read and context refuse successful objects without an ETag", async () => {
    await fixture(async (kv, context) => {
      kv.seed(key, { v: 1, at: "2026-10-14", data: { kg: 70 } });
      kv.omitReadEtag = true;
      expect((await definition("read").execute(context, { keys: [key] })).error.code).toBe("NODE_ERROR");
      expect((await definition("context").execute(withGrants(context, [FITNESS_GRANT, DISCOVERY_GRANT]), {})).error.code).toBe("NODE_ERROR");
    });
  });
});

const weightKind = { app: "fitness", kind: "weight" };
const staleKey = `${FITNESS}index-stale/weight`;
const LEGACY_SPACE = SPACE.replace(/:applications$/, ":default");
const legacyKey = `${TC_APPS_LEGACY_ROOT}fitness/weight/2026-10/2026-10-14`;
const legacyStaleKey = `${TC_APPS_LEGACY_ROOT}index-stale/fitness/weight`;
const copyGrants = {
  legacy: { service: "tinycloud.sql", space: LEGACY_SPACE, path: TC_APPS_LEGACY_DATABASE, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] },
  new: { service: "tinycloud.sql", space: SPACE, path: `${FITNESS}index`, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] },
};

/** Run the actual copy statements and entries views, adapting only the SDK result envelope. */
class SqliteCopy {
  readonly database = new Database(":memory:");
  handle(): AppsDatabase { return this as unknown as AppsDatabase; }
  async execute(sql: string, params: SqlValue[] = []) {
    try {
      const result = this.database.query(sql).run(...params);
      return { ok: true as const, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL_ERROR", message: (error as Error).message } };
    }
  }
  async query(sql: string, params: SqlValue[] = []) {
    try {
      const statement = this.database.query(sql);
      const rows = statement.values(...params);
      return { ok: true as const, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL_ERROR", message: (error as Error).message } };
    }
  }
}

function withLayoutCopies(context: RuntimeOperationContext, currentKv: FakeKv, legacyKv: FakeKv, currentSql: AppsDatabase, legacySql: AppsDatabase): RuntimeOperationContext {
  return { ...context, runtime: { ...context.runtime,
    granted: [copyGrants.new, copyGrants.legacy],
    node: {
      kvForSpace: (space: string) => {
        if (space === SPACE) return currentKv;
        if (space === LEGACY_SPACE) return legacyKv;
        throw new Error(`Unexpected KV space ${space}`);
      },
      sqlForSpace: (space: string) => ({ db: (database: string) => {
        if (space === SPACE && database === `${FITNESS}index`) return currentSql;
        if (space === LEGACY_SPACE && database === TC_APPS_LEGACY_DATABASE) return legacySql;
        throw new Error(`Unexpected SQL copy ${space}/${database}`);
      } }),
    },
  } };
}

describe("personal apps fast copy", () => {
  test("legacy queries refresh stale full keys, filter the shared entries view by app and kind, and preserve other copies", async () => {
    await fixture(async (kv, context) => {
      const legacyKv = new FakeKv();
      const legacySql = new SqliteCopy();
      const currentSql = new SqliteCopy();
      try {
        for (const sql of [legacySql, currentSql]) sql.database.exec("CREATE TABLE records (key TEXT PRIMARY KEY, rec TEXT NOT NULL)");
        const value = { v: 1, at: "2026-10-14", by: "cli", data: { kg: 72 } };
        legacyKv.seed(legacyKey, value);
        legacyKv.seed(legacyStaleKey, { since: "2026-10-13" });
        const liftKey = `${TC_APPS_LEGACY_ROOT}fitness/lift/2026-10/2026-10-14`;
        const otherAppKey = `${TC_APPS_LEGACY_ROOT}other/weight/2026-10/2026-10-14`;
        const liftMarker = `${TC_APPS_LEGACY_ROOT}index-stale/fitness/lift`;
        legacyKv.seed(liftMarker, { since: "2026-10-12" });
        // These kinds were not requested. Their SQL rows survive even if absent from this KV snapshot.
        await syncCopyRows(legacySql.handle(), [
          { k: legacyKey, r: { ...value, data: { kg: 60 } } },
          { k: liftKey, r: { data: { kg: 110 } } },
          { k: otherAppKey, r: { data: { kg: 80 } } },
        ]);
        kv.seed(key, { data: { kg: 99 } });
        kv.seed(staleKey, { since: "2026-10-13" });
        await syncCopyRows(currentSql.handle(), [{ k: copyKey("fitness", key), r: { data: { kg: 88 } } }]);
        const active = withLayoutCopies(context, kv, legacyKv, currentSql.handle(), legacySql.handle());
        const result = await definition("query").execute(active, {
          layout: "legacy", kinds: [weightKind],
          sql: "SELECT key, app, kind, folder, id, day, v, at, \"by\", json_extract(data, '$.kg') AS kg FROM entries WHERE app = ? AND kind = ?",
          params: ["fitness", "weight"],
        });
        expect(result.output).toEqual({
          kinds: [{ ...weightKind, records: 1 }],
          columns: ["key", "app", "kind", "folder", "id", "day", "v", "at", "by", "kg"],
          rows: [[legacyKey, "fitness", "weight", "2026-10", "2026-10-14", "2026-10-14", 1, "2026-10-14", "cli", 72]], rowCount: 1,
        });
        expect(legacySql.database.query("SELECT app, kind, json_extract(data, '$.kg') FROM entries ORDER BY app, kind").values()).toEqual([
          ["fitness", "lift", 110], ["fitness", "weight", 72], ["other", "weight", 80],
        ]);
        expect(legacyKv.values.has(legacyStaleKey)).toBe(false);
        expect(JSON.parse(legacyKv.values.get(liftMarker)!.text)).toEqual({ since: "2026-10-12" });
        expect(JSON.parse(legacyKv.values.get(legacyKey)!.text)).toEqual(value);
        expect(currentSql.database.query("SELECT key, json_extract(rec, '$.data.kg') FROM records").values()).toEqual([[copyKey("fitness", key), 88]]);
        expect(kv.values.has(staleKey)).toBe(true);
        const current = await definition("query").execute(active, {
          kinds: [weightKind], sql: "SELECT key, kind, json_extract(data, '$.kg') AS kg FROM entries WHERE kind = ?", params: ["weight"],
        });
        expect(current.output).toEqual({
          kinds: [{ ...weightKind, records: 1 }], columns: ["key", "kind", "kg"],
          rows: [[copyKey("fitness", key), "weight", 99]], rowCount: 1,
        });
        expect(kv.values.has(staleKey)).toBe(false);
        expect(legacySql.database.query("SELECT key, json_extract(data, '$.kg') FROM entries WHERE app = 'fitness' AND kind = 'weight'").values()).toEqual([[legacyKey, 72]]);
      } finally {
        legacySql.database.close();
        currentSql.database.close();
      }
    });
  });
  test("a missing legacy copy builds the shared schema and reads every page in bounded batches", async () => {
    const kv = new FakeKv();
    const sql = new SqliteCopy();
    try {
      kv.pageSize = 73;
      for (let i = 0; i < 205; i++) kv.seed(`${legacyKey}-${i}`, { data: { kg: i } });
      expect(await checkCopyKinds(kv, sql.handle(), [weightKind], () => 0, "legacy")).toEqual({ kinds: [{ ...weightKind, records: 205 }] });
      expect(await queryCopy(sql.handle(), "SELECT count(*) AS n, sum(json_extract(data, '$.kg')) AS total FROM entries WHERE app = ? AND kind = ?", ["fitness", "weight"], "legacy")).toEqual({
        columns: ["n", "total"], rows: [[205, 20910]], rowCount: 1,
      });
      expect(kv.reads.every((batch) => batch.length <= 100)).toBe(true);
      expect(kv.values.has(legacyStaleKey)).toBe(false);
    } finally { sql.database.close(); }
  });
  test("copy grants stay layout-specific and missing approval never erases committed record outcomes", async () => {
    for (const approved of ["legacy", "new", "none"] as const) await fixture(async (kv, context) => {
      const legacyKv = new FakeKv();
      legacyKv.seed(`${TC_APPS_LEGACY_ROOT}catalog/fitness`, app);
      legacyKv.seed(`${TC_APPS_LEGACY_ROOT}catalog/fitness/weight`, kind);
      const currentSql = new FakeSql();
      const legacySql = new FakeSql();
      const active = withGrants(withLayoutCopies(context, kv, legacyKv, currentSql.handle(), legacySql.handle()), approved === "none" ? [] : [copyGrants[approved]]);
      const result = await write(active, [
        { op: "put", key: legacyKey, value: { data: { kg: 70 } } },
        { op: "put", key, value: { data: { kg: 80 } } },
      ]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok"]);
      expect(result.output.ops.map((op) => op.value?.by)).toEqual(["tinycloud-mcp", "tinycloud-mcp"]);
      expect(JSON.parse(legacyKv.values.get(legacyKey)!.text)).toEqual(result.output.ops[0]!.value);
      expect(JSON.parse(kv.values.get(key)!.text)).toEqual(result.output.ops[1]!.value);
      if (approved === "legacy") expect(legacySql.rows.get(legacyKey)).toEqual(result.output.ops[0]!.value);
      else expect(legacySql.calls).toEqual([]);
      if (approved === "new") expect(currentSql.rows.get(copyKey("fitness", key))).toEqual(result.output.ops[1]!.value);
      else expect(currentSql.calls).toEqual([]);
      expect(legacyKv.values.has(legacyStaleKey)).toBe(approved !== "legacy");
      expect(kv.values.has(staleKey)).toBe(approved !== "new");
    });
  });
  test("authorization refusals are not mistaken for a missing legacy schema", async () => {
    for (const [code, status, expected] of [["AUTH_UNAUTHORIZED", 401, "AUTH_REQUIRED"], ["AUTH_FORBIDDEN", 403, "PERMISSION_DENIED"]] as const) {
      const sql = new FakeSql();
      sql.table = false;
      sql.failures.push({ code, message: "no such table: entries", meta: { status } });
      await expect(queryCopy(sql.handle(), "SELECT app FROM entries", [], "legacy")).rejects.toMatchObject({ operationError: { code: expected } });
      expect(sql.calls).toHaveLength(1);
      expect(sql.table).toBe(false);
    }
  });
  test("row encoding preserves objects, unicode and escaping; deletion removes only absent rows", async () => {
    const sql = new FakeSql();
    sql.rows.set("gone", { old: true });
    sql.rows.set("untouched", { retain: true });
    const value = { v: 1, data: { text: "雪\\\"\n", n: 3 } };
    await syncCopyRows(sql.handle(), [{ k: key, r: value }, { k: "gone" }]);
    expect(sql.rows.get(key)).toEqual(value);
    expect(sql.rows.has("gone")).toBe(false);
    expect(sql.rows.get("untouched")).toEqual({ retain: true });
  });
  test("chunks stay strictly below the escaped UTF-8 request boundary", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ k: `${key}-${i}`, r: { text: '雪"\\\n'.repeat(22000) } }));
    const chunks = copyRowChunks(rows);
    expect(chunks.flatMap((chunk) => JSON.parse(chunk))).toEqual(rows);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) for (const sql of [COPY_INSERT, COPY_DELETE]) {
      expect(Buffer.byteLength(JSON.stringify({ action: "execute", sql, params: [chunk] }))).toBeLessThan(COPY_REQUEST_LIMIT);
    }
    const small = [{ k: "a", r: { text: '雪"\\' } }];
    const exact = Buffer.byteLength(JSON.stringify({ action: "execute", sql: COPY_INSERT, params: [JSON.stringify(small)] }));
    expect(() => copyRowChunks(small, exact)).toThrow();
    expect(copyRowChunks(small, exact + 1)).toEqual([JSON.stringify(small)]);
  });
  test("a failed delete phase repeats both statements once, preserving the final rows", async () => {
    const sql = new FakeSql();
    sql.rows.set("gone", {});
    sql.afterInsert = () => {
      sql.afterInsert = undefined;
      sql.failures.push({ code: "NETWORK_ERROR" });
    };
    await syncCopyRows(sql.handle(), [{ k: key, r: { data: {} } }, { k: "gone" }]);
    expect(sql.calls.map((call) => call.sql)).toEqual([COPY_INSERT, COPY_DELETE, COPY_INSERT, COPY_DELETE]);
    expect([...sql.rows.keys()]).toEqual([key]);
  });
  test("writes sync the actual timed suffix and deleted keys only with active runtime authority", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${FITNESS}catalog/lift`, { ...kind, kind: "lift", per: "time" });
      const timed = `${FITNESS}lift/2026-10/2026-10-14T1200-bench`;
      kv.seed(timed, { v: 1, at: "2026-10-14", data: {} });
      const sql = new FakeSql();
      const active = withSql(context, sql);
      const result = await write(active, [{ op: "put", key: timed, value: { data: { kg: 60 } } }]);
      expect(result.output.ops[0]?.key).toBe(`${timed}-2`);
      expect(sql.rows.get(copyKey("fitness", `${timed}-2`))).toEqual(result.output.ops[0]?.value);
      await write(active, [{ op: "delete", key: `${timed}-2` }]);
      expect(sql.rows.has(copyKey("fitness", `${timed}-2`))).toBe(false);
      const calls = sql.calls.length;
      await write(withSql(context, sql, false), [{ op: "put", key, value: { data: { kg: 70 } } }]);
      expect(sql.calls.length).toBe(calls);
      expect(kv.values.has(staleKey)).toBe(true);
    });
  });
  test("partial moves retain both copies; completed moves remove only the source", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${FITNESS}catalog/goal`, itemKind);
      const from = `${FITNESS}goal/open/2026-10-14-goal`;
      const to = `${FITNESS}goal/done/2026-10-14-goal`;
      const source = { v: 1, at: "2026-10-14", data: { title: "goal" } };
      const etag = kv.seed(from, source);
      const sql = new FakeSql();
      kv.deleteFailure = "AUTH_UNAUTHORIZED";
      const partial = await write(withSql(context, sql), [{ op: "move", from, to, etag, value: source }]);
      expect(partial.output.ops[0]?.steps).toEqual(["written"]);
      expect(sql.rows.get(copyKey("fitness", from))).toEqual(source);
      expect(sql.rows.get(copyKey("fitness", to))).toEqual(partial.output.ops[0]?.value);
      kv.deleteFailure = undefined;
      const next = `${FITNESS}goal/done/2026-10-14-next`;
      const complete = await write(withSql(context, sql), [{ op: "move", from, to: next, etag, value: source }]);
      expect(complete.output.ops[0]?.steps).toEqual(["written", "deleted"]);
      expect(sql.rows.has(copyKey("fitness", from))).toBe(false);
      expect(sql.rows.get(copyKey("fitness", next))).toEqual(complete.output.ops[0]?.value);
    });
  });
  test("repeated sync refusal and missing schema preserve committed outcomes and mark kinds stale", async () => {
    for (const missing of [false, true]) await fixture(async (kv, context) => {
      const sql = new FakeSql();
      if (missing) sql.table = false;
      else sql.failures.push({ code: "AUTH_UNAUTHORIZED" }, { code: "AUTH_UNAUTHORIZED" });
      const result = await write(withSql(context, sql), [{ op: "put", key, value: { data: {} } }]);
      expect(result.output.ops[0]?.outcome).toBe("ok");
      expect(kv.values.has(key)).toBe(true);
      expect(kv.values.has(staleKey)).toBe(true);
      expect(sql.calls.length).toBe(missing ? 1 : 2);
    });
  });
  test("queries create missing schema, rebuild every listed key in batches of at most 100, and bind parameters", async () => {
    await fixture(async (kv, context) => {
      kv.pageSize = 73;
      const keys = Array.from({ length: 205 }, (_, i) => `${key}-${i}`);
      for (const key of keys) kv.seed(key, { v: 1, data: { kg: 72 } });
      const sql = new FakeSql();
      sql.table = false;
      sql.view = false;
      const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "SELECT ? AS answer FROM entries", params: ["bound value"] });
      expect(result.output).toEqual({ kinds: [{ ...weightKind, records: 205 }], columns: ["answer"], rows: [["bound value"]], rowCount: 1 });
      expect([...sql.rows.keys()]).toEqual(keys.map((k) => copyKey("fitness", k)));
      expect(kv.reads.every((batch) => batch.length <= 100)).toBe(true);
      expect(kv.values.has(staleKey)).toBe(false);
    });
  });
  test("equal counts skip rebuild only without a stale mark; mismatch deletes obsolete rows", async () => {
    await fixture(async (kv) => {
      const value = { data: { kg: 72 } };
      kv.seed(key, value);
      const sql = new FakeSql();
      sql.rows.set(copyKey("fitness", key), { data: { kg: 60 } });
      expect(await checkCopyKinds(kv, sql.handle(), [weightKind])).toEqual({ kinds: [{ ...weightKind, records: 1 }] });
      expect(sql.rows.get(copyKey("fitness", key))).toEqual({ data: { kg: 60 } });
      kv.seed(staleKey, { since: "2026-10-14" });
      await checkCopyKinds(kv, sql.handle(), [weightKind]);
      expect(sql.rows.get(copyKey("fitness", key))).toEqual(value);
      sql.rows.set(copyKey("fitness", `${key}-obsolete`), {});
      await checkCopyKinds(kv, sql.handle(), [weightKind]);
      expect([...sql.rows.keys()]).toEqual([copyKey("fitness", key)]);
      expect(kv.values.has(staleKey)).toBe(false);
    });
  });
  test("same-day concurrent changes retain their stale marker with content-derived ETags in either layout", async () => {
    for (const layout of ["legacy", "new"] as const) await fixture(async (kv) => {
      const record = `${recordPrefix("fitness", "weight", layout)}2026-10/2026-10-14`;
      const marker = copyStaleKey("fitness", "weight", layout);
      kv.seed(record, { data: { kg: 72 } });
      const sql = new FakeSql();
      let concurrentEtag: string | undefined;
      sql.afterInsert = async () => {
        kv.seed(record, { data: { kg: 73 } });
        await markAppsKindStale(kv, "fitness", "weight", new Date().toISOString(), layout);
        concurrentEtag = kv.values.get(marker)!.etag;
      };
      await expect(checkCopyKinds(kv, sql.handle(), [weightKind], () => 0, layout)).rejects.toThrow();
      expect(kv.values.get(marker)?.etag).toBe(concurrentEtag);
      expect(sql.rows.get(copyKey("fitness", record, layout))).toEqual({ data: { kg: 72 } });
      expect(JSON.parse(kv.values.get(record)!.text)).toEqual({ data: { kg: 73 } });
    });
  });
  test("an omitted or malformed listed value cannot produce a complete rebuild", async () => {
    await fixture(async (kv) => {
      kv.seed(key, "not a record object");
      const sql = new FakeSql();
      await expect(checkCopyKinds(kv, sql.handle(), [weightKind])).rejects.toThrow();
      expect(kv.values.has(staleKey)).toBe(true);
      expect(sql.rows.has(copyKey("fitness", key))).toBe(false);
    });
  });
  test("a changing key set fails verification and leaves the kind stale", async () => {
    await fixture(async (kv) => {
      kv.seed(key, { data: {} });
      const sql = new FakeSql();
      sql.afterInsert = () => { kv.seed(`${key}-new`, { data: {} }); };
      await expect(checkCopyKinds(kv, sql.handle(), [weightKind])).rejects.toThrow();
      expect(kv.values.has(staleKey)).toBe(true);
    });
  });
  test("a missing view is recreated without discarding an already checked copy", async () => {
    await fixture(async (kv, context) => {
      const value = { data: { kg: 72 } };
      kv.seed(key, value);
      const sql = new FakeSql();
      sql.rows.set(copyKey("fitness", key), value);
      sql.view = false;
      const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "SELECT ? FROM entries", params: [72] });
      expect(result.output).toEqual({ kinds: [{ ...weightKind, records: 1 }], columns: ["answer"], rows: [[72]], rowCount: 1 });
      expect(sql.rows.get(copyKey("fitness", key))).toEqual(value);
      expect(kv.writes).toEqual([]);
    });
  });
  test("finishes a started kind after sixty seconds but marks all unstarted kinds stale in the same layout", async () => {
    for (const layout of ["legacy", "new"] as const) await fixture(async (kv) => {
      const record = `${recordPrefix("fitness", "weight", layout)}2026-10/2026-10-14`;
      kv.seed(record, { data: {} });
      const sql = new FakeSql();
      let now = 0;
      sql.afterInsert = () => { now = 60_000; };
      const remaining = [{ app: "fitness", kind: "lift" }, { app: "fitness", kind: "goal" }];
      expect(await checkCopyKinds(kv, sql.handle(), [weightKind, ...remaining], () => now, layout)).toEqual({ outcome: "COPY_PARTIAL", remaining });
      expect(sql.rows.has(copyKey("fitness", record, layout))).toBe(true);
      expect(kv.values.has(copyStaleKey("fitness", "weight", layout))).toBe(false);
      for (const kind of remaining) expect(kv.values.has(copyStaleKey(kind.app, kind.kind, layout))).toBe(true);
    });
  });
  test("rejects writes and multiple statements before touching storage; WITH reads are accepted", async () => {
    await fixture(async (_kv, context) => {
      const sql = new FakeSql();
      for (const statement of ["DELETE FROM records", "SELECT 1; SELECT 2", "PRAGMA table_info(records)", "WITH x AS (SELECT 1) DELETE FROM records"]) {
        const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: statement });
        expect(result.error.code).toBe("INPUT_INVALID");
      }
      expect(sql.calls).toEqual([]);
      expect((await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "WITH x AS (SELECT 1) SELECT * FROM x" })).status).toBe("ok");
    });
  });
  test("409 is nonretryable copy_unavailable, without an approval or retry loop", async () => {
    await fixture(async (kv, context) => {
      const sql = new FakeSql();
      sql.failures.push({ code: "NETWORK_ERROR", meta: { status: 409 } });
      const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "SELECT 1" });
      expect(result.error.code).toBe("NODE_ERROR");
      expect(result.error.retryable).toBe(false);
      expect(result.error.details).toEqual({ reason: "copy_unavailable" });
      expect(sql.calls.length).toBe(1);
      sql.failures.push({ code: "NETWORK_ERROR", meta: { status: 409 } });
      const written = await write(withSql(context, sql), [{ op: "put", key, value: { data: {} } }]);
      expect(written.output.ops[0]?.outcome).toBe("ok");
      expect(sql.calls.length).toBe(2);
      expect(kv.values.has(staleKey)).toBe(true);
    });
  });
});

describe("fast-copy request-size mapping", () => {
  test("maps request-side 413 to invalid input and response-side 413 to a result limit", () => {
    expect(copyFailure({ code: "SQL_REQUEST_TOO_LARGE" }).operationError).toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(copyFailure({ code: "SQL_RESPONSE_TOO_LARGE" }).operationError).toMatchObject({
      code: "SQL_RESULT_LIMIT_EXCEEDED",
    });
  });
});
