import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HEALTHLOG_DATABASE, HEALTHLOG_DAY_CARD, HEALTHLOG_MEAL_DUPLICATE_CHECK, HEALTHLOG_MEAL_INSERT, HEALTHLOG_MEAL_READBACK, HEALTHLOG_MEAL_UPDATE, HEALTHLOG_WEIGHT_INSERT, HEALTHLOG_WEIGHT_READBACK } from "../tc-apps/preamble.js";
import { sqlOperationDefinitions } from "./sql.js";
import { definition, fixture, SPACE } from "./apps.fixtures.js";

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
    for (const select of [HEALTHLOG_MEAL_DUPLICATE_CHECK, HEALTHLOG_MEAL_READBACK, HEALTHLOG_WEIGHT_READBACK, HEALTHLOG_DAY_CARD]) expect(read(select)).toBe(true);
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
