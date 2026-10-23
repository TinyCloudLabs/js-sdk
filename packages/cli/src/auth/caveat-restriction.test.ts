import { describe, expect, test } from "bun:test";
import { caveatRestriction } from "./caveat-restriction.js";

const SQL = "tinycloud.sql";

describe("caveatRestriction for delegated SQL caveats", () => {
  test("table and column names compare folded: NOTES is Notes", () => {
    expect(caveatRestriction([{ tables: ["NOTES"] }], SQL)).toBe(caveatRestriction([{ tables: ["Notes"] }], SQL));
    expect(caveatRestriction([{ columns: ["Body", "ID"] }], SQL)).toBe(caveatRestriction([{ columns: ["id", "body"] }], SQL));
  });

  test("order and duplicates do not matter", () => {
    expect(caveatRestriction([{ tables: ["b", "a", "A"], readOnly: true }], SQL))
      .toBe(caveatRestriction([{ readOnly: true, tables: ["a", "b"] }], SQL));
  });

  test("different tables, columns or readOnly stay different", () => {
    const base = caveatRestriction([{ tables: ["notes"] }], SQL);
    expect(caveatRestriction([{ tables: ["other"] }], SQL)).not.toBe(base);
    expect(caveatRestriction([{ tables: ["notes"], readOnly: true }], SQL)).not.toBe(base);
    expect(caveatRestriction([{ tables: ["notes"], columns: ["id"] }], SQL)).not.toBe(base);
    expect(caveatRestriction([{ tables: ["notes", "more"] }], SQL)).not.toBe(base);
  });

  test("tables: [] allows nothing and is not the same as no tables key", () => {
    expect(caveatRestriction([{ tables: [] }], SQL)).not.toBe("");
    expect(caveatRestriction([{ tables: [] }], SQL)).not.toBe(caveatRestriction([{ readOnly: true }], SQL));
  });

  test("the Kelvin sign is not k", () => {
    expect(caveatRestriction([{ tables: ["\u212Ax"] }], SQL)).not.toBe(caveatRestriction([{ tables: ["kx"] }], SQL));
  });

  test("readOnly false, and empty entries of any count, are no restriction", () => {
    for (const caveats of [undefined, [], [{}], [{}, {}], [{ readOnly: false }]]) {
      expect(caveatRestriction(caveats, SQL)).toBe("");
    }
  });

  test("an invalid delegated list falls back to exact comparison, never to unrestricted", () => {
    const invalid = [{ tables: ["a"] }, { tables: ["b"] }];
    expect(caveatRestriction(invalid, SQL)).not.toBe("");
    expect(caveatRestriction([{ tables: ["NOTES."] }], SQL)).not.toBe(caveatRestriction([{ tables: ["notes."] }], SQL));
  });

  test("other services and profiles are compared exactly as before", () => {
    expect(caveatRestriction([{ tables: ["NOTES"] }], "tinycloud.kv")).not.toBe(caveatRestriction([{ tables: ["notes"] }], "tinycloud.kv"));
    expect(caveatRestriction([{ tables: ["NOTES"] }])).not.toBe(caveatRestriction([{ tables: ["notes"] }]));
    const profile = { mode: "constrained-statements", readOnly: true, statements: [{ name: "get", sql: "SELECT 1", fixedParams: [] }] };
    expect(caveatRestriction([profile], SQL)).toBe(JSON.stringify([JSON.stringify({
      mode: "constrained-statements",
      readOnly: true,
      statements: [{ fixedParams: [], name: "get", sql: "SELECT 1" }],
    })]));
  });
});
