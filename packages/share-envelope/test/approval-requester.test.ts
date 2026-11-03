import { describe, expect, test } from "bun:test";
import {
  approvalEntrySchema,
  CLOCK_DISAGREEMENT_MS,
  APPROVAL_EXIT,
  RULES,
  exitCodeOf,
  heldKeys,
  localExpiry,
  purgeAt,
  reduce,
  requesterState,
  type ApprovalEntry,
  type ApprovalPhase,
  type Effect,
  type Event,
  type Outcome,
  type Reply,
  type ReplyCode,
  type RequesterState,
  type Rule,
  type Step,
} from "../src/links/index.js";
import { CONTENT_KEY, E, PHASES, R, RELAY_KEY, REQUEST_ID, RESULT_EXPIRES, RESULT_REF, S, SECRET_STRINGS, T0, entryIn, iso, liveState } from "./approval-machine-fixtures.js";

// TC-2377: the ONE approval-request requester machine. These tests are the contract: every (event x phase) cell of the
// table is asserted against a SECOND, hand-written table below (never against `RULES`), so a wrong mapping in the
// implementation cannot also be the expected value. `reduce` is pure: time and clock skew arrive as event fields.

const NOW = T0 + 60_000;
const err = (call: "discover" | "fetch" | "ack", code: ReplyCode, status = 400): Reply => ({ kind: "error", call, status, code });
const replyEvent = (reply: Reply, now = NOW, serverDateSkewMs?: number): Event =>
  ({ type: "reply", now, reply, ...(serverDateSkewMs === undefined ? {} : { serverDateSkewMs }) });

/** What one cell of the table must produce. `exit` is the number of the outcome the step finishes with, if it finishes. */
type Cell =
  | "internal"
  | { readonly entry: "keep"; readonly phase?: ApprovalPhase; readonly next: Effect["type"]; readonly outcome?: Outcome["kind"]; readonly exit?: number; readonly hold?: true }
  | { readonly entry: "drop"; readonly outcome: Outcome["kind"]; readonly exit: number };

const go = (phase: ApprovalPhase, next: Effect["type"]): Cell => ({ entry: "keep", phase, next });
const stop = (outcome: Outcome["kind"], exit: number, extra: { hold?: true } = {}): Cell => ({ entry: "keep", next: "finish", outcome, exit, ...extra });
const drop = (outcome: Outcome["kind"], exit: number): Cell => ({ entry: "drop", outcome, exit });

interface Row {
  readonly name: string;
  readonly event: Event | ((state: RequesterState) => Event);
  /** Cells by phase; a phase that is not listed is an ILLEGAL pair and must stop with `internal`. */
  readonly expect: Partial<Record<ApprovalPhase, Cell>>;
}

const sleeping = go("open", "sleep");
const ROWS: readonly Row[] = [
  // replies that need no error code
  { name: "202 pending", event: replyEvent({ kind: "pending" }), expect: { open: sleeping } },
  { name: "200 approved", event: replyEvent({ kind: "ready", resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }), expect: { open: go("discovered", "call") } },
  { name: "200 envelope", event: replyEvent({ kind: "envelope", envelope: { relay: "opaque" } }), expect: { discovered: go("fetched", "verify") } },
  { name: "200 ack", event: replyEvent({ kind: "acked" }), expect: { committed: drop("completed", 0) } },
  { name: "malformed 200 (discover)", event: replyEvent({ kind: "malformed", call: "discover" }), expect: { open: sleeping } },
  { name: "malformed 200 (fetch)", event: replyEvent({ kind: "malformed", call: "fetch" }), expect: { discovered: go("discovered", "sleep") } },
  { name: "malformed 200 (ack)", event: replyEvent({ kind: "malformed", call: "ack" }), expect: { committed: stop("completed", 0) } },
  { name: "network", event: replyEvent({ kind: "network" }), expect: { open: sleeping, discovered: go("discovered", "sleep"), committed: stop("completed", 0) } },
  // discover
  { name: "discover 410 expired_request", event: replyEvent(err("discover", "expired_request", 410)), expect: { open: drop("lapsed", 3) } },
  { name: "discover 410 request_denied", event: replyEvent(err("discover", "request_denied", 410)), expect: { open: drop("denied", 11) } },
  { name: "discover 400 invalid_request", event: replyEvent(err("discover", "invalid_request")), expect: { open: drop("refused", 5) } },
  { name: "discover 404 not_found", event: replyEvent(err("discover", "not_found", 404)), expect: { open: drop("lapsed", 3) } },
  { name: "discover 410 expired_result", event: replyEvent(err("discover", "expired_result", 410)), expect: { open: drop("gone", 3) } },
  { name: "discover 400 request_binding", event: replyEvent(err("discover", "request_binding")), expect: { open: drop("refused", 5) } },
  { name: "discover 401 invalid_proof, clock sane (skew 0)", event: replyEvent(err("discover", "invalid_proof", 401), NOW, 0), expect: { open: drop("refused", 5) } },
  { name: "discover 401 invalid_proof, clock 90 s off", event: replyEvent(err("discover", "invalid_proof", 401), NOW, 90_000), expect: { open: stop("clock", 12, { hold: true }) } },
  { name: "discover 401 invalid_proof, no Date header", event: replyEvent(err("discover", "invalid_proof", 401)), expect: { open: drop("refused", 5) } },
  { name: "discover 409 acknowledged (unmapped)", event: replyEvent(err("discover", "acknowledged", 409)), expect: { open: sleeping } },
  { name: "discover ack_conflict (unmapped)", event: replyEvent(err("discover", "ack_conflict", 409)), expect: { open: sleeping } },
  { name: "discover invalid_ack (unmapped)", event: replyEvent(err("discover", "invalid_ack")), expect: { open: sleeping } },
  { name: "discover 502 unknown", event: replyEvent(err("discover", "unknown", 502)), expect: { open: sleeping } },
  // fetch
  { name: "fetch 404 not_found", event: replyEvent(err("fetch", "not_found", 404)), expect: { discovered: drop("gone", 3) } },
  { name: "fetch 410 expired_result", event: replyEvent(err("fetch", "expired_result", 410)), expect: { discovered: drop("gone", 3) } },
  { name: "fetch 409 acknowledged", event: replyEvent(err("fetch", "acknowledged", 409)), expect: { discovered: drop("gone", 3) } },
  { name: "fetch 400 request_binding", event: replyEvent(err("fetch", "request_binding")), expect: { discovered: drop("refused", 5) } },
  { name: "fetch 401 invalid_proof, clock sane", event: replyEvent(err("fetch", "invalid_proof", 401), NOW, 5_000), expect: { discovered: stop("unexpected", 7) } },
  { name: "fetch 401 invalid_proof, no Date header", event: replyEvent(err("fetch", "invalid_proof", 401)), expect: { discovered: stop("unexpected", 7) } },
  { name: "fetch 401 invalid_proof, clock 90 s off", event: replyEvent(err("fetch", "invalid_proof", 401), NOW, -90_000), expect: { discovered: stop("clock", 12, { hold: true }) } },
  { name: "fetch 410 expired_request (unmapped)", event: replyEvent(err("fetch", "expired_request", 410)), expect: { discovered: go("discovered", "sleep") } },
  { name: "fetch 400 invalid_request (unmapped)", event: replyEvent(err("fetch", "invalid_request")), expect: { discovered: go("discovered", "sleep") } },
  { name: "fetch 500 unknown", event: replyEvent(err("fetch", "unknown", 500)), expect: { discovered: go("discovered", "sleep") } },
  // ack
  { name: "ack 404 not_found", event: replyEvent(err("ack", "not_found", 404)), expect: { committed: drop("completed", 0) } },
  { name: "ack 409 acknowledged", event: replyEvent(err("ack", "acknowledged", 409)), expect: { committed: drop("completed", 0) } },
  { name: "ack 410 expired_result", event: replyEvent(err("ack", "expired_result", 410)), expect: { committed: drop("completed", 0) } },
  { name: "ack 409 ack_conflict", event: replyEvent(err("ack", "ack_conflict", 409)), expect: { committed: drop("completed", 0) } },
  { name: "ack 400 invalid_ack", event: replyEvent(err("ack", "invalid_ack")), expect: { committed: stop("completed", 0) } },
  { name: "ack 401 invalid_proof, clock 90 s off", event: replyEvent(err("ack", "invalid_proof", 401), NOW, 90_000), expect: { committed: stop("clock", 12, { hold: true }) } },
  { name: "ack 401 invalid_proof, clock sane", event: replyEvent(err("ack", "invalid_proof", 401), NOW, 1_000), expect: { committed: stop("unexpected", 7) } },
  { name: "ack 400 request_binding", event: replyEvent(err("ack", "request_binding")), expect: { committed: stop("completed", 0) } },
  { name: "ack 503 unknown", event: replyEvent(err("ack", "unknown", 503)), expect: { committed: stop("completed", 0) } },
  // the caller's verdict on the opened result, and its durable commit
  { name: "verdict ok", event: { type: "verdict", now: NOW, verdict: "ok" }, expect: { fetched: go("fetched", "commit") } },
  { name: "verdict refused", event: { type: "verdict", now: NOW, verdict: "refused" }, expect: { fetched: drop("refused", 5) } },
  { name: "verdict clock", event: { type: "verdict", now: NOW, verdict: "clock" }, expect: { fetched: stop("clock", 12, { hold: true }) } },
  { name: "verdict ended", event: { type: "verdict", now: NOW, verdict: "ended" }, expect: { fetched: drop("gone", 3) } },
  { name: "committed", event: { type: "committed", now: NOW }, expect: { fetched: go("committed", "call") } },
  // abandon, tick
  ...(["rotate-key", "key-sweep", "logout", "superseded"] as const).map((reason): Row => ({
    name: `abandon (${reason})`, event: { type: "abandon", now: NOW, reason },
    expect: { open: drop("abandoned", 3), discovered: drop("abandoned", 3), fetched: drop("abandoned", 3), committed: drop("abandoned", 3), acked: drop("abandoned", 3) },
  })),
  {
    name: "tick before the purge time", event: { type: "tick", now: NOW },
    expect: { open: go("open", "call"), discovered: go("discovered", "call"), fetched: go("fetched", "verify"), committed: go("committed", "call"), acked: stop("completed", 0) },
  },
  {
    name: "tick at the purge time", event: (state) => ({ type: "tick", now: purgeAt(state.entry!) }),
    expect: { open: drop("lapsed", 3), discovered: drop("gone", 3), fetched: drop("gone", 3), committed: drop("completed", 0), acked: drop("completed", 0) },
  },
];

