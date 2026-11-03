import { describe, expect, test } from "bun:test";
import {
  APPROVAL_EXIT,
  RULES,
  exitCodeOf,
  heldKeys,
  localExpiry,
  purgeAt,
  reduce,
  requesterState,
  type ApprovalPhase,
  type Effect,
  type Event,
  type Reply,
  type ReplyCode,
  type RequesterState,
  type Step,
} from "../src/links/index.js";
import { E, PHASES, R, RESULT_EXPIRES, RESULT_REF, S, SECRET_STRINGS, T0, entryIn, liveState } from "./approval-machine-fixtures.js";

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
  | { readonly entry: "keep"; readonly phase?: ApprovalPhase; readonly next: Effect["type"]; readonly outcome?: string; readonly exit?: number; readonly hold?: true }
  | { readonly entry: "drop"; readonly outcome: string; readonly exit: number };

const go = (phase: ApprovalPhase, next: Effect["type"]): Cell => ({ entry: "keep", phase, next });
const stop = (outcome: string, exit: number, extra: { hold?: true } = {}): Cell => ({ entry: "keep", next: "finish", outcome, exit, ...extra });
const drop = (outcome: string, exit: number): Cell => ({ entry: "drop", outcome, exit });

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
  { name: "fetch 401 invalid_proof, clock sane", event: replyEvent(err("fetch", "invalid_proof", 401), NOW, 5_000), expect: { discovered: drop("refused", 5) } },
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
  { name: "ack 401 invalid_proof", event: replyEvent(err("ack", "invalid_proof", 401), NOW, 90_000), expect: { committed: stop("completed", 0) } },
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
    expect: { open: drop("lapsed", 3), discovered: drop("gone", 3), fetched: drop("gone", 3), committed: drop("gone", 3), acked: drop("completed", 0) },
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
    expect(exitCodeOf(outcome!)).toBe(cell.exit);
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
      if (phase === "committed") continue; // a failed ack never holds: the grant is saved (asserted in the ack rows)
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
  const expected: Readonly<Record<string, string>> = {
    "discover:expired_request": "lapse", "discover:request_denied": "denied", "discover:invalid_request": "refuse",
    "discover:not_found": "lapse", "discover:expired_result": "gone", "discover:request_binding": "refuse", "discover:invalid_proof": "proof",
    "fetch:not_found": "gone", "fetch:expired_result": "gone", "fetch:acknowledged": "gone", "fetch:request_binding": "refuse", "fetch:invalid_proof": "proof",
    "ack:not_found": "ack-done", "ack:acknowledged": "ack-done", "ack:expired_result": "ack-done", "ack:ack_conflict": "ack-done",
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

  test("(a) a clock more than 60 s off keeps the entry, exit 12, and holds it", () => {
    const step = proof(NOW, 61_000);
    expect(step.state.entry!.hold).toMatchObject({ kind: "clock" });
    expect(finishOf(step)).toMatchObject({ kind: "clock" });
    expect(exitCodeOf(finishOf(step)!)).toBe(12);
    expect(step.effects.some((effect) => effect.type === "purge")).toBe(false);
  });

  test("a clock exactly 60 s off, either direction, is not measurably off", () => {
    expect(finishOf(proof(NOW, 60_000))?.kind).toBe("refused");
    expect(finishOf(proof(NOW, -60_000))?.kind).toBe("refused");
    expect(finishOf(proof(NOW, -60_001))?.kind).toBe("clock");
  });

  test("(b) the SAME 401 after E + S lapses the entry and drops its keys, exit 3, even with the clock still off", () => {
    for (const skew of [61_000, 150_000, -150_000]) {
      const step = proof(E + S, skew);
      expect(step.state.entry).toBeUndefined();
      expect(step.effects[0]).toMatchObject({ type: "purge", keys: ["relayPrivateKey"], entry: "remove" });
      expect(finishOf(step)).toMatchObject({ kind: "lapsed" });
      expect(exitCodeOf(finishOf(step)!)).toBe(3);
    }
    // One millisecond before E + S it is still the clock case.
    expect(finishOf(proof(E + S - 1, 150_000))?.kind).toBe("clock");
  });

  test("(c) a sane clock (<= 60 s) drops the entry and its keys at once, exit 5", () => {
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
    const held = proof(E + S + 1, 90_000, "discovered");
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
});
