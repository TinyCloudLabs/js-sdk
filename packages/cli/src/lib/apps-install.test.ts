import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PinnedApp } from "./apps-install-pin.js";
import { SHARE_ORIGIN, pinnedApp } from "./apps-install-pin.js";
import {
  AppsInstallError,
  installApp,
  planDdl,
  sha256Hex,
  splitStatements,
  type InstallIo,
} from "./apps-install.js";
import { appsInstallIo, type InstallDbPort, type InstallKvPort } from "../commands/apps.js";

const enc = (text: string) => new TextEncoder().encode(text);

const SCHEMA = [
  "-- pinned schema",
  "CREATE TABLE IF NOT EXISTS meal (id INTEGER PRIMARY KEY, note TEXT); -- trailing",
  "CREATE INDEX IF NOT EXISTS meal_note ON meal(note);",
  "CREATE VIEW IF NOT EXISTS meal_count AS SELECT COUNT(*) AS n FROM meal;",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "schema.sql": SCHEMA,
  "knowledge/app.md": "# app\n",
  "knowledge/meals.md": "# meals\n",
  "knowledge/index.md": "# index\n",
};

const BUNDLE = "digest123";

function buildApp(files: Record<string, string> = FILES): { app: PinnedApp; served: Map<string, Uint8Array> } {
  const served = new Map<string, Uint8Array>();
  const pinnedFiles = Object.entries(files).map(([path, text]) => {
    const bytes = enc(text);
    served.set(`${SHARE_ORIGIN}/apps/b/${BUNDLE}/${path}`, bytes);
    return { path, sha256: sha256Hex(bytes), size: bytes.length };
  });
  // knowledge/index.md is last, as in the pinned catalog.
  pinnedFiles.sort((a, b) => Number(a.path === "knowledge/index.md") - Number(b.path === "knowledge/index.md"));
  return {
    app: { appId: "test.app", database: "testdb", bundleDigest: BUNDLE, files: pinnedFiles },
    served,
  };
}

interface FakeOptions {
  served: Map<string, Uint8Array>;
  kv?: Map<string, Uint8Array>;
  tables?: string[];
}

function fakeIo({ served, kv = new Map(), tables = [] }: FakeOptions) {
  const sql: string[] = [];
  const kvWrites: string[] = [];
  const knownTables = new Set(tables);
  const io: InstallIo = {
    async fetchBytes(url) {
      const bytes = served.get(url);
      if (!bytes) throw new Error(`404 ${url}`);
      return bytes;
    },
    async kvGet(key) {
      return kv.get(key);
    },
    async kvCreate(key, bytes) {
      if (kv.has(key)) return "exists";
      kv.set(key, bytes);
      kvWrites.push(key);
      return "created";
    },
    async sqlExecute(statement) {
      sql.push(statement);
      const table = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
      if (table) knownTables.add(table[1]!);
    },
    async sqlTableNames() {
      return [...knownTables];
    },
  };
  return { io, sql, kvWrites, kv };
}

describe("splitStatements", () => {
  it("strips -- comments and keeps -- inside single quotes", () => {
    const out = splitStatements("SELECT '--not a comment' AS x; -- note\nSELECT 2;");
    expect(out).toEqual(["SELECT '--not a comment' AS x", "SELECT 2"]);
  });
});