const nextEffect = (step: Step): Effect => step.effects[step.effects.length - 1]!;
const finishOf = (step: Step) => {
  const last = nextEffect(step);
  return last.type === "finish" ? last.outcome : undefined;
};

/** Properties every step must have, whatever the cell: one next effect, write-before-act, no key material in effects. */
function assertWellFormed(before: RequesterState, step: Step): void {
  const next = nextEffect(step);
  expect(["call", "sleep", "verify", "commit", "finish"]).toContain(next.type);
  expect(step.effects.filter((effect) => ["call", "sleep", "verify", "commit", "finish"].includes(effect.type))).toHaveLength(1);
  if (step.state.entry !== before.entry) {
    // The changed entry (or its removal) is made durable BEFORE the next effect.
    expect(["persist", "purge"]).toContain(step.effects[0]!.type);
  }
  const text = JSON.stringify(step.effects);
  for (const secret of SECRET_STRINGS) expect(text).not.toContain(secret);
}

function assertCell(cell: Cell, before: RequesterState, step: Step): void {
  assertWellFormed(before, step);
  const outcome = finishOf(step);
  if (cell === "internal") {
    expect(step.state.entry).toBe(before.entry);
    expect(outcome?.kind).toBe("internal");
    expect(exitCodeOf(outcome!)).toBe(7);
    expect(step.effects.some((effect) => effect.type === "purge")).toBe(false);
    return;
  }
  if (cell.entry === "drop") {
    expect(step.state.entry).toBeUndefined();
    expect(outcome?.kind).toBe(cell.outcome);
    expect(exitCodeOf(outcome!)).toBe(cell.exit);
    const purge = step.effects.find((effect) => effect.type === "purge");
    expect(purge).toEqual({ type: "purge", requestId: before.entry!.requestId, keys: heldKeys(before.entry!), entry: "remove" });
    return;
  }
  expect(step.state.entry).toBeDefined();
  if (cell.phase !== undefined) expect(step.state.entry!.phase).toBe(cell.phase);
  expect(nextEffect(step).type).toBe(cell.next);
  if (cell.next === "finish") {
    expect(outcome?.kind).toBe(cell.outcome);
    expect(exitCodeOf(outcome!)).toBe(cell.exit!);
  }
  expect(step.state.entry!.hold !== undefined).toBe(cell.hold === true);
}

