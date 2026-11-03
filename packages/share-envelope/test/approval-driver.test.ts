import { describe, expect, test } from "bun:test";
import {
  APPROVAL_REQUEST_TIMEOUT_MS,
  driveApproval,
  type ApprovalDriverIo,
  type ApprovalEntry,
  type ApprovalPhase,
  type ApprovalVerdict,
  type CallResult,
  type Reply,
} from "../src/links/index.js";
import { E, RESULT_EXPIRES, RESULT_REF, SECRET_STRINGS, T0, entryIn, iso } from "./approval-machine-fixtures.js";

// TC-2377: the driver is the one loop that polls, sleeps, fetches, verifies, commits and acks. Everything it touches is
// injected: a fake clock, a recording store, a scripted OpenKey. No test sleeps or touches the network.

interface Timed {
  readonly reply: Reply;
  readonly ms?: number;
  readonly skew?: number;
}
type Scripted = Reply | Timed;
interface Script {
  /** The scripted answer for the n-th call (per call kind); the fake clock advances by `ms` while it is "in flight". */
  readonly discover?: readonly Scripted[];
  readonly fetch?: readonly Scripted[];
  readonly ack?: readonly Scripted[];
  readonly verdict?: ApprovalVerdict;
  readonly commitRetainUntil?: number;
  readonly startAt?: number;
}

function harness(initial: ApprovalEntry | undefined, script: Script = {}) {
  let t = script.startAt ?? T0 + 1_000;
  const log: string[] = [];
  const timeouts: { call: string; timeoutMs: number | undefined }[] = [];
  let stored = initial;
  const counts = { discover: 0, fetch: 0, ack: 0 };
  const call = (kind: "discover" | "fetch" | "ack") => async (_entry: ApprovalEntry, options: { timeoutMs?: number }): Promise<CallResult> => {
    log.push(`call:${kind}`);
    timeouts.push({ call: kind, timeoutMs: options.timeoutMs });
    const queue = script[kind] ?? [];
    const item = queue[Math.min(counts[kind]++, queue.length - 1)];
    if (item === undefined) throw new Error(`no scripted ${kind}`);
    const scripted: Timed = "reply" in item ? item : { reply: item };
    t += scripted.ms ?? 50;
    return { reply: scripted.reply, ...(scripted.skew === undefined ? {} : { serverDateSkewMs: scripted.skew }) };
  };
  const io: ApprovalDriverIo = {
    store: {
      read: async () => stored,
      write: async (entry) => { log.push(`write:${entry.phase}${entry.hold ? ":hold" : ""}${entry.keys?.stagedSigningKey ? ":staged" : ""}`); stored = entry; },
      remove: async () => { log.push("remove"); stored = undefined; },
    },
    transport: { discover: call("discover"), fetch: call("fetch"), ack: call("ack") },
    verify: async () => { log.push("verify"); return script.verdict ?? "ok"; },
    commit: async () => { log.push("commit"); return script.commitRetainUntil === undefined ? undefined : { retainUntil: script.commitRetainUntil }; },
    now: () => t,
    sleep: async (ms) => { log.push(`sleep:${ms}`); t += ms; },
  };
  return { io, log, timeouts, stored: () => stored, now: () => t };
}

const approvedFlow: Script = {
  discover: [{ kind: "pending" }, { kind: "pending" }, { kind: "ready", resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }],
  fetch: [{ kind: "envelope", envelope: { relay: "opaque" } }],
  ack: [{ kind: "acked" }],
};

