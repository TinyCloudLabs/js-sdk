import { describe, expect, test } from "bun:test";
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