describe("every (event x phase) cell of the table", () => {
  for (const row of ROWS) {
    for (const phase of PHASES) {
      test(`${row.name} in ${phase}`, () => {
        const before = liveState(entryIn(phase, { staged: phase === "open" || phase === "discovered" || phase === "fetched" }));
        const event = typeof row.event === "function" ? row.event(before) : row.event;
        assertCell(row.expect[phase] ?? "internal", before, reduce(before, event));
      });
    }
  }

  test("a state that holds the clock refuses every event but a new run, and answers the same finish", () => {
    for (const phase of ["open", "discovered", "fetched", "committed"] as const) {
      const held = reduce(liveState(entryIn(phase)), phase === "fetched"
        ? { type: "verdict", now: NOW, verdict: "clock" }
        : replyEvent(err(phase === "open" ? "discover" : phase === "discovered" ? "fetch" : "ack", "invalid_proof", 401), NOW, 90_000));
      expect(held.state.entry!.hold).toBeDefined();
      for (const row of ROWS) {
        const event = typeof row.event === "function" ? row.event(held.state) : row.event;
        const again = reduce(held.state, event);
        expect(again.state).toBe(held.state);
        expect(finishOf(again)?.kind).toBe("clock");
      }
    }
  });

  test("a new run on a held entry retries: the hold is cleared and persisted", () => {
    const held = reduce(liveState(entryIn("open")), replyEvent(err("discover", "invalid_proof", 401), NOW, 90_000)).state;
    const restarted = reduce(held, { type: "start", now: NOW + 5_000 });
    expect(restarted.state.entry!.hold).toBeUndefined();
    expect(restarted.effects[0]).toEqual({ type: "persist" });
    expect(nextEffect(restarted)).toMatchObject({ type: "call", call: "discover", firstCheck: true });
  });

  test("every non-finite clock is an illegal event, never an exception", () => {
    const before = liveState(entryIn("open"));
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const step = reduce(before, { type: "tick", now });
      expect(finishOf(step)?.kind).toBe("internal");
      expect(step.state.entry).toBe(before.entry);
    }
  });
});

describe("RULES is the one code table and matches the contract", () => {
  const expected: Readonly<Record<string, Rule["act"]>> = {
    "discover:expired_request": "lapse", "discover:request_denied": "denied", "discover:invalid_request": "refuse",
    "discover:not_found": "lapse", "discover:expired_result": "gone", "discover:request_binding": "refuse", "discover:invalid_proof": "proof",
    "fetch:not_found": "gone", "fetch:expired_result": "gone", "fetch:acknowledged": "gone", "fetch:request_binding": "refuse", "fetch:invalid_proof": "proof-kept",
    "ack:not_found": "ack-done", "ack:acknowledged": "ack-done", "ack:expired_result": "ack-done", "ack:ack_conflict": "ack-done", "ack:invalid_proof": "proof-kept",
  };
  test("maps exactly the documented (call:code) pairs, each to one action", () => {
    expect(Object.fromEntries(Object.entries(RULES).map(([key, rule]) => [key, rule.act]))).toEqual(expected);
  });

  test("a 400 invalid_request on discover is a refusal of the request, never lapsed or expired", () => {
    const rule = RULES["discover:invalid_request"]!;
    expect(rule).toMatchObject({ act: "refuse", reason: "request_invalid" });
    const step = reduce(liveState(entryIn("open")), replyEvent(err("discover", "invalid_request")));
    expect(finishOf(step)).toMatchObject({ kind: "refused", reason: "request_invalid" });
    // Even after the local expiry has passed it stays a refusal (the old client read it as expiry).
    const late = reduce(liveState(entryIn("open")), replyEvent(err("discover", "invalid_request"), E + S + 1));
    expect(finishOf(late)?.kind).toBe("refused");
    // ...while 410 expired_request is the lapse.
    expect(finishOf(reduce(liveState(entryIn("open")), replyEvent(err("discover", "expired_request", 410))))?.kind).toBe("lapsed");
  });
});

describe("denied is a terminal state: dropped, never reopened, exit 11", () => {
  test("drops the entry and both private keys", () => {
    const entry = entryIn("open", { staged: true });
    const step = reduce(liveState(entry), replyEvent(err("discover", "request_denied", 410)));
    expect(step.state.entry).toBeUndefined();
    expect(step.effects[0]).toEqual({ type: "purge", requestId: entry.requestId, keys: ["relayPrivateKey", "stagedSigningKey"], entry: "remove" });
    expect(finishOf(step)).toEqual({ kind: "denied" });
    expect(exitCodeOf({ kind: "denied" })).toBe(11);
  });

  test("later replies, ticks and even a new run cannot reopen it", () => {
    const denied = reduce(liveState(entryIn("open")), replyEvent(err("discover", "request_denied", 410))).state;
    for (const event of [
      replyEvent({ kind: "ready", resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }),
      replyEvent({ kind: "pending" }),
      { type: "tick", now: NOW + 1 },
      { type: "start", now: NOW + 2 },
    ] as const) {
      const again = reduce(denied, event);
      expect(again.state).toBe(denied);
      expect(finishOf(again)).toEqual({ kind: "denied" });
    }
  });
});

describe("401 invalid_proof is ambiguous: kept by the clock only while the request can still be live", () => {
  const proof = (now: number, skew?: number, phase: ApprovalPhase = "open") =>
    reduce(liveState(entryIn(phase)), replyEvent(err(phase === "open" ? "discover" : "fetch", "invalid_proof", 401), now, skew));

  test("(a) a clock more than 45 s off keeps the entry, exit 12, and holds it", () => {
    const step = proof(NOW, 61_000);
    expect(step.state.entry!.hold).toMatchObject({ kind: "clock" });
    expect(finishOf(step)).toMatchObject({ kind: "clock" });
    expect(exitCodeOf(finishOf(step)!)).toBe(12);
    expect(step.effects.some((effect) => effect.type === "purge")).toBe(false);
  });

  test("(A) the boundary of 'measurably off' is the named constant: 44 s is sane (refused 5), 46 s is off (hold 12), either direction", () => {
    expect(CLOCK_DISAGREEMENT_MS).toBe(45_000);
    for (const skew of [44_000, -44_000, 45_000, -45_000]) {
      const step = proof(NOW, skew);
      expect(finishOf(step)?.kind).toBe("refused");
      expect(step.state.entry).toBeUndefined();
      expect(exitCodeOf(finishOf(step)!)).toBe(5);
    }
    for (const skew of [45_001, 46_000, -46_000]) {
      const step = proof(NOW, skew);
      expect(finishOf(step)?.kind).toBe("clock");
      expect(step.state.entry!.hold).toBeDefined();
      expect(exitCodeOf(finishOf(step)!)).toBe(12);
    }
  });

  test("(b) the SAME 401 after E + S lapses the entry and drops its keys, exit 3, even with the clock still off", () => {
    for (const skew of [44_000, 46_000, 61_000, 150_000, -150_000]) {
      const step = proof(E + S, skew);
      expect(step.state.entry).toBeUndefined();
      expect(step.effects[0]).toMatchObject({ type: "purge", keys: ["relayPrivateKey"], entry: "remove" });
      expect(finishOf(step)).toMatchObject({ kind: "lapsed" });
      expect(exitCodeOf(finishOf(step)!)).toBe(3);
    }
    // One millisecond before E + S it is still the clock case.
    expect(finishOf(proof(E + S - 1, 150_000))?.kind).toBe("clock");
  });

  test("(c) a sane clock (<= 45 s) drops the entry and its keys at once, exit 5", () => {
    const step = proof(NOW, 12_000);
    expect(step.state.entry).toBeUndefined();
    expect(step.effects[0]).toMatchObject({ type: "purge", keys: ["relayPrivateKey"] });
    expect(exitCodeOf(finishOf(step)!)).toBe(5);
  });

  test("(d) a missing or unparseable Date header is skew unknown: the exit-5 path, never a loop", () => {
    const step = proof(NOW, undefined);
    expect(step.state.entry).toBeUndefined();
    expect(exitCodeOf(finishOf(step)!)).toBe(5);
    expect(proof(NOW, Number.NaN).state.entry).toBeUndefined();
  });

  test("(e) an expired request seen through a -150 s proof ends lapsed, exit 3, after E + S", () => {
    const start = reduce(liveState(entryIn("open"), { firstCheckDone: false }), { type: "start", now: E + S + 2_000 });
    expect(nextEffect(start)).toMatchObject({ type: "call", call: "discover", firstCheck: true, settle: true });
    const step = reduce(start.state, replyEvent(err("discover", "invalid_proof", 401), E + S + 2_500, 150_000));
    expect(step.state.entry).toBeUndefined();
    expect(exitCodeOf(finishOf(step)!)).toBe(3);
  });

  test("(g) exit 8 is never returned from an invalid_proof, whatever the time and skew", () => {
    for (const now of [T0, NOW, E - 1, E, E + S - 1, E + S, E + R]) {
      for (const skew of [undefined, 0, 59_999, 60_001, 3_600_000, -3_600_000]) {
        for (const phase of ["open", "discovered"] as const) {
          const outcome = finishOf(proof(now, skew, phase));
          expect(outcome?.kind).not.toBe("pending");
          expect(exitCodeOf(outcome!)).not.toBe(8);
        }
      }
    }
  });

  test("after the approval exists, a clock-held entry is bounded by the purge time, not by E", () => {
    const held = proof(purgeAt(entryIn("discovered")) - 1, 90_000, "discovered");
    expect(held.state.entry!.hold).toBeDefined();
    const entry = held.state.entry!;
    const purged = reduce({ entry, run: held.state.run }, { type: "tick", now: purgeAt(entry) });
    expect(purged.state.entry).toBeUndefined();
  });
});