describe("planDdl", () => {
  it("accepts the three pinned forms and emits DROP VIEW only for pinned views", () => {
    const plan = planDdl(SCHEMA);
    expect(plan.tables).toEqual(["meal"]);
    expect(plan.views).toEqual(["meal_count"]);
    expect(plan.statements).toEqual([
      "CREATE TABLE IF NOT EXISTS meal (id INTEGER PRIMARY KEY, note TEXT)",
      "CREATE INDEX IF NOT EXISTS meal_note ON meal(note)",
      "DROP VIEW IF EXISTS meal_count",
      "CREATE VIEW IF NOT EXISTS meal_count AS SELECT COUNT(*) AS n FROM meal",
    ]);
  });

  it.each([
    ["DROP TABLE", "DROP TABLE meal"],
    ["DROP INDEX", "DROP INDEX meal_note"],
    ["DROP VIEW", "DROP VIEW meal_count"],
    ["ALTER", "ALTER TABLE meal ADD COLUMN x TEXT"],
    ["DELETE", "DELETE FROM meal"],
  ])("refuses %s before any statement runs", (_label, statement) => {
    expect(() => planDdl(`${SCHEMA}${statement};`)).toThrow(AppsInstallError);
  });

  it.each([
    ["table with WITHOUT ROWID tail", "CREATE TABLE IF NOT EXISTS t (a INTEGER) WITHOUT ROWID"],
    ["index with WHERE tail", "CREATE INDEX IF NOT EXISTS i ON meal(note) WHERE note IS NOT NULL"],
    ["view that is not a SELECT", "CREATE VIEW IF NOT EXISTS v AS WITH x AS (SELECT 1) SELECT * FROM x"],
  ])("refuses a %s", (_label, statement) => {
    expect(() => planDdl(`${statement};`)).toThrow(AppsInstallError);
  });

  it("plans the real pinned healthlog schema.sql, whose bytes match the pinned digest", () => {
    const bytes = new Uint8Array(readFileSync(new URL("./apps-install.healthlog.schema.sql", import.meta.url)));
    const pinned = pinnedApp("xyz.tinycloud.sample.healthlog")?.files.find((file) => file.path === "schema.sql");
    expect(sha256Hex(bytes)).toBe(pinned?.sha256);
    const plan = planDdl(new TextDecoder().decode(bytes));
    expect(plan.tables).toEqual(["meal", "weight"]);
    expect(plan.views).toEqual(["day_card", "week_rollup"]);
  });
});

describe("pinned bundle shape", () => {
  it("pins only schema.sql and knowledge files, with no path escape and index.md last", () => {
    const app = pinnedApp("xyz.tinycloud.sample.healthlog");
    const paths = app?.files.map((file) => file.path) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.includes("..")).toBe(false);
      expect(path === "schema.sql" || path.startsWith("knowledge/")).toBe(true);
    }
    expect(paths[paths.length - 1]).toBe("knowledge/index.md");
  });
});

