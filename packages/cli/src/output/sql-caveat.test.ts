import { describe, expect, test } from "bun:test";
import { ExitCode } from "../config/constants.js";
import { sqlCaveatErrorFields } from "./sql-caveat.js";

const MARKER = "secret_marker_xyz";
const NODE_TEXT = `SELECT ${MARKER} FROM ${MARKER}_table`;

const violation = (meta?: Record<string, unknown>, prefix?: string) =>
  sqlCaveatErrorFields({ code: "SQL_CAVEAT_VIOLATION", message: NODE_TEXT, meta }, prefix);

describe("sqlCaveatErrorFields", () => {
  const ARMS = ["table", "column", "write", "chain"] as const;

  test.each(ARMS)("SQL_CAVEAT_VIOLATION arm %s is a permission denial that records its arm", (arm) => {
    const fields = violation({ arm, status: 403, responseSnippet: NODE_TEXT });
    expect(fields?.code).toBe("SQL_CAVEAT_VIOLATION");
    expect(fields?.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    expect(fields?.metadata).toEqual({ status: 403, arm });
    expect(fields?.message.length).toBeGreaterThan(0);
  });

  test("each arm, and no arm, says something different", () => {
    const messages = [...ARMS.map((arm) => violation({ arm })?.message), violation({})?.message];
    expect(messages.every((message) => typeof message === "string" && message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(messages.length);
  });

  test("an absent, unknown or hostile arm reads as no arm and is not recorded", () => {
    const noArm = violation({})?.message;
    for (const meta of [{ arm: "tables" }, { arm: NODE_TEXT }, { arm: 5 }, { arm: "__proto__" }, undefined]) {
      const fields = violation(meta);
      expect(fields?.message).toBe(noArm);
      expect(fields?.exitCode).toBe(ExitCode.PERMISSION_DENIED);
      expect(fields?.metadata).toEqual({ status: 403 });
    }
  });

  test("neither the node's message nor any meta text reaches the output", () => {
    for (const arm of [...ARMS, undefined]) {
      const fields = violation({ arm, responseSnippet: NODE_TEXT, statusText: NODE_TEXT });
      expect(JSON.stringify(fields)).not.toContain(MARKER);
    }
    const unsupported = sqlCaveatErrorFields({ code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED", message: NODE_TEXT, host: NODE_TEXT });
    expect(JSON.stringify(unsupported)).not.toContain(MARKER);
  });

  test("a command's progress prefix stays in front of the line and is the only added text", () => {
    const prefix = 'Insert into "t" failed after 3 row(s): ';
    const bare = violation({ arm: "write" })?.message;
    const prefixed = violation({ arm: "write" }, prefix)?.message;
    expect(prefixed).toBe(`${prefix}${bare}`);
  });

  test("the arm is read from a CLIError's metadata too", () => {
    const fields = sqlCaveatErrorFields({ code: "SQL_CAVEAT_VIOLATION", metadata: { arm: "column" } });
    expect(fields?.message).toBe(violation({ arm: "column" })?.message);
    expect(fields?.metadata).toEqual({ status: 403, arm: "column" });
  });

  test("SQL_DELEGATED_CAVEATS_UNSUPPORTED is a usage error, worded unlike a refusal", () => {
    const fields = sqlCaveatErrorFields({ code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED", message: "ignored" });
    expect(fields?.code).toBe("SQL_DELEGATED_CAVEATS_UNSUPPORTED");
    expect(fields?.exitCode).toBe(ExitCode.USAGE_ERROR);
    expect(fields?.exitCode).not.toBe(ExitCode.PERMISSION_DENIED);
    expect(fields?.message.length).toBeGreaterThan(0);
    const refusals = [...ARMS.map((arm) => violation({ arm })?.message), violation({})?.message];
    expect(refusals).not.toContain(fields?.message);
  });

  test("other errors are not claimed", () => {
    expect(sqlCaveatErrorFields({ code: "SQL_PERMISSION_DENIED", message: "no" })).toBeUndefined();
    expect(sqlCaveatErrorFields({ code: "SQL_READONLY_VIOLATION", message: "no" })).toBeUndefined();
    expect(sqlCaveatErrorFields(new Error("boom"))).toBeUndefined();
    expect(sqlCaveatErrorFields(null)).toBeUndefined();
    expect(sqlCaveatErrorFields("SQL_CAVEAT_VIOLATION")).toBeUndefined();
  });
});