describe("keys: every terminal transition that drops the entry purges its keys; keep never does", () => {
  test("each drop step purges exactly the keys the entry held, and its next state holds none", () => {
    for (const row of ROWS) {
      for (const phase of PHASES) {
        for (const staged of [false, true]) {
          const before = liveState(entryIn(phase, { staged }));
          const event = typeof row.event === "function" ? row.event(before) : row.event;
          const step = reduce(before, event);
          if (step.state.entry === undefined) {
            expect(step.effects.find((effect) => effect.type === "purge")).toEqual({
              type: "purge", requestId: before.entry!.requestId, keys: heldKeys(before.entry!), entry: "remove",
            });
          } else if (!step.effects.some((effect) => effect.type === "purge")) {
            // keep: the keys the entry had are still there, byte for byte.
            expect(step.state.entry.keys).toEqual(before.entry!.keys === undefined ? undefined : before.entry!.keys);
          }
        }
      }
    }
  });

  test("a committed event scrubs the staged signing key and keeps the relay key until the ack", () => {
    const before = liveState(entryIn("fetched", { staged: true }));
    const step = reduce(before, { type: "committed", now: NOW });
    expect(step.state.entry!.keys).toEqual({ relayPrivateKey: before.entry!.keys!.relayPrivateKey });
    expect(step.effects[0]).toEqual({ type: "purge", requestId: before.entry!.requestId, keys: ["stagedSigningKey"], entry: "rewrite" });
  });

  test("an ack of a command entry (retainUntil in the future) keeps a KEY-FREE acked entry", () => {
    const retain = NOW + 3_600_000;
    const before = liveState(entryIn("committed", { retainUntil: retain }));
    const step = reduce(before, replyEvent({ kind: "acked" }));
    expect(step.state.entry!.phase).toBe("acked");
    expect(step.state.entry!.keys).toBeUndefined();
    expect(step.state.entry!.resultEnvelope).toBeUndefined();
    // P3-9: the approval URL's fragment holds the content key; a key-free acked entry keeps neither it nor the sealed body.
    expect(step.state.entry!.approvalUrl).toBeUndefined();
    expect(step.state.entry!.record.body).toBeUndefined();
    expect(JSON.stringify(step.state.entry)).not.toContain(CONTENT_KEY);
    expect(step.state.entry!.record.header).toEqual(before.entry!.record.header);
    expect(step.effects[0]).toEqual({ type: "purge", requestId: before.entry!.requestId, keys: ["relayPrivateKey"], entry: "rewrite" });
    expect(finishOf(step)).toEqual({ kind: "completed" });
  });

  test("an ack conflict completes with a warning and the entry goes; an ack that cannot be sent completes with a warning and the entry stays", () => {
    const conflict = reduce(liveState(entryIn("committed")), replyEvent(err("ack", "ack_conflict", 409)));
    expect(finishOf(conflict)).toEqual({ kind: "completed", warning: "ack-conflict" });
    expect(conflict.state.entry).toBeUndefined();
    const down = reduce(liveState(entryIn("committed")), replyEvent({ kind: "network" }));
    expect(finishOf(down)).toEqual({ kind: "completed", warning: "ack-pending" });
    expect(down.state.entry!.phase).toBe("committed");
  });

  test("past the purge time no state holds a private key, in any phase, held or not", () => {
    for (const phase of PHASES) {
      const entry = entryIn(phase, { staged: phase !== "committed" && phase !== "acked" });
      const step = reduce(liveState(entry), { type: "tick", now: purgeAt(entry) + 1 });
      expect(step.state.entry).toBeUndefined();
      expect(step.effects[0]).toMatchObject({ type: "purge", entry: "remove" });
    }
  });
});

describe("local expiry and purge time come from the signed header", () => {
  test("E is the header expiresAt; purge = E+R+S while open, min(result, E+R)+S once approved", () => {
    expect(localExpiry(entryIn("open"))).toBe(E);
    expect(purgeAt(entryIn("open"))).toBe(E + R + S);
    expect(purgeAt(entryIn("discovered"))).toBe(Date.parse(RESULT_EXPIRES) + S);
    // a forged, far-future resultExpiresAt cannot extend the entry's life past E + R
    expect(purgeAt(entryIn("discovered", { resultExpiresAt: new Date(E + 10 * R).toISOString() }))).toBe(E + R + S);
    expect(purgeAt(entryIn("acked", { retainUntil: E + 5 * R }))).toBe(E + 5 * R);
  });
});

describe("the exit table", () => {
  test("one number per outcome, drawn from {0,3,5,6,7,8,11,12}, disjoint from the reserved codes", () => {
    const allowed = new Set([0, 3, 5, 6, 7, 8, 11, 12]);
    const kinds = ["completed", "pending", "unreachable", "unexpected", "lapsed", "gone", "refused", "denied", "clock", "abandoned", "internal"] as const;
    expect(Object.keys(APPROVAL_EXIT).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      expect(allowed.has(APPROVAL_EXIT[kind])).toBe(true);
      expect([9, 10, 126, 127, 128, 129, 130]).not.toContain(APPROVAL_EXIT[kind]);
    }
    expect(APPROVAL_EXIT).toMatchObject({ completed: 0, pending: 8, unreachable: 6, unexpected: 7, lapsed: 3, gone: 3, refused: 5, denied: 11, clock: 12 });
  });
});