describe("installApp", () => {
  it("refuses unknown apps without any I/O", async () => {
    const { served } = buildApp();
    const { io, sql, kvWrites } = fakeIo({ served });
    await expect(installApp("nope", io, () => undefined)).rejects.toMatchObject({ code: "UNKNOWN_APP" });
    expect(sql).toEqual([]);
    expect(kvWrites).toEqual([]);
  });

  it("refuses a tampered byte before any write", async () => {
    const { app, served } = buildApp();
    served.set(`${SHARE_ORIGIN}/apps/b/${BUNDLE}/knowledge/meals.md`, enc("# tampered\n"));
    const { io, sql, kvWrites } = fakeIo({ served });
    await expect(installApp("test.app", io, () => app)).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(sql).toEqual([]);
    expect(kvWrites).toEqual([]);
  });

  it("refuses a same-length tampered byte, so the sha256 check alone catches it", async () => {
    const { app, served } = buildApp();
    served.set(`${SHARE_ORIGIN}/apps/b/${BUNDLE}/knowledge/meals.md`, enc("# mealz\n"));
    const { io, sql, kvWrites } = fakeIo({ served });
    expect(enc("# mealz\n").length).toBe(enc("# meals\n").length);
    await expect(installApp("test.app", io, () => app)).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(sql).toEqual([]);
    expect(kvWrites).toEqual([]);
  });

  it("refuses a file above the size limit even when the hash matches", async () => {
    const big = "x".repeat(1_000_001);
    const { app, served } = buildApp({ ...FILES, "knowledge/big.md": big });
    const { io, sql, kvWrites } = fakeIo({ served });
    await expect(installApp("test.app", io, () => app)).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(sql).toEqual([]);
    expect(kvWrites).toEqual([]);
  });

  it("installs fresh: creates tables and views, writes knowledge with index.md last", async () => {
    const { app, served } = buildApp();
    const { io, sql, kvWrites } = fakeIo({ served });
    const result = await installApp("test.app", io, () => app);
    expect(result.status).toBe("installed");
    expect(result.tablesCreated).toEqual(["meal"]);
    expect(result.viewsRecreated).toEqual(["meal_count"]);
    expect(sql).toContain("DROP VIEW IF EXISTS meal_count");
    expect(kvWrites).toEqual(["test.app/knowledge/app.md", "test.app/knowledge/meals.md", "test.app/knowledge/index.md"]);
    expect(kvWrites.at(-1)).toBe("test.app/knowledge/index.md");
    expect(result.filesWritten).toHaveLength(3);
  });

  describe("app install record", () => {
    const recordKey = "test.app/app/install.json";
    const record = (digest: unknown) =>
      enc(JSON.stringify({ source: { repo: "r", tag: "t", commit: "c" }, digest, installed_at: "2026-01-01T00:00:00Z" }));

    it("installs when no install record exists", async () => {
      const { app, served } = buildApp();
      const { io } = fakeIo({ served });
      expect((await installApp("test.app", io, () => app)).status).toBe("installed");
    });

    it("installs when the record names the pinned digest", async () => {
      const { app, served } = buildApp();
      const kv = new Map<string, Uint8Array>([[recordKey, record(BUNDLE)]]);
      const { io } = fakeIo({ served, kv });
      expect((await installApp("test.app", io, () => app)).status).toBe("installed");
    });

    it.each([
      ["another digest", record("older-digest"), "INSTALL_RECORD_MISMATCH"],
      ["a non-string digest", record(42), "INSTALL_RECORD_INVALID"],
      ["no JSON", enc("not json"), "INSTALL_RECORD_INVALID"],
    ])("refuses a record with %s before any write", async (_label, bytes, code) => {
      const { app, served } = buildApp();
      const kv = new Map<string, Uint8Array>([[recordKey, bytes]]);
      const { io, sql, kvWrites } = fakeIo({ served, kv });
      await expect(installApp("test.app", io, () => app)).rejects.toMatchObject({ code });
      expect(sql).toEqual([]);
      expect(kvWrites).toEqual([]);
    });
  });

  it("reports already when every knowledge file is present and identical, still refreshing views", async () => {
    const { app, served } = buildApp();
    const kv = new Map<string, Uint8Array>();
    for (const file of app.files.filter((f) => f.path.startsWith("knowledge/"))) {
      kv.set(`test.app/${file.path}`, served.get(`${SHARE_ORIGIN}/apps/b/${BUNDLE}/${file.path}`)!);
    }
    const { io, sql, kvWrites } = fakeIo({ served, kv, tables: ["meal"] });
    const result = await installApp("test.app", io, () => app);
    expect(result.status).toBe("already");
    expect(result.tablesCreated).toEqual([]);
    expect(result.viewsRecreated).toEqual(["meal_count"]);
    expect(kvWrites).toEqual([]);
    expect(sql).toContain("DROP VIEW IF EXISTS meal_count");
  });

  it("leaves a differing note as the user edited it, reports it, and installs the rest without throwing", async () => {
    const { app, served } = buildApp();
    const kv = new Map<string, Uint8Array>([["test.app/knowledge/meals.md", enc("# local edit\n")]]);
    const { io, sql, kvWrites } = fakeIo({ served, kv });
    const result = await installApp("test.app", io, () => app);
    expect(result.status).toBe("installed");
    expect(result.conflicts).toEqual(["knowledge/meals.md"]);
    expect(result.filesWritten).toEqual(["knowledge/app.md", "knowledge/index.md"]);
    expect(kv.get("test.app/knowledge/meals.md")).toEqual(enc("# local edit\n"));
    expect(kvWrites).not.toContain("test.app/knowledge/meals.md");
    expect(kvWrites.at(-1)).toBe("test.app/knowledge/index.md");
    expect(sql).toContain("DROP VIEW IF EXISTS meal_count");
  });

  it("treats a create race that lost to identical bytes as unchanged", async () => {
    const { app, served } = buildApp();
    const kv = new Map<string, Uint8Array>();
    const { io } = fakeIo({ served, kv });
    const racing: InstallIo = {
      ...io,
      async kvCreate(key, bytes) {
        kv.set(key, bytes);
        return "exists";
      },
    };
    const result = await installApp("test.app", racing, () => app);
    expect(result.filesWritten).toEqual([]);
    expect(result.filesUnchanged).toHaveLength(3);
    expect(result.status).toBe("already");
  });

  it("saves notes first, then reports a schema failure as notes saved and tables not set up", async () => {
    const { app, served } = buildApp();
    const { io, kvWrites } = fakeIo({ served });
    const failing: InstallIo = {
      ...io,
      async sqlExecute() {
        throw new Error("SQLITE_ERROR");
      },
    };
    const error = await installApp("test.app", failing, () => app).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppsInstallError);
    expect(error).toMatchObject({ code: "SQL_FAILED" });
    expect((error as AppsInstallError).message).toMatch(/^notes saved; tables not set up: run again\./);
    expect(kvWrites).toEqual(["test.app/knowledge/app.md", "test.app/knowledge/meals.md", "test.app/knowledge/index.md"]);
  });

  it("refuses a DDL plan that drops a table before any note is written", async () => {
    const { app, served } = buildApp({ ...FILES, "schema.sql": "DROP TABLE meal;\n" });
    const { io, kvWrites } = fakeIo({ served });
    await expect(installApp("test.app", io, () => app)).rejects.toMatchObject({ code: "DDL_REFUSED" });
    expect(kvWrites).toEqual([]);
  });

  it("a second run restores a pinned view that was dropped, with its CREATE statement", async () => {
    const { app, served } = buildApp();
    const kv = new Map<string, Uint8Array>();
    for (const file of app.files.filter((f) => f.path.startsWith("knowledge/"))) {
      kv.set(`test.app/${file.path}`, served.get(`${SHARE_ORIGIN}/apps/b/${BUNDLE}/${file.path}`)!);
    }
    const { io, sql } = fakeIo({ served, kv, tables: ["meal"] });
    const result = await installApp("test.app", io, () => app);
    expect(result.viewsRecreated).toEqual(["meal_count"]);
    expect(sql.some((s) => s.startsWith("CREATE VIEW IF NOT EXISTS meal_count"))).toBe(true);
  });

  it("never issues DROP for a view or table outside the pinned schema", async () => {
    const { app, served } = buildApp();
    const { io, sql } = fakeIo({ served, tables: ["other_table"] });
    await installApp("test.app", io, () => app);
    const drops = sql.filter((s) => s.startsWith("DROP"));
    expect(drops).toEqual(["DROP VIEW IF EXISTS meal_count"]);
  });
});

