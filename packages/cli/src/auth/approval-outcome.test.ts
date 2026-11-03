import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { APPROVAL_EXIT, type Outcome } from "@tinycloud/share-envelope/links";
import { CLIError, approvalPendingOf, handleError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { APPROVAL_ERROR_CODES, approvalOutcomeError, approvalOutcomeWarning, type OutcomeContext } from "./approval-outcome.js";
import { approvalNextLine } from "./approval-next-line.js";
import { isMaybeGranted } from "./refusal.js";

// TC-2377 / TC-2378 spec 5a: every outcome of the approval requester machine becomes ONE CLI error: its code STRING (never renamed;
// scripts and watchers grep them), its exit number (from the machine's APPROVAL_EXIT, nowhere else) and a message that says what to do.

const LINK = "https://openkey.example/a/abcdefghijklmnopqrstuvwxyz#v=4&k=synthetic";
const EXPIRES_AT = Date.parse("2026-11-03T12:00:00.000Z");
const open: OutcomeContext = { entry: { approvalUrl: LINK, phase: "open" }, step: 2, of: 3 };
const approved: OutcomeContext = { entry: { approvalUrl: LINK, phase: "fetched" } };
const committed: OutcomeContext = { entry: { approvalUrl: LINK, phase: "committed" } };

interface Row { readonly name: string; readonly outcome: Outcome; readonly context: OutcomeContext; readonly code: string; readonly exit: number; readonly says: RegExp[]; readonly never?: RegExp[] }
const rows: Row[] = [
  { name: "pending", outcome: { kind: "pending", expiresAt: EXPIRES_AT, confirmedLiveAt: EXPIRES_AT - 60_000 }, context: open,
    code: "APPROVAL_PENDING", exit: 8, says: [/Still waiting/, /same command again/, /2026-11-03T12:00:00\.000Z/] },
  { name: "unreachable before any approval", outcome: { kind: "unreachable", expiresAt: EXPIRES_AT }, context: open,
    code: "APPROVAL_REQUEST_UNAVAILABLE", exit: 6, says: [/could not reach|could not be reached|unreachable/i, /Retry the command to resume/], never: [/Still waiting/] },
  { name: "unreachable after the owner approved", outcome: { kind: "unreachable", expiresAt: EXPIRES_AT, resultExpiresAt: EXPIRES_AT + 60_000 }, context: approved,
    code: "APPROVAL_RESULT_UNAVAILABLE", exit: 6, says: [/Retry the command to resume/], never: [/Still waiting/] },
  { name: "unexpected answers before any approval", outcome: { kind: "unexpected" }, context: open,
    code: "APPROVAL_REQUEST_UNAVAILABLE", exit: 7, says: [/Retry the command to resume/] },
  { name: "unexpected answers after the owner approved", outcome: { kind: "unexpected" }, context: approved,
    code: "APPROVAL_RESULT_UNAVAILABLE", exit: 7, says: [/Retry the command to resume/] },
  { name: "unexpected answer to the acknowledgement of a SAVED grant", outcome: { kind: "unexpected", grantSaved: true }, context: committed,
    code: "APPROVAL_ACK_PENDING", exit: 7, says: [/profile already holds the grant/i, /acknowledg/i], never: [/sign in again/i, /not signed in/i] },
  { name: "request expired", outcome: { kind: "lapsed", reason: "expired_request", grantMayBeLive: "no" }, context: open,
    code: "APPROVAL_REQUEST_EXPIRED", exit: 3, says: [/expired before it was approved/, /new request/i] },
  { name: "request unknown to OpenKey", outcome: { kind: "lapsed", reason: "not_found", grantMayBeLive: "no" }, context: open,
    code: "APPROVAL_REQUEST_NOT_FOUND", exit: 3, says: [/cannot find this approval request/] },
  { name: "request past its expiry seen through a rejected proof", outcome: { kind: "lapsed", reason: "proof_after_expiry", grantMayBeLive: "no" }, context: open,
    code: "APPROVAL_REQUEST_EXPIRED", exit: 3, says: [/new request/i] },
  { name: "request purged by the clock", outcome: { kind: "lapsed", reason: "purged", grantMayBeLive: "no" }, context: open,
    code: "APPROVAL_REQUEST_EXPIRED", exit: 3, says: [/new request/i] },
  { name: "result expired before it was collected", outcome: { kind: "gone", reason: "expired_result", grantMayBeLive: "yes" }, context: approved,
    code: "APPROVAL_RESULT_EXPIRED", exit: 3, says: [/expired before it was saved/, /new request/i] },
  { name: "result unknown to OpenKey", outcome: { kind: "gone", reason: "not_found", grantMayBeLive: "yes" }, context: approved,
    code: "APPROVAL_RESULT_NOT_FOUND", exit: 3, says: [/cannot find this approval result/] },
  { name: "result already acknowledged (was exit 8 and kept: now exit 3 and dropped)", outcome: { kind: "gone", reason: "acknowledged", grantMayBeLive: "yes" }, context: approved,
    code: "APPROVAL_RESULT_ACKNOWLEDGED", exit: 3, says: [/already collected/i, /no grant/i, /new request/i] },
  { name: "delegation ended before it could be saved", outcome: { kind: "gone", reason: "ended", grantMayBeLive: "yes" }, context: approved,
    code: "APPROVAL_RESULT_EXPIRED", exit: 3, says: [/new request/i] },
  { name: "result purged by the clock", outcome: { kind: "gone", reason: "purged", grantMayBeLive: "yes" }, context: approved,
    code: "APPROVAL_RESULT_EXPIRED", exit: 3, says: [/new request/i] },
  { name: "request binding refused", outcome: { kind: "refused", reason: "request_binding", grantMayBeLive: "maybe" }, context: open,
    code: "APPROVAL_RESULT_INVALID", exit: 5, says: [/rejected the request or requester binding/] },
  { name: "request refused as invalid (a real header fault: NEVER reported as expired)", outcome: { kind: "refused", reason: "request_invalid", grantMayBeLive: "maybe" }, context: open,
    code: "APPROVAL_RESULT_INVALID", exit: 5, says: [/invalid/i], never: [/expired/i] },
  { name: "requester proof refused with a sane clock", outcome: { kind: "refused", reason: "proof", grantMayBeLive: "maybe" }, context: open,
    code: "APPROVAL_RESULT_INVALID", exit: 5, says: [/proof|binding/i] },
  { name: "denied by the owner", outcome: { kind: "denied" }, context: open,
    code: "APPROVAL_DENIED", exit: 11, says: [/declined/, /Nothing was granted/, /only if (they|the owner) want/i], never: [/expired/i] },
  { name: "clock disagreement", outcome: { kind: "clock" }, context: open,
    code: "APPROVAL_CLOCK", exit: 12, says: [/clock/i, /fix the clock/i, /run (it|the same command) again/i] },
  { name: "clock disagreement of a SAVED grant", outcome: { kind: "clock", grantSaved: true }, context: committed,
    code: "APPROVAL_CLOCK", exit: 12, says: [/profile already holds the grant/i, /clock/i], never: [/sign in again/i] },
  { name: "internal", outcome: { kind: "internal", reason: "missing-entry" }, context: open,
    code: "APPROVAL_REQUEST_UNAVAILABLE", exit: 7, says: [/Retry the command to resume/] },
];

describe("each outcome becomes one CLI error", () => {
  test.each(rows)("$name: $code, exit $exit", ({ outcome, context, code, exit, says, never }) => {
    const error = approvalOutcomeError(outcome, context);
    expect(error).toBeInstanceOf(CLIError);
    expect(error!.code).toBe(code);
    expect(error!.exitCode).toBe(exit);
    for (const pattern of says) expect(error!.message).toMatch(pattern);
    for (const pattern of never ?? []) expect(error!.message).not.toMatch(pattern);
  });

  test("the exit number is the machine's own, never a second table", () => {
    for (const { outcome, context, exit } of rows) {
      const error = approvalOutcomeError(outcome, context)!;
      expect(error.exitCode, outcome.kind).toBe(exit);
      expect(error.exitCode, outcome.kind).toBe(APPROVAL_EXIT[outcome.kind]);
    }
  });

  test("a pending approval carries exactly the fields an agent acts on", () => {
    const error = approvalOutcomeError({ kind: "pending", expiresAt: EXPIRES_AT, confirmedLiveAt: EXPIRES_AT - 1 }, open)!;
    expect(error.metadata).toEqual({ pending: { step: 2, of: 3, approvalUrl: LINK, expiresAt: "2026-11-03T12:00:00.000Z" } });
  });

  test("a completed run is not an error, and an outstanding acknowledgement is a warning (exit 0), not exit 8", () => {
    expect(approvalOutcomeError({ kind: "completed" }, committed)).toBeUndefined();
    expect(approvalOutcomeWarning({ kind: "completed" })).toBeUndefined();
    for (const warning of ["ack-pending", "ack-conflict", "ack-expired"] as const) {
      expect(approvalOutcomeError({ kind: "completed", warning }, committed)).toBeUndefined();
      expect(approvalOutcomeWarning({ kind: "completed", warning }), warning).toMatch(/saved|already/i);
    }
    expect(approvalOutcomeWarning({ kind: "completed", warning: "ack-pending" })).toMatch(/acknowledg/i);
    expect(APPROVAL_EXIT.completed).toBe(ExitCode.SUCCESS);
  });

  test("a caller's own removal is not an error", () => {
    expect(approvalOutcomeError({ kind: "abandoned", reason: "logout", grantMayBeLive: "no" }, open)).toBeUndefined();
  });

  test("a refusal found by the CLI's own verification keeps the error the verification raised (its OPENKEY_* code and exit)", () => {
    const cause = new CLIError("OPENKEY_OWNER_MISMATCH", "The owner differs.", ExitCode.PERMISSION_DENIED);
    expect(approvalOutcomeError({ kind: "refused", reason: "verification", grantMayBeLive: "yes" }, { ...approved, cause })).toBe(cause);
  });

  test("a refusal raised from the poll is marked maybe-granted: the CLI never learned what the owner did", () => {
    const maybe = approvalOutcomeError({ kind: "refused", reason: "request_binding", grantMayBeLive: "maybe" }, open)!;
    expect(isMaybeGranted(maybe)).toBe(true);
    const known = approvalOutcomeError({ kind: "refused", reason: "request_binding", grantMayBeLive: "yes" }, approved)!;
    expect(isMaybeGranted(known)).toBe(false);
  });

  test("the clock message says which way the clock is off, and by how much", () => {
    const ahead = approvalOutcomeError({ kind: "clock", skewMs: 120_000 }, open)!;
    expect(ahead.message).toMatch(/ahead/i);
    expect(ahead.message).toMatch(/\b120 ?s(econds)?\b|\b2 minutes\b/);
    const behind = approvalOutcomeError({ kind: "clock", skewMs: -300_000 }, open)!;
    expect(behind.message).toMatch(/behind/i);
    expect(behind.message).toMatch(/\b300 ?s(econds)?\b|\b5 minutes\b/);
  });
});

describe("the code strings the approval path can emit", () => {
  const LEGACY = [
    "APPROVAL_ACK_PENDING", "APPROVAL_PENDING", "APPROVAL_REQUEST_CONTEXT_REQUIRED", "APPROVAL_REQUEST_EXPIRED",
    "APPROVAL_REQUEST_NOT_FOUND", "APPROVAL_REQUEST_UNAVAILABLE", "APPROVAL_RESULT_ACKNOWLEDGED", "APPROVAL_RESULT_EXPIRED",
    "APPROVAL_RESULT_INVALID", "APPROVAL_RESULT_NOT_FOUND", "APPROVAL_RESULT_UNAVAILABLE",
  ];

  test("snapshot: every string 1.6.x emitted keeps its spelling; the only additions are APPROVAL_DENIED, APPROVAL_CLOCK and APPROVAL_STATE_UNREADABLE", () => {
    expect([...APPROVAL_ERROR_CODES].sort()).toEqual([...LEGACY, "APPROVAL_CLOCK", "APPROVAL_DENIED", "APPROVAL_STATE_UNREADABLE"].sort());
  });

  test("the mapping emits only registered strings", () => {
    for (const { outcome, context } of rows) {
      const error = approvalOutcomeError(outcome, context);
      if (error) expect(APPROVAL_ERROR_CODES).toContain(error.code);
    }
  });
});

describe("the Next: line (TC-2360): only with exit 8, and last on stderr", () => {
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
  afterEach(() => { process.exitCode = undefined; });

  async function print(error: CLIError): Promise<{ stderr: string[]; stdout: string; exit: number }> {
    const written: string[] = [];
    const out: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write);
    const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as typeof process.exit);
    let exitCode = -1;
    try { await handleError(error); } catch (thrown) { if (thrown instanceof Exit) exitCode = thrown.code; else throw thrown; }
    finally { stderr.mockRestore(); stdout.mockRestore(); exit.mockRestore(); }
    return { stderr: written.join("").split("\n").filter((line) => line.length > 0), stdout: out.join(""), exit: exitCode };
  }

  test("exit 8 prints the pending JSON on stdout and the Next: line as the LAST line of stderr", async () => {
    const error = approvalOutcomeError({ kind: "pending", expiresAt: EXPIRES_AT, confirmedLiveAt: EXPIRES_AT - 1 }, open)!;
    const result = await print(error);
    expect(result.exit).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({ pending: { approvalUrl: LINK } });
    const pending = approvalPendingOf(error)!;
    expect(result.stderr.at(-1)).toBe(approvalNextLine(pending));
    expect(result.stderr.at(-1)).toMatch(/^Next: /);
  });

  test.each(rows.filter((row) => row.exit !== 8))("exit $exit ($name) prints no Next: line", async ({ outcome, context }) => {
    const error = approvalOutcomeError(outcome, context)!;
    const result = await print(error);
    expect(result.exit).toBe(error.exitCode);
    expect([...result.stderr, result.stdout].join("\n")).not.toMatch(/^\s*Next:/m);
  });
});
