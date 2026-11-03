import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ApprovalEntry } from "@tinycloud/share-envelope/links";
import type { AuthFlowOptions } from "./browser-auth.js";
import { createApprovalFixture, SYNTHETIC_ACK_ID, type OpenKeyAction, type OpenKeyOverride } from "./test-support/approval-fixture.js";

// TC-2377 PR-B: the CLI's approval request runs on the share-envelope requester machine (`driveApproval`) with a file adapter.
// These tests drive `acquireApprovalRequest` / `completeApprovalResult` against a signed local OpenKey with a virtual clock and
// pin the CLI rows of spec 5a: the exit number, the code string, and what happens to the saved request and its keys.

const fx = await createApprovalFixture("TC2377-approval-machine");
const { acquireApprovalRequest, completeApprovalResult, pendingApprovalKey, dropApprovalsHoldingKey, approvalHoldsKey, dropRefusedApproval } = await import("./approval-request.js");
const { isMaybeGranted } = await import("./refusal.js");
const { CLIError } = fx;

beforeEach(() => fx.enter());
afterEach(() => fx.leave());
afterAll(() => fx.dispose());

const json = (status: number, body: unknown) => Response.json(body, { status });
const acquire = (options: AuthFlowOptions) => acquireApprovalRequest(fx.did, options);
const COMMAND_A = `auth-grant:${"aa".repeat(32)}`;
const COMMAND_B = `auth-grant:${"bb".repeat(32)}`;

async function seed(entries: ApprovalEntry[]): Promise<void> {
  await fx.writeState({ version: 2, entries, unrecognized: [] });
}
const diskText = async () => await readFile(fx.pendingPath(), "utf8").catch(() => "");
const savedEntries = async (): Promise<ApprovalEntry[]> => (await diskText()) === "" ? [] : await fx.entries();

/** Everything the CLI wrote while `run` ran, in order, and what it threw. */
async function capture<T>(run: () => Promise<T>): Promise<{ output: string[]; error?: unknown; value?: T }> {
  const output: string[] = [];
  const record = (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); };
  const errors = spyOn(console, "error").mockImplementation(record);
  const logs = spyOn(console, "log").mockImplementation(record);
  const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { record(chunk); return true; }) as typeof process.stderr.write);
  const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { record(chunk); return true; }) as typeof process.stdout.write);
  try { return { output, value: await run() }; } catch (error) { return { output, error }; }
  finally { errors.mockRestore(); logs.mockRestore(); stderr.mockRestore(); stdout.mockRestore(); }
}
const lastLine = (output: string[]) => output.join("\n").split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0).at(-1);