describe("a plain 202 after E + S", () => {
  const settle = () => reduce(liveState(entryIn("open"), { finalPoll: true }), replyEvent({ kind: "pending" }, E + S + 1_000, 90_000));
  test("with the clock measurably off holds the entry, exit 12", () => {
    expect(finishOf(settle())?.kind).toBe("clock");
  });
  test("with a sane clock is an inconsistent OpenKey (exit 7), kept, and never pending", () => {
    const step = reduce(liveState(entryIn("open"), { finalPoll: true }), replyEvent({ kind: "pending" }, E + S + 1_000, 1_000));
    expect(finishOf(step)?.kind).toBe("unexpected");
    expect(step.state.entry).toBeDefined();
  });
});

describe("requesterState starts a run with its first check still to do", () => {
  test("start on an open entry asks for a full-limit first discover, with no bound", () => {
    const start = reduce(requesterState(entryIn("open")), { type: "start", now: NOW, deadline: NOW + 1_000 });
    expect(nextEffect(start)).toEqual({ type: "call", call: "discover", firstCheck: true, settle: false });
  });
  test("a deadline that has already passed still gets one full first check before anything is reported", () => {
    const start = reduce(requesterState(entryIn("open")), { type: "start", now: NOW, deadline: NOW - 5_000 });
    expect(nextEffect(start)).toEqual({ type: "call", call: "discover", firstCheck: true, settle: false });
    const answered = reduce(start.state, replyEvent({ kind: "pending" }, NOW + 100));
    expect(finishOf(answered)).toMatchObject({ kind: "pending", confirmedLiveAt: NOW + 100 });
    const silent = reduce(start.state, replyEvent({ kind: "network" }, NOW + 10_000));
    expect(finishOf(silent)?.kind).toBe("unreachable");
  });

  test("a request created this run (201) counts as confirmed live", () => {
    const start = reduce(requesterState(entryIn("open")), { type: "start", now: NOW, deadline: NOW - 1, createdThisRun: true });
    const silent = reduce(start.state, replyEvent({ kind: "network" }, NOW + 10_000));
    expect(finishOf(silent)).toMatchObject({ kind: "pending", confirmedLiveAt: NOW });
  });
});

describe("an approved result's expiry is validated on ingest (a bad one must not make the keys unpurgeable)", () => {
  const ready = (resultExpiresAt: string): Event => replyEvent({ kind: "ready", resultRef: RESULT_REF, resultExpiresAt });

  test("a garbled or non-canonical resultExpiresAt is an unexpected reply: the entry stays open and unchanged", () => {
    for (const bad of ["", "tomorrow", "NaN", "2026-11-03T12:10:00Z", "2026-13-45T99:99:99.000Z", "9999-99-99"]) {
      const before = liveState(entryIn("open", { staged: true }));
      const step = reduce(before, ready(bad));
      expect(step.state.entry).toBe(before.entry);
      expect(step.state.settled).toBeUndefined();
      expect(nextEffect(step).type).toBe("sleep");
      expect(step.state.run.unexpectedStreak).toBe(1);
    }
  });

  test("five bad replies in a row end the run (exit 7) with the entry kept and still purgeable", () => {
    let step: Step = reduce(liveState(entryIn("open")), ready("tomorrow"));
    for (let count = 1; count < 5; count++) step = reduce(step.state, ready("tomorrow"));
    expect(finishOf(step)?.kind).toBe("unexpected");
    expect(purgeAt(step.state.entry!)).toBe(E + R + S);
  });

  test("an expiry already in the past discovers, then the entry is purged at once (keys dropped), never kept", () => {
    const step = reduce(liveState(entryIn("open", { staged: true })), ready(iso(NOW - 2 * S)));
    expect(step.state.entry).toBeUndefined();
    expect(step.effects[0]).toEqual({ type: "purge", requestId: REQUEST_ID, keys: ["relayPrivateKey", "stagedSigningKey"], entry: "remove" });
  });

  test("a far-future expiry cannot extend the entry's life past E + R + S", () => {
    const step = reduce(liveState(entryIn("open")), ready(iso(E + 1_000 * R)));
    expect(purgeAt(step.state.entry!)).toBe(E + R + S);
  });

  test("purgeAt never returns NaN: an entry whose stored expiry is unreadable is purged at E + R + S", () => {
    const entry = { ...entryIn("discovered"), resultExpiresAt: "garbled" };
    expect(purgeAt(entry)).toBe(E + R + S);
    expect(reduce(liveState(entry), { type: "tick", now: E + R + S }).state.entry).toBeUndefined();
  });
});

describe("a request created in this run versus a resumed one (first check)", () => {
  const past = (createdThisRun: boolean) => reduce(requesterState(entryIn("open")), { type: "start", now: NOW, deadline: NOW - 5_000, ...(createdThisRun ? { createdThisRun } : {}) });

  test("a resumed request whose first check gets no answer is unreachable (exit 6), kept with its keys, never pending", () => {
    const silent = reduce(past(false).state, replyEvent({ kind: "network" }, NOW + 10_000));
    expect(finishOf(silent)).toMatchObject({ kind: "unreachable", expiresAt: E });
    expect(exitCodeOf(finishOf(silent)!)).toBe(6);
    expect(silent.state.entry!.keys!.relayPrivateKey).toBeDefined();
    expect(silent.effects.some((effect) => effect.type === "purge")).toBe(false);
  });

  test("a resumed request still gets its full first check even when the deadline has passed", () => {
    expect(nextEffect(past(false))).toMatchObject({ type: "call", call: "discover", firstCheck: true });
  });

  test("a request created this run is live by construction: no answer at the deadline is pending (exit 8) with the creation time", () => {
    const silent = reduce(past(true).state, replyEvent({ kind: "network" }, NOW + 10_000));
    expect(finishOf(silent)).toEqual({ kind: "pending", expiresAt: E, confirmedLiveAt: NOW });
    expect(exitCodeOf(finishOf(silent)!)).toBe(8);
  });

  test("a resumed entry that already has a result keeps collecting past the deadline (the first-check rule is for entries without one)", () => {
    const start = reduce(requesterState(entryIn("discovered")), { type: "start", now: NOW, deadline: NOW - 5_000 });
    expect(nextEffect(start)).toMatchObject({ type: "call", call: "fetch" });
    const silent = reduce(start.state, replyEvent({ kind: "network" }, NOW + 1_000));
    expect(nextEffect(silent).type).toBe("sleep");
  });
});

