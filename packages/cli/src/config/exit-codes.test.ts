import { describe, expect, test } from "bun:test";
import { APPROVAL_EXIT } from "@tinycloud/share-envelope/links";
import { ExitCode } from "./constants.js";

// TC-2377 / TC-2378: the approval requester's exit numbers come from the share-envelope machine (`APPROVAL_EXIT`) and nowhere else.
// Scripts branch on these numbers, so the table is a contract.

describe("the CLI exit table", () => {
  test("exit 4 keeps its meaning: a KV key that was not found", () => {
    expect(ExitCode.NOT_FOUND).toBe(4);
  });

  test("the approval exits are additive: 11 denied, 12 clock, 13 output exists", () => {
    expect(ExitCode.APPROVAL_DENIED).toBe(11);
    expect(ExitCode.APPROVAL_CLOCK).toBe(12);
    expect(ExitCode.OUTPUT_EXISTS).toBe(13);
  });

  test("every number the approval machine can return is an entry of the table", () => {
    const table = new Set<number>(Object.values(ExitCode));
    for (const [outcome, exit] of Object.entries(APPROVAL_EXIT)) {
      expect(table.has(exit), `${outcome} exits ${exit}`).toBe(true);
    }
  });

  test("the numbers of the entries that existed before are unchanged", () => {
    expect({
      SUCCESS: ExitCode.SUCCESS, ERROR: ExitCode.ERROR, USAGE_ERROR: ExitCode.USAGE_ERROR, AUTH_REQUIRED: ExitCode.AUTH_REQUIRED,
      NOT_FOUND: ExitCode.NOT_FOUND, PERMISSION_DENIED: ExitCode.PERMISSION_DENIED, NETWORK_ERROR: ExitCode.NETWORK_ERROR,
      NODE_ERROR: ExitCode.NODE_ERROR, PENDING: ExitCode.PENDING, STORAGE_FULL: ExitCode.STORAGE_FULL, CANCELLED: ExitCode.CANCELLED,
    }).toEqual({
      SUCCESS: 0, ERROR: 1, USAGE_ERROR: 2, AUTH_REQUIRED: 3, NOT_FOUND: 4, PERMISSION_DENIED: 5, NETWORK_ERROR: 6,
      NODE_ERROR: 7, PENDING: 8, STORAGE_FULL: 10, CANCELLED: 130,
    });
  });

  test("no two entries share a number, and none takes a number another command owns (9 share partial success, 126-129 shell)", () => {
    const numbers = Object.values(ExitCode);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const taken of [9, 126, 127, 128, 129]) expect(numbers).not.toContain(taken);
  });

  test("an approval outcome exits with the entry of the same meaning", () => {
    expect(APPROVAL_EXIT.denied).toBe(ExitCode.APPROVAL_DENIED);
    expect(APPROVAL_EXIT.clock).toBe(ExitCode.APPROVAL_CLOCK);
    expect(APPROVAL_EXIT.pending).toBe(ExitCode.PENDING);
    expect(APPROVAL_EXIT.unreachable).toBe(ExitCode.NETWORK_ERROR);
    expect(APPROVAL_EXIT.unexpected).toBe(ExitCode.NODE_ERROR);
    expect(APPROVAL_EXIT.refused).toBe(ExitCode.PERMISSION_DENIED);
    expect(APPROVAL_EXIT.lapsed).toBe(ExitCode.AUTH_REQUIRED);
    expect(APPROVAL_EXIT.gone).toBe(ExitCode.AUTH_REQUIRED);
  });
});