// ---------------------------------------------------------------------------------------------------------------------
describe("every OpenKey answer ends the run with its row of the exit table, and the saved request is kept or dropped as the machine says", () => {
  interface Row {
    readonly name: string;
    readonly phase: "open" | "discovered";
    readonly override?: OpenKeyOverride;
    readonly network?: (action: OpenKeyAction) => boolean;
    readonly skewMs?: number;
    /** Open requests only: how long the request lives from now, and how far the clock moves before the run. */
    readonly lifeMs?: number;
    readonly advanceMs?: number;
    readonly deadlineMs?: number;
    readonly code: string;
    readonly exit: number;
    readonly fate: "dropped" | "kept";
    readonly says?: RegExp;
    readonly never?: RegExp;
    readonly maybeGranted?: boolean;
  }
  const onDiscover = (reply: () => Response): OpenKeyOverride => (action) => action === "discover" ? reply() : undefined;
  const onFetch = (reply: () => Response): OpenKeyOverride => (action) => action === "fetch" ? reply() : undefined;
  const rows: Row[] = [
    { name: "410 expired_request (lapsed)", phase: "open", override: onDiscover(() => json(410, { error: "Approval request expired. Start a new request.", code: "expired_request" })),
      code: "APPROVAL_REQUEST_EXPIRED", exit: 3, fate: "dropped" },
    { name: "410 expired_request + status denied (the owner declined)", phase: "open",
      override: onDiscover(() => json(410, { error: "Approval request was declined by the owner. Start a new request.", code: "expired_request", status: "denied", deniedAt: new Date().toISOString() })),
      code: "APPROVAL_DENIED", exit: 11, fate: "dropped", says: /declined/, never: /expired/i },
    { name: "404 not_found", phase: "open", override: onDiscover(() => json(404, { error: "not found", code: "not_found" })), code: "APPROVAL_REQUEST_NOT_FOUND", exit: 3, fate: "dropped" },
    { name: "400 invalid_request on a live request is a real header fault: refused, never expired", phase: "open",
      override: onDiscover(() => json(400, { error: "Signed approval request header is invalid", code: "invalid_request" })),
      code: "APPROVAL_RESULT_INVALID", exit: 5, fate: "dropped", never: /expired/i },
    { name: "400 invalid_request AFTER the request's own expiry is still a refusal (the old 'invalid or expired' workaround is gone)", phase: "open", lifeMs: 130_000, advanceMs: 200_000,
      override: onDiscover(() => json(400, { error: "Signed approval request header is invalid", code: "invalid_request" })),
      code: "APPROVAL_RESULT_INVALID", exit: 5, fate: "dropped", never: /expired/i },
    { name: "400 request_binding", phase: "open", override: onDiscover(() => json(400, { error: "binding", code: "request_binding" })),
      code: "APPROVAL_RESULT_INVALID", exit: 5, fate: "dropped", maybeGranted: true },
    { name: "401 invalid_proof with the local clock 2 minutes ahead of OpenKey's Date", phase: "open", skewMs: 120_000,
      override: onDiscover(() => json(401, { error: "Requester proof is invalid", code: "invalid_proof" })),
      code: "APPROVAL_CLOCK", exit: 12, fate: "kept", says: /ahead/i },
    { name: "401 invalid_proof with a sane clock is a refusal", phase: "open",
      override: onDiscover(() => json(401, { error: "Requester proof is invalid", code: "invalid_proof" })),
      code: "APPROVAL_RESULT_INVALID", exit: 5, fate: "dropped" },
    { name: "401 invalid_proof on a request past its life, seen through a skewed clock, is lapsed", phase: "open", lifeMs: 130_000, advanceMs: 200_000, skewMs: 120_000,
      override: onDiscover(() => json(401, { error: "Requester proof is invalid", code: "invalid_proof" })),
      code: "APPROVAL_REQUEST_EXPIRED", exit: 3, fate: "dropped" },
    { name: "5xx five times in a row", phase: "open", override: onDiscover(() => json(503, { error: "unavailable" })), deadlineMs: 30_000,
      code: "APPROVAL_REQUEST_UNAVAILABLE", exit: 7, fate: "kept", says: /Retry the command to resume/ },
    { name: "no answer at all to the first check of a resumed request (was exit 8: OpenKey was never reached)", phase: "open", network: () => true, deadlineMs: 10_000,
      code: "APPROVAL_REQUEST_UNAVAILABLE", exit: 6, fate: "kept", says: /Retry the command to resume/, never: /Still waiting/ },
    { name: "202 until the deadline: OpenKey confirmed the request live, so exit 8", phase: "open", override: onDiscover(() => json(202, { status: "pending" })), deadlineMs: 10_000,
      code: "APPROVAL_PENDING", exit: 8, fate: "kept" },
    { name: "fetch 409 acknowledged (was exit 8 and kept: a result nobody can fetch again)", phase: "discovered", override: onFetch(() => json(409, { error: "acknowledged", code: "acknowledged" })),
      code: "APPROVAL_RESULT_ACKNOWLEDGED", exit: 3, fate: "dropped" },
    { name: "fetch 404 not_found", phase: "discovered", override: onFetch(() => json(404, { error: "not found", code: "not_found" })),
      code: "APPROVAL_RESULT_NOT_FOUND", exit: 3, fate: "dropped" },
    { name: "fetch 410 expired_result", phase: "discovered", override: onFetch(() => json(410, { error: "expired", code: "expired_result" })),
      code: "APPROVAL_RESULT_EXPIRED", exit: 3, fate: "dropped" },
    { name: "fetch 400 request_binding", phase: "discovered", override: onFetch(() => json(400, { error: "binding", code: "request_binding" })),
      code: "APPROVAL_RESULT_INVALID", exit: 5, fate: "dropped" },
    { name: "fetch 5xx for the whole collect window: the approved result stays saved by reference (exit 7, was 8)", phase: "discovered", override: onFetch(() => json(500, { error: "boom" })), deadlineMs: 10_000,
      code: "APPROVAL_RESULT_UNAVAILABLE", exit: 7, fate: "kept" },
    { name: "fetch unreachable for the whole collect window: exit 6, never 8 for an approved request", phase: "discovered", network: (action) => action === "fetch", deadlineMs: 10_000,
      code: "APPROVAL_RESULT_UNAVAILABLE", exit: 6, fate: "kept", never: /Still waiting/ },
  ];

  test.each(rows)("$name -> $code, exit $exit, request $fate", async (row) => {
    const built = await fx.buildRequest({ expiresInMs: row.lifeMs ?? 3600_000 });
    // The staged key makes the entry hold the session key too (a first sign-in), so a leak of either key would show.
    const entry = await fx.v2Entry(built, { phase: row.phase, stagedKey: fx.key });
    await seed([entry]);
    fx.clock += row.advanceMs ?? 0;
    fx.skewMs = row.skewMs ?? 0;
    fx.override = row.override;
    if (row.network) fx.networkFault = (url) => row.network!(url.pathname.endsWith("/result") ? "discover" : url.pathname.endsWith("/fetch") ? "fetch" : "ack");

    const result = await capture(() => acquire(row.deadlineMs === undefined ? fx.options() : fx.withDeadline(row.deadlineMs)));
    const error = result.error;
    expect(error).toBeInstanceOf(CLIError);
    if (!(error instanceof CLIError)) return;
    expect(error.code).toBe(row.code);
    expect(error.exitCode).toBe(row.exit);
    if (row.says) expect(error.message).toMatch(row.says);
    if (row.never) expect(error.message).not.toMatch(row.never);
    if (row.maybeGranted) expect(isMaybeGranted(error)).toBe(true);
    if (row.exit === 8) expect(error.metadata).toEqual({ pending: { step: 1, of: 1, approvalUrl: entry.approvalUrl, expiresAt: entry.record.header.expiresAt } });

    // The request and its keys: gone from disk when dropped; whole, with both keys, when kept.
    const text = await diskText();
    if (row.fate === "dropped") {
      expect(text).not.toContain(entry.requestId);
      expect(text).not.toContain(built.relayPrivateKey);
      expect(text).not.toContain(fx.key.d);
    } else {
      const [kept] = await savedEntries();
      expect(kept!.requestId).toBe(entry.requestId);
      expect(kept!.keys).toEqual(entry.keys);
    }
    // No key reaches an error, its metadata, or anything printed.
    const everything = [error.message, JSON.stringify(error.metadata ?? {}), ...result.output].join("\n");
    expect(everything).not.toContain(fx.key.d);
    expect(everything).not.toContain(built.relayPrivateKey);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a request created in this run", () => {
  test("is saved (version 2, both keys, the signed expiry) BEFORE its link is offered, and --timeout returns it at once as exit 8", async () => {
    let savedWhenOffered: ApprovalEntry | undefined;
    const options = fx.withDeadline(60_000, { step: 2, of: 3 });
    options.onApprovalRequest = ({ approvalUrl }) => {
      fx.offered.push(approvalUrl);
      const state = JSON.parse(readFileSync(fx.pendingPath(), "utf8"));
      savedWhenOffered = state.entries.find((entry: ApprovalEntry) => entry.approvalUrl === approvalUrl);
    };
    const error = await fx.caught(() => acquire(options));

    expect(error.code).toBe("APPROVAL_PENDING");
    expect(error.exitCode).toBe(8);
    expect(savedWhenOffered).toBeDefined();
    const [saved] = await fx.entries();
    expect(saved).toEqual(savedWhenOffered!);
    expect(saved!.phase).toBe("open");
    expect(saved!.keys!.relayPrivateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved!.ext).toMatchObject({ cli: { expectedOwner: fx.ownerDid } });
    expect(saved).not.toHaveProperty("requestExpiresAt");
    expect(error.metadata).toEqual({ pending: { step: 2, of: 3, approvalUrl: saved!.approvalUrl, expiresAt: saved!.record.header.expiresAt } });
    expect(fx.counters.discover).toBe(0);
    expect(fx.sleeps).toEqual([]);
    expect(fx.counters.linkPosts).toBe(1);
  });

  test("with no --timeout the run ends by the request's own expiry (+30 s) after one last poll; it never polls forever", async () => {
    const entry = await fx.v2Entry(await fx.buildRequest({ expiresInMs: 600_000 }));
    await seed([entry]);
    fx.override = (action) => action === "discover" ? json(202, { status: "pending" }) : undefined;

    const start = fx.clock;
    const error = await fx.caught(() => acquire(fx.options()));
    const expiry = Date.parse(entry.record.header.expiresAt);
    expect(fx.clock).toBeLessThanOrEqual(expiry + 30_000 + 2_000);
    expect(fx.clock).toBeGreaterThanOrEqual(expiry + 30_000);
    expect(fx.calls.at(-1)!.at).toBeGreaterThanOrEqual(expiry + 30_000);
    expect(fx.calls.length).toBeLessThan((expiry + 32_000 - start) / 2_000 + 3);
    // OpenKey still serves a request the clock says has ended, and the clocks agree: an unexpected answer (7), the entry kept until its purge time.
    expect(error.exitCode).toBe(7);
    expect((await fx.entries())[0]!.requestId).toBe(entry.requestId);
  });

  test("with the CLI's own printing, the link goes to stderr after it is saved and that print ends with the Next: line", async () => {
    fx.override = async (action) => { if (action === "discover" && fx.results.size === 0) await fx.approve(); return undefined; };
    const options = { ...fx.options(), onApprovalRequest: undefined };
    const result = await capture(() => acquire(options));

    expect(result.error).toBeUndefined();
    const [saved] = await fx.entries();
    const printed = result.output.join("\n").split("\n");
    const linkAt = printed.findIndex((line) => line.includes(saved!.approvalUrl!));
    expect(linkAt).toBeGreaterThanOrEqual(0);
    expect(lastLine(result.output)).toMatch(/^Next: /);
    expect(printed.lastIndexOf(lastLine(result.output)!)).toBeGreaterThan(linkAt);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("resume after a kill: the file alone is enough", () => {
  test.each(["open", "discovered", "fetched"] as const)("an entry left at %s: no new request, the same approval, exactly one ack, nothing left on disk", async (phase) => {
    const built = await fx.buildRequest();
    let delegation = await fx.signedDelegation();
    const entry = await fx.v2Entry(built, { phase, delegation });
    await seed([entry]);
    if (phase === "open") delegation = (await fx.approve(entry)).delegation;
    else await fx.offerResult(entry, delegation);

    const got = await acquire(fx.options());
    expect(got.delegationCid).toBe(fx.cidOf(delegation));
    expect(fx.counters.linkPosts).toBe(0);
    expect(fx.acks).toEqual([]);
    // The grant is returned with its result saved by reference and envelope: a kill here loses nothing.
    expect((await fx.entries())[0]).toMatchObject({ phase: "fetched", requestId: entry.requestId });

    await fx.commitAndAcknowledge(got, completeApprovalResult);
    expect(fx.acks).toEqual([{ ackId: SYNTHETIC_ACK_ID, resultRef: expect.any(String) }]);
    expect(await savedEntries()).toEqual([]);
    const text = await diskText();
    expect(text).not.toContain(built.relayPrivateKey);
  });

  test("an entry left committed (the grant is saved, the ack never ran): the next completion acknowledges it once and removes it", async () => {
    const built = await fx.buildRequest();
    const delegation = await fx.signedDelegation();
    const entry = await fx.v2Entry(built, { phase: "committed", delegation });
    await seed([entry]);
    await fx.offerResult(entry, delegation);
    await fx.commitOnly(delegation);

    await completeApprovalResult("approval");
    expect(fx.acks).toEqual([{ ackId: SYNTHETIC_ACK_ID, resultRef: entry.resultRef! }]);
    expect(await savedEntries()).toEqual([]);
    expect(await diskText()).not.toContain(built.relayPrivateKey);
  });

  test("killed after the result was found: the file says discovered with its reference, and the next run fetches without polling again", async () => {
    const entry = await fx.v2Entry(await fx.buildRequest());
    await seed([entry]);
    const { delegation } = await fx.approve(entry);
    fx.override = (action) => action === "fetch" ? json(500, { error: "boom" }) : undefined;
    fx.onTick = () => { throw new Error("killed"); };

    const killed = await capture(() => acquire(fx.options()));
    expect(String(killed.error)).toContain("killed");
    const [saved] = await fx.entries();
    expect(saved).toMatchObject({ phase: "discovered", requestId: entry.requestId });
    expect(saved!.resultRef).toEqual(expect.any(String));
    expect(saved!.keys!.relayPrivateKey).toBe(entry.keys!.relayPrivateKey);

    fx.override = undefined;
    fx.onTick = () => undefined;
    const discovers = fx.counters.discover;
    const got = await acquire(fx.options());
    expect(fx.counters.discover).toBe(discovers);
    expect(got.delegationCid).toBe(fx.cidOf(delegation));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("several saved requests of one profile (command intents)", () => {
  test("a command acquires its own request only; every other saved request stays byte for byte", async () => {
    const [a, b] = [await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_A }), await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_B })];
    await seed([a, b]);
    const { delegation } = await fx.approve(a);

    const got = await acquire(fx.options(undefined, { commandIntent: COMMAND_A }));
    expect(got.delegationCid).toBe(fx.cidOf(delegation));
    const after = await fx.entries();
    expect(after.find((entry) => entry.requestId === b.requestId)).toEqual(b);
    expect(after.find((entry) => entry.requestId === a.requestId)).toMatchObject({ phase: "fetched" });
    expect(fx.calls.every((call) => call.path.includes(a.requestId) || !call.path.includes(b.requestId))).toBe(true);
    expect(fx.counters.linkPosts).toBe(0);
  });

  test("a command with no saved request of its own makes a new one and leaves the others alone", async () => {
    const [a, b] = [await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_A }), await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_B })];
    await seed([a, b]);
    const error = await fx.caught(() => acquire(fx.withDeadline(30_000)));
    expect(error.code).toBe("APPROVAL_PENDING");
    expect(fx.counters.linkPosts).toBe(1);
    const after = await fx.entries();
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual([a, b]);
  });

  test("two saved requests that both match one command are refused before OpenKey is asked: no result is picked for it", async () => {
    const [first, second] = [await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_A }), await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_A })];
    await seed([first, second]);
    const error = await fx.caught(() => acquire(fx.options(undefined, { commandIntent: COMMAND_A })));
    expect(error.code).toBe("APPROVAL_RESULT_INVALID");
    expect(error.message).toMatch(/Multiple approvals match/);
    expect(fx.openkeyCalls).toBe(0);
    expect(fx.counters.linkPosts).toBe(0);
    expect(await fx.entries()).toEqual([first, second]);
  });

  test("a completed command (acknowledged, key-free) still returns its approval from the parent kept beside the saved child: no OpenKey call, no new request, and the entry is untouched", async () => {
    const { entry, delegation } = await fx.ackedCommandEntry(await fx.buildRequest(), { commandIntent: COMMAND_A });
    await seed([entry]);
    const before = await diskText();

    const got = await acquire(fx.options(undefined, { commandIntent: COMMAND_A }));
    expect(got.delegationCid).toBe(fx.cidOf(delegation));
    expect(fx.openkeyCalls).toBe(0);
    expect(fx.counters.linkPosts).toBe(0);
    expect(fx.offered).toEqual([]);
    expect(await diskText()).toBe(before);
    expect(before).not.toMatch(/"keys"|"relayPrivateKey"|"approvalUrl"/);
    // The completion has nothing to acknowledge for it.
    await completeApprovalResult("approval", got);
    expect(fx.acks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the grant is saved, only the acknowledgement is outstanding (grantSaved)", () => {
  async function committed() {
    const built = await fx.buildRequest();
    const delegation = await fx.signedDelegation();
    const entry = await fx.v2Entry(built, { phase: "committed", delegation });
    await seed([entry]);
    await fx.offerResult(entry, delegation);
    await fx.commitOnly(delegation);
    return { built, entry, delegation };
  }

  test("a refused ack (401) with a sane clock: exit 7, the message says the profile already holds the grant, the profile does hold it and the entry stays committed", async () => {
    const { entry } = await committed();
    fx.override = (action) => action === "ack" ? json(401, { error: "Requester proof is invalid", code: "invalid_proof" }) : undefined;
    const error = await fx.caught(() => completeApprovalResult("approval"));
    expect(error.exitCode).toBe(7);
    expect(error.code).toBe("APPROVAL_ACK_PENDING");
    expect(error.message).toMatch(/profile already holds the grant/i);
    expect(error.message).not.toMatch(/sign in again|not signed in/i);
    expect(await fx.ProfileManager.getSession("approval")).not.toBeNull();
    expect((await fx.entries())[0]).toMatchObject({ requestId: entry.requestId, phase: "committed" });
  });

  test("the same refusal with the clock 2 minutes off: exit 12, and the message still says the grant is saved", async () => {
    await committed();
    fx.skewMs = 120_000;
    fx.override = (action) => action === "ack" ? json(401, { error: "Requester proof is invalid", code: "invalid_proof" }) : undefined;
    const error = await fx.caught(() => completeApprovalResult("approval"));
    expect(error.exitCode).toBe(12);
    expect(error.code).toBe("APPROVAL_CLOCK");
    expect(error.message).toMatch(/profile already holds the grant/i);
    expect((await fx.entries())[0]).toMatchObject({ phase: "committed" });
  });

  test("an ack that cannot be sent is a warning and exit 0 (was exit 8): the grant is saved, and the next completion sends the same ack id", async () => {
    const { entry } = await committed();
    fx.networkFault = (url) => url.pathname.endsWith("/ack");
    const attempt = await capture(() => completeApprovalResult("approval"));
    expect(attempt.error).toBeUndefined();
    expect(attempt.output.join("\n")).toMatch(/acknowledg/i);
    expect((await fx.entries())[0]).toMatchObject({ requestId: entry.requestId, phase: "committed" });

    fx.networkFault = () => false;
    await completeApprovalResult("approval");
    expect(fx.acks).toEqual([{ ackId: SYNTHETIC_ACK_ID, resultRef: entry.resultRef! }]);
    expect(await savedEntries()).toEqual([]);
  });

  test("an ack OpenKey answers with 409 ack_conflict completes with a warning and drops the entry (the CLI no longer loops on it)", async () => {
    await committed();
    fx.override = (action) => action === "ack" ? json(409, { error: "conflict", code: "ack_conflict" }) : undefined;
    const attempt = await capture(() => completeApprovalResult("approval"));
    expect(attempt.error).toBeUndefined();
    expect(await savedEntries()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the #830 key helpers read and change the version 2 file", () => {
  test("approvalHoldsKey and pendingApprovalKey see a staged signing key; a committed or command entry's key is not offered", async () => {
    const staged = await fx.v2Entry(await fx.buildRequest(), { stagedKey: fx.key });
    const plain = await fx.v2Entry(await fx.buildRequest());
    // The first request that is neither a command's nor committed is the one `auth login` resumes (as in 1.6.x): the staged key comes first here.
    await seed([staged, plain]);
    expect(await approvalHoldsKey("approval", fx.key.x)).toBe(true);
    expect(await approvalHoldsKey("approval", "some-other-x")).toBe(false);
    expect(await pendingApprovalKey("approval")).toEqual(fx.key);

    await seed([await fx.v2Entry(await fx.buildRequest(), { stagedKey: fx.key, commandIntent: COMMAND_A })]);
    expect(await pendingApprovalKey("approval")).toBeUndefined();
  });

  test("dropApprovalsHoldingKey removes only the requests holding that key, with the keys: an open one says no grant is known", async () => {
    const holding = await fx.buildRequest();
    const other = await fx.buildRequest();
    await seed([await fx.v2Entry(holding, { stagedKey: fx.key }), await fx.v2Entry(other)]);

    expect(await dropApprovalsHoldingKey("approval", fx.key.x)).toEqual({ dropped: true, approved: false });
    const text = await diskText();
    expect(text).not.toContain(holding.relayPrivateKey);
    expect(text).not.toContain(fx.key.d);
    expect((await fx.entries()).map((entry) => entry.requestId)).toEqual([other.requestId]);
    expect(text).toContain(other.relayPrivateKey);
  });

  test("dropApprovalsHoldingKey on a request the owner already approved reports the latest the grant can end: its expiry plus the lifetime asked", async () => {
    const built = await fx.buildRequest({ grantLifetimeSeconds: 7200 });
    await seed([await fx.v2Entry(built, { phase: "discovered", stagedKey: fx.key })]);
    const swept = await dropApprovalsHoldingKey("approval", fx.key.x);
    expect(swept).toEqual({ dropped: true, approved: true, latestEnd: new Date(Date.parse(built.record.header.expiresAt) + 7200 * 1000).toISOString() });
    expect(await diskText()).not.toContain(fx.key.d);
  });

  test("dropApprovalsHoldingKey for a key nothing holds changes nothing", async () => {
    await seed([await fx.v2Entry(await fx.buildRequest())]);
    const before = await diskText();
    expect(await dropApprovalsHoldingKey("approval", fx.key.x)).toEqual({ dropped: false, approved: false });
    expect(await diskText()).toBe(before);
  });

  test("dropRefusedApproval removes the request an acquired grant came from, with its keys, and leaves the others", async () => {
    const entry = await fx.v2Entry(await fx.buildRequest(), { stagedKey: fx.key });
    const other = await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_B });
    await seed([entry, other]);
    await fx.approve(entry);
    const got = await acquire(fx.options());
    await dropRefusedApproval("approval", got);
    expect((await fx.entries()).map((item) => item.requestId)).toEqual([other.requestId]);
    expect(await diskText()).not.toContain(fx.key.d);
  });
});
