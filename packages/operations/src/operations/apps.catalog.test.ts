import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { evaluateOperationAuthority } from "../authority.js";
import type { CapabilityRequirement, RuntimeOperationContext } from "../contract.js";
import type { AppsPermission } from "../tc-apps/kv.js";
import { tcAppsApprovalMessage, tcAppsApprovalReason } from "../tc-apps.js";
import { knowledgeOperationDefinitions } from "./knowledge.js";
import { HEALTHLOG_DATABASE, HEALTHLOG_DAY_CARD, HEALTHLOG_MEAL_DUPLICATE_CHECK, HEALTHLOG_MEAL_INSERT, HEALTHLOG_MEAL_READBACK, HEALTHLOG_MEAL_UPDATE, HEALTHLOG_WEIGHT_INSERT, HEALTHLOG_WEIGHT_READBACK, HEALTHLOG_WEIGHT_TODAY } from "../tc-apps/preamble.js";
import { sqlOperationDefinitions } from "./sql.js";
import { definition, fixture, NEW_SPACE, SPACE, withGrants } from "./apps.fixtures.js";

describe("catalog task approvals", () => {
  test("a first meal asks once with app and three times without, then reads the committed row", async () => {
    for (const named of [true, false]) await fixture(async (_kv, context) => {
      const db = new Database(":memory:");
      db.exec(readFileSync(new URL("../../../cli/src/lib/apps-install.healthlog.schema.sql", import.meta.url), "utf8"));
      const sql = {
        query: async (sql: string, params: (string | number)[]) => {
          const statement = db.query(sql);
          return { ok: true, data: { columns: statement.columnNames, rows: statement.values(...params) } };
        },
        execute: async (sql: string, params: (string | number)[]) => {
          const result = db.query(sql).run(...params);
          return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
        },
      };
      const node = { ...context.runtime.node as object, sqlForSpace: (space: string) => {
        expect(space).toBe(NEW_SPACE);
        return { db: (database: string) => { expect(database).toBe(HEALTHLOG_DATABASE); return sql; } };
      } };
      const runtime = { ...context, runtime: { ...context.runtime, node } } as never;
      let grants: AppsPermission[] = [];
      const requests: AppsPermission[][] = [];
      const approved = async (operation: {
        authority: (context: RuntimeOperationContext, input: never) => Promise<readonly CapabilityRequirement[]>;
        execute: (context: RuntimeOperationContext, input: never) => Promise<{ status: string; output?: unknown }>;
      }, input: unknown) => {
        let active = withGrants(runtime, grants);
        const plan = await operation.authority(active, input as never);
        const missing = evaluateOperationAuthority(grants, plan).missing;
        if (missing.length) {
          requests.push([...missing] as AppsPermission[]);
          grants = [...grants, ...missing] as AppsPermission[];
          active = withGrants(runtime, grants);
        }
        expect(evaluateOperationAuthority(grants, await operation.authority(active, input as never)).missing).toEqual([]);
        const outcome = await operation.execute(active, input as never);
        expect(outcome.status).toBe("ok");
        return outcome.output;
      };
      await approved(definition("context"), named ? { app: "healthlog" } : {});
      const target = { space: "applications", database: HEALTHLOG_DATABASE };
      const duplicate = await approved(sqlDefinition("tinycloud.sql.query"), { ...target, sql: HEALTHLOG_MEAL_DUPLICATE_CHECK, params: ["2026-11-03", "lunch", "Dal"] });
      expect(duplicate).toMatchObject({ rows: [] });
      await approved(sqlDefinition("tinycloud.sql.execute"), { ...target, sql: HEALTHLOG_MEAL_INSERT, params: ["meal-1", "2026-11-03", "lunch", "Dal", 650, "2026-11-03T12:30:00Z"], acknowledgeDatabaseWideAuthority: true });
      const read = await approved(sqlDefinition("tinycloud.sql.query"), { ...target, sql: HEALTHLOG_MEAL_READBACK, params: ["meal-1"] });
      expect(read).toMatchObject({ rows: [[1, "lunch", "Dal", 650]] });
      expect(requests).toHaveLength(named ? 1 : 3);
      expect(requests.every((request) => request.every((entry) => entry.space === NEW_SPACE))).toBe(true);
      db.close();
    });
  });
  test("catalog bundles name only their pinned targets, keep read access read-only, and accept no other reserved ids", async () => {
    await fixture(async (_kv, context) => {
      const list = { service: "tinycloud.kv", space: NEW_SPACE, path: "xyz.tinycloud.tinyapps.catalog/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] };
      const health = { service: "tinycloud.sql", space: NEW_SPACE, path: HEALTHLOG_DATABASE, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] };
      const recipes = { service: "tinycloud.kv", space: NEW_SPACE, path: "xyz.tinycloud.sample.recipes/knowledge/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] };
      expect(await definition("context").authority(context, { app: "healthlog" })).toEqual([list, health]);
      expect(await definition("context").authority(context, { app: "healthlog", access: "read" })).toEqual([list, { ...health, actions: ["tinycloud.sql/read"] }]);
      for (const access of ["read", "change"]) {
        const plan = await definition("context").authority(context, { app: "recipes", access });
        expect(plan).toEqual([list, recipes]);
        expect((await definition("context").execute(context, { app: "recipes", access })).status).toBe("ok");
        for (const concept of ["index", "app"]) {
          const read = knowledgeOperationDefinitions.find((operation) => operation.id === "tinycloud.knowledge.read")!;
          expect(evaluateOperationAuthority(plan, await read.authority(context, { app_id: "xyz.tinycloud.sample.recipes", concept } as never)).missing).toEqual([]);
        }
        const listing = knowledgeOperationDefinitions.find((operation) => operation.id === "tinycloud.knowledge.list")!;
        expect(evaluateOperationAuthority(plan, await listing.authority(context, { app_id: "xyz.tinycloud.sample.recipes" } as never)).missing).toEqual([]);
        const sqlRead = await sqlDefinition("tinycloud.sql.query").authority(context, { space: "applications", database: "notes-chosen-database" } as never);
        expect(evaluateOperationAuthority(plan, sqlRead).missing).toEqual(sqlRead);
        expect(tcAppsApprovalReason(plan)).toContain("Recipes app's notes");
        expect(tcAppsApprovalReason(plan)).not.toContain("change entries");
      }
      const plan = await definition("context").authority(context, { app: "healthlog" });
      expect((await definition("context").execute(context, { app: "healthlog" })).status).toBe("ok");
      expect(tcAppsApprovalReason(plan)).toContain("read your Health Log and add, change or delete entries");
      expect(tcAppsApprovalReason(plan)).toContain("whole Health Log database");
      expect(tcAppsApprovalReason(plan)).toContain("30 days");
      expect(tcAppsApprovalReason(plan)).not.toContain("agent-data");
      expect(tcAppsApprovalMessage(plan)).toContain("OpenKey");
      const read = await definition("context").authority(context, { app: "healthlog", access: "read" });
      expect(tcAppsApprovalReason(read)).toContain("without changing it");
      const readPlan = await sqlDefinition("tinycloud.sql.query").authority(context, { space: "applications", database: HEALTHLOG_DATABASE } as never);
      expect(evaluateOperationAuthority(read, readPlan).missing).toEqual([]);
      const writePlan = await sqlDefinition("tinycloud.sql.execute").authority(context, { space: "applications", database: HEALTHLOG_DATABASE } as never);
      expect(evaluateOperationAuthority(read, writePlan).missing).toMatchObject([{ service: "tinycloud.sql", space: NEW_SPACE, path: HEALTHLOG_DATABASE, actions: ["tinycloud.sql/write"] }]);
      for (const app of ["catalog", "index-stale", "../healthlog", "Healthlog", "xyz.tinycloud.sample.healthlog"]) {
        expect((await definition("context").execute(context, { app })).error.code).toBe("INPUT_INVALID");
      }
      for (const bad of [{ ...health, actions: ["tinycloud.sql/schema"] }, { ...health, path: "other" }, { ...recipes, path: "xyz.tinycloud.sample.recipes/" }, { ...health, space: SPACE }]) {
        expect(tcAppsApprovalReason([list, bad])).toBeUndefined();
      }
    });
  });
});

function sqlDefinition(id: "tinycloud.sql.execute" | "tinycloud.sql.query") {
  const found = sqlOperationDefinitions.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}

describe("Health Log through the generic SQL tools", () => {
  test("the statements the rules give the model are accepted by tinycloud_sql_execute and tinycloud_sql_query", () => {
    const write = (sql: string, params: unknown[]) => sqlDefinition("tinycloud.sql.execute").input.safeParse({
      space: "applications", database: HEALTHLOG_DATABASE, sql, params, acknowledgeDatabaseWideAuthority: true,
    }).success;
    const read = (sql: string) => sqlDefinition("tinycloud.sql.query").input.safeParse({ space: "applications", database: HEALTHLOG_DATABASE, sql, params: [] }).success;
    expect(write(HEALTHLOG_MEAL_INSERT, ["0b6cbd3d-5d6e-4d0e-9f3a-9d1f6a1b7a11", "2026-11-03", "lunch", "Dal and rice", 650, "2026-11-03T12:30:00Z"])).toBe(true);
    // One value short or long is refused, so the placeholder count in the statement is the contract.
    expect(write(HEALTHLOG_MEAL_INSERT, ["a", "2026-11-03", "lunch", "Dal", 650])).toBe(false);
    expect(write(HEALTHLOG_MEAL_INSERT, ["a", "2026-11-03", "lunch", "Dal", 650, "x", "extra"])).toBe(false);
    expect(write(HEALTHLOG_MEAL_UPDATE, [150, "0b6cbd3d-5d6e-4d0e-9f3a-9d1f6a1b7a11"])).toBe(true);
    expect(write(HEALTHLOG_WEIGHT_INSERT, ["0b6cbd3d-5d6e-4d0e-9f3a-9d1f6a1b7a12", "2026-11-03", 80.5, "2026-11-03T07:00:00Z"])).toBe(true);
    expect(write(HEALTHLOG_WEIGHT_INSERT, ["a", "2026-11-03", 80.5])).toBe(false);
    for (const select of [HEALTHLOG_MEAL_DUPLICATE_CHECK, HEALTHLOG_MEAL_READBACK, HEALTHLOG_WEIGHT_READBACK, HEALTHLOG_WEIGHT_TODAY, HEALTHLOG_DAY_CARD]) expect(read(select)).toBe(true);
  });
  test("a meal write asks for the exact Health Log database in the applications space, and nothing else", async () => {
    await fixture(async (_kv, context) => {
      const planned = await sqlDefinition("tinycloud.sql.execute").authority(context, {
        space: "applications", database: HEALTHLOG_DATABASE, sql: HEALTHLOG_MEAL_INSERT, params: ["a", "2026-11-03", "lunch", "Dal", 650, "x"], acknowledgeDatabaseWideAuthority: true,
      } as never);
      expect(planned).toHaveLength(1);
      expect(planned[0]).toMatchObject({ service: "tinycloud.sql", path: HEALTHLOG_DATABASE });
      expect(String(planned[0]!.space)).toBe(SPACE.replace(/:default$/, ":applications"));
    });
  });
});

describe("context time for logged_at", () => {
  test("utc is a whole-second UTC time from the same clock as now", async () => {
    await fixture(async (_kv, context) => {
      const before = Date.now();
      const { output } = await definition("context").execute(context, {});
      expect(output.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Math.abs(Date.parse(output.utc) - before)).toBeLessThan(60_000);
      // `now` carries the owner's offset; the same instant in UTC is `utc`.
      expect(Math.abs(Date.parse(output.now) - Date.parse(output.utc))).toBeLessThan(60_000);
    });
  });
});

describe("the statements in the rules against the pinned Health Log schema", () => {
  function healthLog(): Database {
    const db = new Database(":memory:");
    db.exec(readFileSync(new URL("../../../cli/src/lib/apps-install.healthlog.schema.sql", import.meta.url), "utf8"));
    return db;
  }
  const op = "0b6cbd3d-5d6e-4d0e-9f3a-9d1f6a1b7a11";
  test("a meal and a weight go in with the documented parameters, read back, and total on the day card", () => {
    const db = healthLog();
    db.query(HEALTHLOG_MEAL_INSERT).run(op, "2026-11-03", "lunch", "Dal and rice", 650, "2026-11-03T12:30:00Z");
    db.query(HEALTHLOG_WEIGHT_INSERT).run("0b6cbd3d-5d6e-4d0e-9f3a-9d1f6a1b7a12", "2026-11-03", 80.5, "2026-11-03T07:00:00Z");
    expect(db.query(HEALTHLOG_MEAL_READBACK).all(op)).toMatchObject([{ slot: "lunch", name: "Dal and rice", kcal: 650 }]);
    expect(db.query(HEALTHLOG_WEIGHT_READBACK).all("0b6cbd3d-5d6e-4d0e-9f3a-9d1f6a1b7a12")).toMatchObject([{ day: "2026-11-03", weight_kg: 80.5 }]);
    expect(db.query(HEALTHLOG_DAY_CARD).all("2026-11-03")).toMatchObject([{ kcal: 650, meals: 1, weight_kg: 80.5 }]);
    expect(db.query(HEALTHLOG_MEAL_DUPLICATE_CHECK).all("2026-11-03", "lunch", "Dal and rice")).toHaveLength(1);
    expect(db.query(HEALTHLOG_WEIGHT_TODAY).all("2026-11-03")).toMatchObject([{ weight_kg: 80.5 }]);
    db.query(HEALTHLOG_MEAL_UPDATE).run(150, op);
    expect(db.query(HEALTHLOG_MEAL_READBACK).all(op)).toMatchObject([{ kcal: 150 }]);
  });
  test("the app refuses what the rules say never to send: bad slot, kcal or weight out of range, a repeated op_id", () => {
    const db = healthLog();
    const meal = (id: string, slot: string, kcal: number) => () => db.query(HEALTHLOG_MEAL_INSERT).run(id, "2026-11-03", slot, "Dal", kcal, "2026-11-03T12:30:00Z");
    expect(meal(op, "brunch", 650)).toThrow();
    expect(meal(op, "lunch", 5001)).toThrow();
    meal(op, "lunch", 650)();
    expect(meal(op, "lunch", 650)).toThrow();
    expect(() => db.query(HEALTHLOG_WEIGHT_INSERT).run("w1", "2026-11-03", 19, "2026-11-03T07:00:00Z")).toThrow();
  });
});

describe("telling 'Health Log is not installed' apart from other failures", () => {
  async function failWith(error: unknown) {
    let outcome: Awaited<ReturnType<(typeof sqlOperationDefinitions)[number]["execute"]>> | undefined;
    await fixture(async (_kv, context) => {
      const node = { ...context.runtime.node as object, sqlForSpace: () => ({ db: () => ({ query: async () => ({ ok: false as const, error }) }) }) };
      outcome = await sqlDefinition("tinycloud.sql.query").execute({ ...context, runtime: { ...context.runtime, node } } as never, {
        space: "applications", database: HEALTHLOG_DATABASE, sql: HEALTHLOG_MEAL_DUPLICATE_CHECK, params: ["2026-11-03", "lunch", "Dal"],
      } as never);
    });
    return outcome!;
  }
  const missing = (outcome: Awaited<ReturnType<typeof failWith>>) => outcome.status === "error" && outcome.error.details?.reason === "sql_database_missing";

  test("a missing database or table gives one recognisable, non-retryable error the rules can act on", async () => {
    for (const error of [
      { code: "SQL_DATABASE_NOT_FOUND", message: "SQL query failed: 404 - database not found", meta: { status: 404 } },
      { code: "SQL_ERROR", message: "SQL query failed: 400 - SQLite error: no such table: meal" },
      { code: "SQL_ERROR", message: "SQL query failed: 400 - SQLite error: no such table: nosuchtable" },
    ]) {
      const outcome = await failWith(error);
      expect(missing(outcome)).toBe(true);
      expect(outcome).toMatchObject({ status: "error", error: { code: "NODE_ERROR", retryable: false } });
    }
  });
  test("permission, network and ordinary SQL errors are never reported as not installed", async () => {
    for (const error of [
      { code: "SQL_PERMISSION_DENIED", message: "SQL query failed: 403 - denied" },
      { code: "PERMISSION_DENIED", message: "SQL query failed: 401 - Unauthorized Action: tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000000:applications/sql/xyz.tinycloud.sample.healthlog/healthlog / tinycloud.sql/read" },
      { code: "SQL_ERROR", message: "SQL query failed: 401 - Unauthorized Action: tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000000:applications/sql/xyz.tinycloud.sample.healthlog/healthlog / tinycloud.sql/write" },
      { code: "AUTH_UNAUTHORIZED", message: "SQL query failed: 401" },
      { code: "NETWORK_ERROR", message: "fetch failed" },
      { code: "SQL_ERROR", message: "SQL query failed: 400 - near \"SELEC\": syntax error" },
      { code: "SQL_QUOTA_EXCEEDED", message: "SQL query failed: 429" },
      { code: "SQL_ERROR", message: "SQL query failed: 400 - no such column: kcalz" },
      { code: "SQL_DATABASE_NOT_FOUND", message: "SQL query failed: 404 - Space not found", meta: { status: 404 } },
      { code: "NETWORK_ERROR", message: "SQL query failed: 503" },
    ]) expect(missing(await failWith(error))).toBe(false);
  });
});

describe("an unhosted space is not 'not installed'", () => {
  test("a 404 'Space not found' is reported as an unset-up space, with its own reason", async () => {
    let outcome: { status: string; error?: { code: string; details?: { reason?: string }; retryable?: boolean } } | undefined;
    await fixture(async (_kv, context) => {
      const node = { ...context.runtime.node as object, sqlForSpace: () => ({ db: () => ({ query: async () => ({ ok: false as const, error: { code: "SQL_DATABASE_NOT_FOUND", message: "SQL query failed: 404 - Space not found", meta: { status: 404 } } }) }) }) };
      outcome = await sqlDefinition("tinycloud.sql.query").execute({ ...context, runtime: { ...context.runtime, node } } as never, { space: "applications", database: HEALTHLOG_DATABASE, sql: HEALTHLOG_MEAL_DUPLICATE_CHECK, params: ["2026-11-03", "lunch", "Dal"] } as never);
    });
    expect(outcome).toMatchObject({ status: "error", error: { code: "NODE_ERROR", details: { reason: "space_not_hosted" }, retryable: false } });
  });
});