describe("a 401 never drops an approved result: fetch and ack keep the entry, bounded by its purge time", () => {
  const fetch401 = (skew: number | undefined, now = NOW) => reduce(liveState(entryIn("discovered", { staged: true })), replyEvent(err("fetch", "invalid_proof", 401), now, skew));
  const ack401 = (skew: number | undefined, now = NOW) => reduce(liveState(entryIn("committed")), replyEvent(err("ack", "invalid_proof", 401), now, skew));

  test.each([
    ["fetch", fetch401],
    ["ack", ack401],
  ])("%s 401 with a sane clock (<= 45 s, or no Date) keeps the entry and its keys and reports unexpected (exit 7)", (call, run) => {
    for (const skew of [undefined, 0, 44_000, -44_000, 45_000]) {
      const step = run(skew);
      expect(step.state.entry).toBeDefined();
      expect(step.state.entry!.hold).toBeUndefined();
      expect(step.state.entry!.keys!.relayPrivateKey).toBeDefined();
      expect(step.effects.some((effect) => effect.type === "purge")).toBe(false);
      // D-2: after an ack 401 the grant IS saved (the caller's commit succeeded); a fetch 401 says nothing of the sort.
      expect(finishOf(step)).toEqual(call === "ack" ? { kind: "unexpected", grantSaved: true as const } : { kind: "unexpected" });
      expect(exitCodeOf(finishOf(step)!)).toBe(7);
    }
  });

  test.each([
    ["fetch", fetch401],
    ["ack", ack401],
  ])("%s 401 with the clock off (> 45 s) holds the entry and reports exit 12", (_call, run) => {
    for (const skew of [46_000, -46_000, 3_600_000]) {
      const step = run(skew);
      expect(step.state.entry!.hold).toMatchObject({ kind: "clock" });
      expect(step.state.entry!.keys!.relayPrivateKey).toBeDefined();
      expect(step.effects[0]).toEqual({ type: "persist" });
      expect(finishOf(step)).toMatchObject({ kind: "clock" });
      expect(exitCodeOf(finishOf(step)!)).toBe(12);
    }
  });

  test("the entry keeps its result reference and the next run retries it", () => {
    const kept = fetch401(0).state;
    expect(kept.entry!.resultRef).toBe(RESULT_REF);
    expect(nextEffect(reduce(kept, { type: "start", now: NOW + 1_000 }))).toMatchObject({ type: "call", call: "fetch" });
    const held = ack401(90_000).state;
    expect(nextEffect(reduce(held, { type: "start", now: NOW + 1_000 }))).toMatchObject({ type: "call", call: "ack" });
  });

  test("it is never dropped by the 401, whatever the time and skew; at the purge time the entry is purged as before", () => {
    for (const [run, entry] of [[fetch401, entryIn("discovered", { staged: true })], [ack401, entryIn("committed")]] as const) {
      const bound = purgeAt(entry);
      for (const skew of [undefined, 0, 46_000, -3_600_000]) {
        for (const now of [T0, NOW, bound - 1]) expect(run(skew, now).state.entry).toBeDefined();
        const kept = run(skew, bound - 1).state;
        // The run ended (stopped or held); the next run's start applies the clock first, so the purge comes before any call.
        const purged = reduce(kept, { type: "start", now: bound });
        expect(purged.state.entry).toBeUndefined();
        expect(purged.effects[0]).toMatchObject({ type: "purge", entry: "remove" });
      }
    }
  });
});

describe("a committed entry that reaches its purge time completes with a warning: the grant is saved", () => {
  test("outcome completed + ack-expired warning (exit 0), the entry and its relay key dropped the same way", () => {
    const entry = entryIn("committed");
    const step = reduce(liveState(entry), { type: "tick", now: purgeAt(entry) });
    expect(finishOf(step)).toEqual({ kind: "completed", warning: "ack-expired" });
    expect(exitCodeOf(finishOf(step)!)).toBe(0);
    expect(step.state.entry).toBeUndefined();
    expect(step.effects[0]).toEqual({ type: "purge", requestId: entry.requestId, keys: ["relayPrivateKey"], entry: "remove" });
  });

  test("an entry whose result was never saved by the caller still ends gone (exit 3); an acked entry ends completed without a warning", () => {
    for (const phase of ["discovered", "fetched"] as const) {
      expect(finishOf(reduce(liveState(entryIn(phase)), { type: "tick", now: purgeAt(entryIn(phase)) }))).toMatchObject({ kind: "gone", reason: "purged" });
    }
    expect(finishOf(reduce(liveState(entryIn("acked")), { type: "tick", now: purgeAt(entryIn("acked")) }))).toEqual({ kind: "completed" });
  });

  test("just before the purge time nothing is dropped", () => {
    const entry = entryIn("committed");
    expect(reduce(liveState(entry), { type: "tick", now: purgeAt(entry) - 1 }).state.entry).toBeDefined();
  });
});