describe("appsInstallIo create-only KV mapping", () => {
  const noDb: InstallDbPort = {
    execute: async () => ({ ok: true, data: undefined }),
    query: async () => ({ ok: true, data: { rows: [] } }),
  };

  /** A KV that honors ifNoneMatch "*" like the node: an existing key refuses the create. */
  function honoringKv(initial: Map<string, Uint8Array>) {
    const putOptions: unknown[] = [];
    const kv: InstallKvPort = {
      async get(key) {
        const bytes = initial.get(key);
        return bytes ? { ok: true, data: { data: bytes } } : { ok: false, error: { code: "KV_NOT_FOUND" } };
      },
      async put(key, value, options) {
        putOptions.push(options);
        if (options.ifNoneMatch === "*" && initial.has(key)) {
          return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
        }
        initial.set(key, value);
        return { ok: true, data: undefined };
      },
    };
    return { kv, putOptions };
  }

  it("creates a missing note with ifNoneMatch * and reports created", async () => {
    const stored = new Map<string, Uint8Array>();
    const { kv, putOptions } = honoringKv(stored);
    const io = appsInstallIo(kv, noDb);
    expect(await io.kvCreate("notes/a.md", enc("hello"))).toBe("created");
    expect(putOptions).toEqual([{ ifNoneMatch: "*" }]);
    expect(stored.get("notes/a.md")).toEqual(enc("hello"));
  });

  it("never overwrites a note that appeared after inspection and reports exists", async () => {
    const stored = new Map<string, Uint8Array>([["notes/a.md", enc("the owner's edit")]]);
    const { kv } = honoringKv(stored);
    const io = appsInstallIo(kv, noDb);
    expect(await io.kvCreate("notes/a.md", enc("pinned"))).toBe("exists");
    expect(stored.get("notes/a.md")).toEqual(enc("the owner's edit"));
  });

  it("surfaces any other put failure instead of treating it as exists", async () => {
    const kv: InstallKvPort = {
      get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }),
      put: async () => ({ ok: false, error: { code: "KV_UNAVAILABLE" } }),
    };
    const io = appsInstallIo(kv, noDb);
    await expect(io.kvCreate("notes/a.md", enc("x"))).rejects.toThrow("KV_UNAVAILABLE");
  });
});
