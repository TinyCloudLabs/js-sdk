import { describe, expect, test } from "bun:test";
import { ExitCode } from "../config/constants.js";
import { sqlCaveatErrorFields } from "./sql-caveat.js";

const NODE_TEXT = "SELECT secret_col FROM secret_table";

describe("sqlCaveatErrorFields", () => {
  const ARMS = [
    ["table", "This grant doesn't allow that table."],
    ["column", "This grant doesn't allow that column."],
    ["write", "This grant doesn't allow changes."],
    ["chain", "This grant can't be checked, so nothing ran."],
  ] as const;

  for (const [arm, message] of ARMS) {
    test(`SQL_CAVEAT_VIOLATION arm ${arm} is a permission denial with one fixed line`, () => {
      const fields = sqlCaveatErrorFields({ code: "SQL_CAVEAT_VIOLATION", message: NODE_TEXT, meta: { arm, status: 403 } });
      expect(fields).toEqual({
        code: "SQL_CAVEAT_VIOLATION",
        message,
        exitCode: ExitCode.PERMISSION_DENIED,
        metadata: { status: 403, arm },
      });
    });
  }

  test("an absent or unknown arm gets the general line and no arm", () => {
    for (const meta of [{}, { arm: "tables" }, { arm: NODE_TEXT }, { arm: 5 }, { arm: "__proto__" }, undefined]) {
      const fields = sqlCaveatErrorFields({ code: "SQL_CAVEAT_VIOLATION", message: NODE_TEXT, meta });
      expect(fields?.message).toBe("This grant doesn't allow that request.");
      expect(fields?.exitCode).toBe(ExitCode.PERMISSION_DENIED);
      expect(fields?.metadata).toEqual({ status: 403 });
    }
  });

  test("neither the node's message nor any meta text reaches the output", () => {
    const fields = sqlCaveatErrorFields({
      code: "SQL_CAVEAT_VIOLATION",
      message: NODE_TEXT,
      meta: { arm: "table", responseSnippet: NODE_TEXT, statusText: NODE_TEXT },
    });
    expect(JSON.stringify(fields)).not.toContain("secret");
  });

  test("a command's progress prefix is kept in front of the fixed line", () => {
    const fields = sqlCaveatErrorFields(
      { code: "SQL_CAVEAT_VIOLATION", message: "x", meta: { arm: "write" } },
      'Insert into "t" failed after 3 row(s): ',
    );
    expect(fields?.message).toBe('Insert into "t" failed after 3 row(s): This grant doesn\'t allow changes.');
  });

  test("the arm is read from a CLIError's metadata too", () => {
    const fields = sqlCaveatErrorFields({ code: "SQL_CAVEAT_VIOLATION", metadata: { arm: "column" } });
    expect(fields?.message).toBe("This grant doesn't allow that column.");
  });

  test("SQL_DELEGATED_CAVEATS_UNSUPPORTED is a usage error with one fixed line", () => {
    const fields = sqlCaveatErrorFields({
      code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED",
      message: `ignored ${NODE_TEXT}`,
      host: "https://node.example",
    });
    expect(fields).toEqual({
      code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED",
      message: "This node can't limit SQL grants to tables or columns yet, so nothing was sent.",
      exitCode: ExitCode.USAGE_ERROR,
    });
  });

  test("other errors are not claimed", () => {
    expect(sqlCaveatErrorFields({ code: "SQL_PERMISSION_DENIED", message: "no" })).toBeUndefined();
    expect(sqlCaveatErrorFields({ code: "SQL_READONLY_VIOLATION", message: "no" })).toBeUndefined();
    expect(sqlCaveatErrorFields(new Error("boom"))).toBeUndefined();
    expect(sqlCaveatErrorFields(null)).toBeUndefined();
    expect(sqlCaveatErrorFields("SQL_CAVEAT_VIOLATION")).toBeUndefined();
  });
});