describe("the purge time WINS over any reply that lands after it (D-1)", () => {
  const sane = 0;
  const off = 90_000;
  interface Landing {
    readonly name: string;
    readonly phase: ApprovalPhase;
    readonly event: (now: number) => Event;
    /** The reply is a keep/hold/continue just BEFORE the purge time (a 401 on an open entry past E + S lapses by §10.2, so it is not one). */
    readonly keepsBefore: boolean;
    readonly outcome: Outcome;
  }
  const lapsed: Outcome = { kind: "lapsed", reason: "purged", grantMayBeLive: "no" };
  const gone: Outcome = { kind: "gone", reason: "purged", grantMayBeLive: "yes" };
  const savedUnacked: Outcome = { kind: "completed", warning: "ack-expired" };
  const LANDINGS: readonly Landing[] = [
    { name: "open: network", phase: "open", event: (now) => replyEvent({ kind: "network" }, now), keepsBefore: true, outcome: lapsed },
    { name: "open: malformed", phase: "open", event: (now) => replyEvent({ kind: "malformed", call: "discover" }, now), keepsBefore: true, outcome: lapsed },
    { name: "open: 500", phase: "open", event: (now) => replyEvent(err("discover", "unknown", 500), now), keepsBefore: true, outcome: lapsed },
    // Already terminal by §10.2 (the request has run out): it keeps its own outcome, the purge time does not rewrite it.
    { name: "open: 401 sane", phase: "open", event: (now) => replyEvent(err("discover", "invalid_proof", 401), now, sane), keepsBefore: false, outcome: { kind: "lapsed", reason: "proof_after_expiry", grantMayBeLive: "no" } },
    { name: "open: 401 clock off", phase: "open", event: (now) => replyEvent(err("discover", "invalid_proof", 401), now, off), keepsBefore: false, outcome: { kind: "lapsed", reason: "proof_after_expiry", grantMayBeLive: "no" } },
    { name: "discovered: network", phase: "discovered", event: (now) => replyEvent({ kind: "network" }, now), keepsBefore: true, outcome: gone },
    { name: "discovered: malformed", phase: "discovered", event: (now) => replyEvent({ kind: "malformed", call: "fetch" }, now), keepsBefore: true, outcome: gone },
    { name: "discovered: 500", phase: "discovered", event: (now) => replyEvent(err("fetch", "unknown", 500), now), keepsBefore: true, outcome: gone },
    { name: "discovered: 401 sane", phase: "discovered", event: (now) => replyEvent(err("fetch", "invalid_proof", 401), now, sane), keepsBefore: true, outcome: gone },
    { name: "discovered: 401 clock off", phase: "discovered", event: (now) => replyEvent(err("fetch", "invalid_proof", 401), now, off), keepsBefore: true, outcome: gone },
    { name: "fetched: verdict clock", phase: "fetched", event: (now) => ({ type: "verdict", now, verdict: "clock" }), keepsBefore: true, outcome: gone },
    { name: "fetched: verdict ok", phase: "fetched", event: (now) => ({ type: "verdict", now, verdict: "ok" }), keepsBefore: true, outcome: gone },
    // The caller's commit already succeeded: the grant is saved, so this is not a failure.
    { name: "fetched: committed event", phase: "fetched", event: (now) => ({ type: "committed", now }), keepsBefore: true, outcome: savedUnacked },
    { name: "committed: network", phase: "committed", event: (now) => replyEvent({ kind: "network" }, now), keepsBefore: true, outcome: savedUnacked },
    { name: "committed: malformed", phase: "committed", event: (now) => replyEvent({ kind: "malformed", call: "ack" }, now), keepsBefore: true, outcome: savedUnacked },
    { name: "committed: 500", phase: "committed", event: (now) => replyEvent(err("ack", "unknown", 500), now), keepsBefore: true, outcome: savedUnacked },
    { name: "committed: 401 sane", phase: "committed", event: (now) => replyEvent(err("ack", "invalid_proof", 401), now, sane), keepsBefore: true, outcome: savedUnacked },
    { name: "committed: 401 clock off", phase: "committed", event: (now) => replyEvent(err("ack", "invalid_proof", 401), now, off), keepsBefore: true, outcome: savedUnacked },
  ];

  for (const landing of LANDINGS) {
    test(`${landing.name}: just before purgeAt it keeps; at purgeAt and 9 s later (the request limit) it purges and never persists`, () => {
      const entry = entryIn(landing.phase, { staged: landing.phase !== "committed" });
      const bound = purgeAt(entry);
      if (landing.keepsBefore) expect(reduce(liveState(entry), landing.event(bound - 1)).state.entry).toBeDefined();
      for (const now of [bound, bound + 9_000]) {
        const step = reduce(liveState(entry), landing.event(now));
        expect(step.state.entry).toBeUndefined();
        expect(step.effects.some((effect) => effect.type === "persist")).toBe(false);
        expect(step.effects[0]).toEqual({ type: "purge", requestId: entry.requestId, keys: heldKeys(entry), entry: "remove" });
        expect(finishOf(step)).toEqual(landing.outcome);
        expect(JSON.stringify(step.effects)).not.toContain(RELAY_KEY);
      }
    });
  }
});

describe("an outcome says when the grant is already saved (D-2)", () => {
  test("a committed entry's ack 401 (sane clock, then clock off) carries grantSaved: the caller must not report a failed sign-in", () => {
    const sane = finishOf(reduce(liveState(entryIn("committed")), replyEvent(err("ack", "invalid_proof", 401), NOW, 1_000)))!;
    const off = finishOf(reduce(liveState(entryIn("committed")), replyEvent(err("ack", "invalid_proof", 401), NOW, 90_000)))!;
    expect(sane).toEqual({ kind: "unexpected", grantSaved: true });
    expect(off).toMatchObject({ kind: "clock", grantSaved: true });
    expect(exitCodeOf(sane)).toBe(7);
    expect(exitCodeOf(off)).toBe(12);
  });

  test("it is NOT set before the caller's commit: open, discovered and fetched entries never carry it", () => {
    const outcomes: Outcome[] = [
      finishOf(reduce(liveState(entryIn("discovered")), replyEvent(err("fetch", "invalid_proof", 401), NOW, 1_000)))!,
      finishOf(reduce(liveState(entryIn("discovered")), replyEvent(err("fetch", "invalid_proof", 401), NOW, 90_000)))!,
      finishOf(reduce(liveState(entryIn("open")), replyEvent(err("discover", "invalid_proof", 401), NOW, 90_000)))!,
      finishOf(reduce(liveState(entryIn("fetched")), { type: "verdict", now: NOW, verdict: "clock" }))!,
      finishOf(reduce(liveState(entryIn("open"), { unexpectedStreak: 4 }), replyEvent(err("discover", "unknown", 500))))!,
    ];
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["unexpected", "clock", "clock", "clock", "unexpected"]);
    for (const outcome of outcomes) expect("grantSaved" in outcome).toBe(false);
  });
});

describe("createdThisRun is honoured only for a fresh open entry (D-3)", () => {
  const confirmedAt = (entry: ApprovalEntry, now: number) => reduce(requesterState(entry), { type: "start", now, createdThisRun: true }).state.run.confirmedLiveAt;

  test("a fresh open entry (created within the 120 s window, no result) is confirmed live at the start time", () => {
    expect(confirmedAt(entryIn("open"), NOW)).toBe(NOW);
    expect(confirmedAt(entryIn("open"), T0 + 120_000)).toBe(T0 + 120_000);
    expect(confirmedAt(entryIn("open"), T0 - 120_000)).toBe(T0 - 120_000);
  });

  test("a resumed entry is not: created long ago, in the far future, already discovered, fetched, committed, or holding a result reference", () => {
    expect(confirmedAt(entryIn("open"), T0 + 120_001)).toBeUndefined();
    expect(confirmedAt(entryIn("open"), T0 - 120_001)).toBeUndefined();
    for (const phase of ["discovered", "fetched", "committed"] as const) expect(confirmedAt(entryIn(phase), NOW)).toBeUndefined();
    expect(confirmedAt({ ...entryIn("open"), resultRef: RESULT_REF }, NOW)).toBeUndefined();
  });

  test("so a caller passing true for a resumed entry still gets unreachable (6), never pending (8)", () => {
    const old = { ...entryIn("open"), createdAt: iso(T0 - 3_600_000) };
    const start = reduce(requesterState(old), { type: "start", now: NOW, deadline: NOW - 1, createdThisRun: true });
    expect(finishOf(reduce(start.state, replyEvent({ kind: "network" }, NOW + 10_000)))?.kind).toBe("unreachable");
  });
});

