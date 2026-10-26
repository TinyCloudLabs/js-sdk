import { describe, expect, test } from "bun:test";
import { parsePsGroups, psGroupArgs } from "./run-command.js";

describe("the ps foreground check of tc secrets run", () => {
  test("asks for each column with its own -o, as BSD ps reads everything after the first = as the header", () => {
    expect(psGroupArgs(4242)).toEqual(["-o", "pgid=", "-o", "tpgid=", "-p", "4242"]);
  });

  test("reads both groups from procps output", () => {
    expect(parsePsGroups("2873688 -1\n")).toEqual({ group: 2873688, foreground: -1 });
    expect(parsePsGroups("  4242  4242\n")).toEqual({ group: 4242, foreground: 4242 });
  });

  for (const [label, output] of [
    ["the BSD header form of a combined -o", ",tpgid=\n4242\n"],
    ["one column", "4242\n"],
    ["three columns", "1 2 3\n"],
    ["nothing", ""],
    ["a non-integer", "4242 4.5\n"],
  ] as const) {
    test(`gives no groups for ${label}, so the signal is passed on`, () => {
      expect(parsePsGroups(output)).toBeUndefined();
    });
  }
});