describe("a full approval", () => {
  test("polls, fetches, verifies, commits and acks; every state change is durable BEFORE the next call", async () => {
    const h = harness(entryIn("open", { staged: true }), approvedFlow);
    const result = await driveApproval(h.io, entryIn("open").requestId);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.exitCode).toBe(0);
    expect(h.stored()).toBeUndefined();
    expect(h.log).toEqual([
      "call:discover", "sleep:2000", "call:discover", "sleep:2000", "call:discover",
      "write:discovered:staged", "call:fetch",
      "write:fetched:staged", "verify", "commit",
      "write:committed", "call:ack",
      "remove",
    ]);
  });

  test("the first check gets the full request limit, later polls are bounded by the deadline", async () => {
    const start = T0 + 1_000;
    const h = harness(entryIn("open"), { ...approvedFlow, startAt: start });
    await driveApproval(h.io, entryIn("open").requestId, { deadline: start + 5_000 });
    const discovers = h.timeouts.filter((entry) => entry.call === "discover");
    expect(discovers[0]!.timeoutMs).toBe(APPROVAL_REQUEST_TIMEOUT_MS);
    expect(discovers[1]!.timeoutMs).toBeLessThanOrEqual(APPROVAL_REQUEST_TIMEOUT_MS);
    expect(discovers[1]!.timeoutMs).toBeGreaterThanOrEqual(1_000);
  });

  test("resumes from a persisted `fetched` entry: verifies and commits without polling", async () => {
    const h = harness(entryIn("fetched"), { ack: [{ kind: "acked" }] });
    const result = await driveApproval(h.io, entryIn("fetched").requestId);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(h.log).toEqual(["verify", "commit", "write:committed", "call:ack", "remove"]);
  });

  test("resumes from `committed`: only the ack remains", async () => {
    const h = harness(entryIn("committed"), { ack: [{ kind: "acked" }] });
    expect((await driveApproval(h.io, entryIn("committed").requestId)).exitCode).toBe(0);
    expect(h.log).toEqual(["call:ack", "remove"]);
  });

  test("a command entry (commit returns retainUntil) is kept key-free after its ack", async () => {
    const h = harness(entryIn("fetched", { staged: true }), { ack: [{ kind: "acked" }], commitRetainUntil: E + 3_600_000 });
    const result = await driveApproval(h.io, entryIn("fetched").requestId);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(h.stored()!.phase).toBe("acked");
    expect(h.stored()!.keys).toBeUndefined();
    expect(h.stored()!.retainUntil).toBe(iso(E + 3_600_000));
  });

  test("an ack that cannot be sent is exit 0 with a warning and the committed entry kept for the next run", async () => {
    const h = harness(entryIn("committed"), { ack: [{ kind: "network" }] });
    const result = await driveApproval(h.io, entryIn("committed").requestId);
    expect(result).toMatchObject({ outcome: { kind: "completed", warning: "ack-pending" }, exitCode: 0 });
    expect(h.stored()!.phase).toBe("committed");
  });
});

describe("terminal answers drop the entry and its keys", () => {
  test("denied: removed, exit 11, no further call", async () => {
    const h = harness(entryIn("open", { staged: true }), { discover: [{ kind: "error", call: "discover", status: 410, code: "request_denied" }] });
    const result = await driveApproval(h.io, entryIn("open").requestId);
    expect(result).toMatchObject({ outcome: { kind: "denied" }, exitCode: 11 });
    expect(h.stored()).toBeUndefined();
    expect(h.log).toEqual(["call:discover", "remove"]);
  });

  test("a verdict `refused` drops the fetched result", async () => {
    const h = harness(entryIn("fetched", { staged: true }), { verdict: "refused" });
    expect(await driveApproval(h.io, entryIn("fetched").requestId)).toMatchObject({ exitCode: 5 });
    expect(h.stored()).toBeUndefined();
  });

  test("a verdict `clock` keeps the entry held, exit 12; the next run retries it", async () => {
    const first = harness(entryIn("fetched"), { verdict: "clock" });
    const held = await driveApproval(first.io, entryIn("fetched").requestId);
    expect(held.exitCode).toBe(12);
    expect(first.stored()!.hold).toBeDefined();
    expect(first.log).toEqual(["verify", "write:fetched:hold"]);
    const second = harness(first.stored(), { verdict: "ok", ack: [{ kind: "acked" }] });
    expect((await driveApproval(second.io, entryIn("fetched").requestId)).exitCode).toBe(0);
    expect(second.log[0]).toBe("write:fetched");
  });

  test("a missing entry is an internal outcome, not an exception", async () => {
    const h = harness(undefined);
    expect(await driveApproval(h.io, "abcdefghijklmnopqrstuvwxyz")).toMatchObject({ outcome: { kind: "internal" }, exitCode: 7 });
  });
});