describe("a reply that was already TERMINAL keeps its own outcome when it lands after the purge time (R-1)", () => {
  interface Terminal {
    readonly name: string;
    readonly phase: ApprovalPhase;
    readonly event: (now: number) => Event;
    readonly outcome: Outcome;
    readonly exit: number;
  }
  const TERMINALS: readonly Terminal[] = [
    { name: "open + 410 denied", phase: "open", event: (now) => replyEvent(err("discover", "request_denied", 410), now), outcome: { kind: "denied" }, exit: 11 },
    {
      name: "open + 410 expired_result (the owner approved: the 'maybe granted' notice survives)", phase: "open",
      event: (now) => replyEvent(err("discover", "expired_result", 410), now), outcome: { kind: "gone", reason: "expired_result", grantMayBeLive: "yes" }, exit: 3,
    },
    {
      name: "open + 400 request_binding", phase: "open", event: (now) => replyEvent(err("discover", "request_binding"), now),
      outcome: { kind: "refused", reason: "request_binding", grantMayBeLive: "maybe" }, exit: 5,
    },
    { name: "open + 410 expired_request", phase: "open", event: (now) => replyEvent(err("discover", "expired_request", 410), now), outcome: { kind: "lapsed", reason: "expired_request", grantMayBeLive: "no" }, exit: 3 },
    {
      // The approved path is NOT terminal (it keeps the entry as `discovered`), so the purge time wins there: discovered, then purged at once.
      name: "open + 200 approved (the approved path keeps, so the purge wins: discovered then purged at once)", phase: "open",
      event: (now) => replyEvent({ kind: "ready", resultRef: RESULT_REF, resultExpiresAt: iso(now + R) }, now), outcome: { kind: "gone", reason: "purged", grantMayBeLive: "yes" }, exit: 3,
    },
    { name: "discovered + 404 not_found", phase: "discovered", event: (now) => replyEvent(err("fetch", "not_found", 404), now), outcome: { kind: "gone", reason: "not_found", grantMayBeLive: "yes" }, exit: 3 },
    {
      name: "fetched + verdict refused", phase: "fetched", event: (now) => ({ type: "verdict", now, verdict: "refused" }),
      outcome: { kind: "refused", reason: "verification", grantMayBeLive: "yes" }, exit: 5,
    },
    { name: "committed + ack 200: a plain success, NO ack-expired warning", phase: "committed", event: (now) => replyEvent({ kind: "acked" }, now), outcome: { kind: "completed" }, exit: 0 },
    { name: "committed + ack 404", phase: "committed", event: (now) => replyEvent(err("ack", "not_found", 404), now), outcome: { kind: "completed" }, exit: 0 },
    { name: "committed + ack ack_conflict", phase: "committed", event: (now) => replyEvent(err("ack", "ack_conflict", 409), now), outcome: { kind: "completed", warning: "ack-conflict" }, exit: 0 },
  ];

  for (const terminal of TERMINALS) {
    test(`${terminal.name}: at purgeAt + 1..9 s it keeps its outcome; keys purged exactly once, before the remove, no persist`, () => {
      const entry = entryIn(terminal.phase, { staged: terminal.phase !== "committed" });
      for (const now of [purgeAt(entry), purgeAt(entry) + 1_000, purgeAt(entry) + 9_000]) {
        const step = reduce(liveState(entry), terminal.event(now));
        expect(step.state.entry).toBeUndefined();
        expect(step.effects.some((effect) => effect.type === "persist")).toBe(false);
        expect(step.effects.filter((effect) => effect.type === "purge")).toEqual([{ type: "purge", requestId: entry.requestId, keys: heldKeys(entry), entry: "remove" }]);
        expect(step.effects[0]!.type).toBe("purge");
        expect(finishOf(step)).toEqual(terminal.outcome);
        expect(exitCodeOf(finishOf(step)!)).toBe(terminal.exit);
      }
    });
  }
});

describe("every entry the machine writes passes its own schema (R-2)", () => {
  const MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
  const persisted = (step: Step) => {
    expect(step.effects.some((effect) => effect.type === "persist" || (effect.type === "purge" && effect.entry === "rewrite"))).toBe(true);
    return approvalEntrySchema.safeParse(step.state.entry).success;
  };

  test("a ready reply with an empty result reference is an unexpected reply, not an entry the schema would refuse", () => {
    for (const resultRef of ["", undefined as unknown as string]) {
      const before = liveState(entryIn("open", { staged: true }));
      const step = reduce(before, replyEvent({ kind: "ready", resultRef, resultExpiresAt: RESULT_EXPIRES }));
      expect(step.state.entry).toBe(before.entry);
      expect(nextEffect(step).type).toBe("sleep");
      expect(step.state.run.unexpectedStreak).toBe(1);
    }
  });

  test("an envelope reply with no envelope is an unexpected reply", () => {
    const before = liveState(entryIn("discovered", { staged: true }));
    const step = reduce(before, replyEvent({ kind: "envelope", envelope: undefined }));
    expect(step.state.entry).toBe(before.entry);
    expect(nextEffect(step).type).toBe("sleep");
  });

  test("retainUntil is clamped to a canonical timestamp: far future, far past, and the committed entry parses back", () => {
    for (const retainUntil of [8.64e15, MAX + 1, MAX, 0, -8.64e15, -1]) {
      const step = reduce(liveState(entryIn("fetched", { staged: true })), { type: "committed", now: NOW, retainUntil });
      expect(persisted(step)).toBe(true);
      expect(step.state.entry!.retainUntil).toBe(new Date(Math.min(Math.max(retainUntil, 0), MAX)).toISOString());
    }
    expect(finishOf(reduce(liveState(entryIn("fetched")), { type: "committed", now: NOW, retainUntil: Number.NaN }))?.kind).toBe("internal");
  });

  test("an ack of a command entry whose retainUntil was clamped still leaves a key-free entry that parses", () => {
    const committed = reduce(liveState(entryIn("fetched")), { type: "committed", now: NOW, retainUntil: 8.64e15 }).state;
    const acked = reduce(committed, replyEvent({ kind: "acked" }, NOW + 1_000));
    expect(persisted(acked)).toBe(true);
    expect(acked.state.entry!.phase).toBe("acked");
  });

  test("a clock past year 9999 (or before 1970) is an illegal event, never a hold.since the schema refuses; the last valid millisecond holds and parses", () => {
    const late = { ...entryIn("open"), createdAt: "9999-12-31T00:00:00.000Z" };
    late.record = { ...late.record, header: { ...late.record.header, issuedAt: "9999-12-31T00:00:00.000Z", expiresAt: "9999-12-31T23:59:59.000Z" } };
    for (const now of [MAX + 1, 8.64e15, -1]) {
      const step = reduce(liveState(late), replyEvent(err("discover", "invalid_proof", 401), now, 90_000));
      expect(finishOf(step)?.kind).toBe("internal");
      expect(step.state.entry).toBe(late);
    }
    const held = reduce(liveState(late), replyEvent(err("discover", "invalid_proof", 401), MAX, 90_000));
    expect(finishOf(held)?.kind).toBe("clock");
    expect(persisted(held)).toBe(true);
    expect(held.state.entry!.hold!.since).toBe("9999-12-31T23:59:59.999Z");
  });
});
