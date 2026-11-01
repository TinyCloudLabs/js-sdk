import { describe, expect, test } from "bun:test";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { approvalPendingError, MAX_APPROVAL_TIMEOUT_MS, parseApprovalTimeout } from "./approval-wait.js";

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
    ["540s", MAX_APPROVAL_TIMEOUT_MS],
    ["9m", MAX_APPROVAL_TIMEOUT_MS],
  ])("accepts %s as %i ms, the same forms `secrets wait --timeout` takes", (value, ms) => {
    expect(parseApprovalTimeout(value)).toBe(ms);
  });

  test("the ceiling is exactly nine minutes", () => {
    expect(MAX_APPROVAL_TIMEOUT_MS).toBe(540_000);
    expect(() => parseApprovalTimeout("541s")).toThrow(CLIError);
    expect(() => parseApprovalTimeout("10m")).toThrow(CLIError);
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

describe("approvalPendingError", () => {
  const pending = { step: 2, of: 2, approvalUrl: "https://openkey.example/a/abc#v=4", expiresAt: "2026-11-01T12:00:00.000Z" };

  test("is exit 8 and carries exactly the four documented fields", () => {
    const error = approvalPendingError(pending);
    expect(error).toBeInstanceOf(CLIError);
    expect(error.exitCode).toBe(8);
    expect(error.code).toBe("APPROVAL_PENDING");
    expect(error.metadata).toEqual({ pending });
  });

  test("its human message differs from the OpenKey-unavailable messages, which share exit 8", () => {
    const error = approvalPendingError(pending);
    expect(error.message).not.toMatch(/could not (discover|fetch)/);
    expect(error.message).toMatch(/run the same command again/i);
  });
});