describe("FIRST-CHECK GUARANTEE: the first discover of a run gets the full request limit and a real answer", () => {
  test("a slow (1.5 s) answer that arrives after a 1 s deadline, approved, is a success", async () => {
    const start = T0 + 1_000;
    const h = harness(entryIn("open"), {
      startAt: start,
      discover: [{ reply: { kind: "ready", resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }, ms: 1_500 }],
      fetch: [{ kind: "envelope", envelope: { relay: "opaque" } }],
      ack: [{ kind: "acked" }],
    });
    const result = await driveApproval(h.io, entryIn("open").requestId, { deadline: start + 1_000 });
    expect(result.outcome).toEqual({ kind: "completed" });
  });

  test("a slow (1.5 s) pending answer past a 1 s deadline is pending right after that check, with expiry and liveness", async () => {
    const start = T0 + 1_000;
    const h = harness(entryIn("open"), { startAt: start, discover: [{ reply: { kind: "pending" }, ms: 1_500 }] });
    const result = await driveApproval(h.io, entryIn("open").requestId, { deadline: start + 1_000 });
    expect(result.outcome).toEqual({ kind: "pending", expiresAt: E, confirmedLiveAt: start + 1_500 });
    expect(result.exitCode).toBe(8);
    expect(h.log).toEqual(["call:discover"]);
    expect(h.stored()).toBeDefined();
  });

  test("a first check that never answers fails at the request limit as unreachable (exit 6), NOT pending", async () => {
    const start = T0 + 1_000;
    const h = harness(entryIn("open"), { startAt: start, discover: [{ reply: { kind: "network" }, ms: APPROVAL_REQUEST_TIMEOUT_MS }] });
    const result = await driveApproval(h.io, entryIn("open").requestId, { deadline: start + 1_000 });
    expect(result.outcome).toMatchObject({ kind: "unreachable", expiresAt: E });
    expect(result.exitCode).toBe(6);
    expect(h.now()).toBe(start + APPROVAL_REQUEST_TIMEOUT_MS);
    expect(h.log).toEqual(["call:discover"]);
  });
});

describe("bounded waits", () => {
  test("without a caller deadline the run still ends: lapsed at E + S through the final poll", async () => {
    const h = harness(entryIn("open"), { discover: [{ kind: "pending" }, { kind: "error", call: "discover", status: 410, code: "expired_request" }], startAt: E + 29_000 });
    const result = await driveApproval(h.io, entryIn("open").requestId);
    expect(result.outcome).toMatchObject({ kind: "lapsed", reason: "expired_request" });
    expect(h.stored()).toBeUndefined();
  });

  test("an approval collected after the deadline gets the 30 s collect grace, then stops unreachable (never 8)", async () => {
    const start = T0 + 1_000;
    const h = harness(entryIn("discovered"), { startAt: start, fetch: [{ reply: { kind: "network" }, ms: 5_000 }] });
    const result = await driveApproval(h.io, entryIn("discovered").requestId, { deadline: start });
    expect(result.outcome.kind).toBe("unreachable");
    expect(result.exitCode).toBe(6);
    expect(h.stored()!.phase).toBe("discovered");
    expect(h.now()).toBeLessThanOrEqual(start + 30_000 + 5_000 + 2_000);
  });

  test("a clock more than 60 s off on a 401 holds the entry (12); the same 401 after E + S lapses it (3)", async () => {
    const early = harness(entryIn("open", { staged: true }), { discover: [{ reply: { kind: "error", call: "discover", status: 401, code: "invalid_proof" }, skew: 120_000 }] });
    expect((await driveApproval(early.io, entryIn("open").requestId)).exitCode).toBe(12);
    expect(early.stored()!.hold).toBeDefined();
    const late = harness(early.stored(), { startAt: E + 31_000, discover: [{ reply: { kind: "error", call: "discover", status: 401, code: "invalid_proof" }, skew: 120_000 }] });
    expect((await driveApproval(late.io, entryIn("open").requestId)).exitCode).toBe(3);
    expect(late.stored()).toBeUndefined();
  });
});

describe("the driver never leaks a key", () => {
  test("the result and the log of a dropped run carry no private key", async () => {
    const h = harness(entryIn("open", { staged: true }), { discover: [{ kind: "error", call: "discover", status: 410, code: "request_denied" }] });
    const result = await driveApproval(h.io, entryIn("open").requestId);
    const text = JSON.stringify({ result: { outcome: result.outcome, exitCode: result.exitCode, kept: result.entry !== undefined }, log: h.log });
    for (const secret of SECRET_STRINGS) expect(text).not.toContain(secret);
    expect(result.entry).toBeUndefined();
  });

  test("a throwing verify surfaces its error and leaves the persisted entry as it was", async () => {
    const h = harness(entryIn("fetched"));
    h.io.verify = async () => { throw new Error("verification failed"); };
    await expect(driveApproval(h.io, entryIn("fetched").requestId)).rejects.toThrow("verification failed");
    expect(h.stored()!.phase).toBe("fetched");
  });
});

test("fixture phases", () => {
  const phases: ApprovalPhase[] = ["open", "discovered", "fetched", "committed", "acked"];
  expect(phases.map((phase) => entryIn(phase).phase)).toEqual(phases);
});
