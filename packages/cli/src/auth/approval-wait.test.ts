import { describe, expect, test } from "bun:test";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { APPROVAL_COLLECT_GRACE_MS, parseApprovalTimeout, spaceSetupTimeoutMs } from "./approval-wait.js";

function refusal(value: string): CLIError {
  try {
    parseApprovalTimeout(value);
  } catch (error) {
    if (error instanceof CLIError) return error;
    throw error;
  }
  throw new Error(`--timeout ${JSON.stringify(value)} was accepted`);
}

describe("parseApprovalTimeout", () => {
  test.each([
    ["1s", 1_000],
    ["90s", 90_000],
    ["2m", 120_000],
    ["540s", 540_000],
    ["9m", 540_000],
  ])("accepts %s as %i ms, the same forms `secrets wait --timeout` takes", (value, ms) => {
    expect(parseApprovalTimeout(value)).toBe(ms);
  });

  test("the ceiling is exactly nine minutes: 540s passes, 541s does not", () => {
    expect(parseApprovalTimeout("540s")).toBe(9 * 60_000);
    expect(() => parseApprovalTimeout("541s")).toThrow(CLIError);
  });

  test.each(["541s", "10m", "60m", "99999999999999999999s"])("refuses %s as a usage error that names the maximum and what to do", (value) => {
    const error = refusal(value);
    expect(error.exitCode).toBe(ExitCode.USAGE_ERROR);
    expect(error.code).toBe("INVALID_TIMEOUT");
    expect(error.message).toContain("9m");
    expect(error.message).toMatch(/run the command again|re-run|run it again/i);
  });

  test.each(["0", "0s", "0m", "00s"])("refuses the zero wait %s: a zero wait could never see an approval", (value) => {
    const error = refusal(value);
    expect(error.exitCode).toBe(ExitCode.USAGE_ERROR);
    expect(error.code).toBe("INVALID_TIMEOUT");
    expect(error.message).toMatch(/longer than zero|more than zero|positive/i);
  });

  test.each(["", "abc", "-5m", "-1", "5", "1.5m", "90 s", "5h", "1e3s", "NaN", "m", "+5m", "5M"])("refuses %p as a usage error that shows the accepted forms", (value) => {
    const error = refusal(value);
    expect(error.exitCode).toBe(ExitCode.USAGE_ERROR);
    expect(error.code).toBe("INVALID_TIMEOUT");
    expect(error.message).toContain("Ns or Nm");
  });
});

describe("spaceSetupTimeoutMs: what `onboard --timeout` leaves for OpenKey to host a new account's space", () => {
  const NOW = 2_000_000;
  const wait = (deadlineMs: number) => ({ deadlineMs, step: 1, of: 2, now: () => NOW });

  test("is the time left up to the deadline plus the grace", () => {
    expect(spaceSetupTimeoutMs(wait(NOW + 20_000))).toBe(20_000 + APPROVAL_COLLECT_GRACE_MS);
    expect(spaceSetupTimeoutMs(wait(NOW))).toBe(APPROVAL_COLLECT_GRACE_MS);
  });

  test("never less than 15 s, however late the approval arrived", () => {
    expect(spaceSetupTimeoutMs(wait(NOW - APPROVAL_COLLECT_GRACE_MS))).toBe(15_000);
    expect(spaceSetupTimeoutMs(wait(NOW - 10 * 60_000))).toBe(15_000);
  });

  test("is always below the 150 s an unbounded onboard waits", () => {
    expect(spaceSetupTimeoutMs(wait(NOW + 9 * 60_000))).toBeGreaterThan(150_000);
    expect(spaceSetupTimeoutMs(wait(NOW + 60_000))).toBeLessThan(150_000);
  });
});
