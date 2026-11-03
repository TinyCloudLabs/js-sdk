import { describe, expect, test } from "bun:test";
import {
  APPROVAL_POLL_INTERVAL_MS,
  exitCodeOf,
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
import { E, PHASES, R, RESULT_EXPIRES, RESULT_REF, S, SECRET_STRINGS, T0, entryIn } from "./approval-machine-fixtures.js";

// Property-style tests: seeded random walks over EVERY event the machine accepts, from every phase. Fixed seed: a failure
// is reproducible, and the walks are deterministic across runs and machines.

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const CODES: readonly ReplyCode[] = ["expired_request", "expired_result", "acknowledged", "not_found", "ack_conflict", "request_binding", "invalid_proof", "invalid_request", "invalid_ack", "request_denied", "unknown"];
const CALLS = ["discover", "fetch", "ack"] as const;
const SKEWS: readonly (number | undefined)[] = [undefined, 0, 10_000, 44_000, 46_000, -46_000, 59_000, 61_000, -61_000, 600_000];

function randomReply(random: () => number): Reply {
  switch (Math.floor(random() * 7)) {
    case 0: return { kind: "pending" };
    case 1: return { kind: "ready", resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES };
    case 2: return { kind: "envelope", envelope: { relay: "opaque" } };
    case 3: return { kind: "acked" };
    case 4: return { kind: "network" };
    case 5: return { kind: "malformed", call: pick(random, CALLS) };
    default: return { kind: "error", call: pick(random, CALLS), status: 400, code: pick(random, CODES) };
  }
}

function randomEvent(random: () => number, now: number): Event {
  switch (Math.floor(random() * 9)) {
    case 0: return { type: "tick", now };
    case 1: return { type: "verdict", now, verdict: pick(random, ["ok", "refused", "clock", "ended"] as const) };
    case 2: return { type: "committed", now, ...(random() < 0.3 ? { retainUntil: now + 600_000 } : {}) };
    case 3: return { type: "abandon", now, reason: pick(random, ["rotate-key", "key-sweep", "logout", "superseded"] as const) };
    default: {
      const skew = pick(random, SKEWS);
      return { type: "reply", now, reply: randomReply(random), ...(skew === undefined ? {} : { serverDateSkewMs: skew }) };
    }
  }
}

/** Times worth hitting: around E, E+S, the purge time, and ordinary poll steps. */
function nextNow(random: () => number, now: number): number {
  switch (Math.floor(random() * 8)) {
    case 0: return E - 1 + Math.floor(random() * 3);
    case 1: return E + S - 1 + Math.floor(random() * 3);
    case 2: return E + R + S - 1 + Math.floor(random() * 3);
    case 3: return Math.max(now, T0 + Math.floor(random() * (E + 2 * R - T0)));
    default: return now + Math.floor(random() * 5_000);
  }
}

const hasKeys = (state: RequesterState): boolean => state.entry?.keys !== undefined;
const nextEffectOf = (step: Step): Effect => step.effects[step.effects.length - 1]!;
const finish = (step: Step) => { const last = nextEffectOf(step); return last.type === "finish" ? last.outcome : undefined; };

/** One event: the event is applied to the previous state and every invariant that is local to one step is checked. */
function checkStep(before: RequesterState, event: Event, step: Step, violations: string[]): void {
  const prev = before.entry;
  const after = step.state.entry;
  const label = `${prev?.phase ?? "dropped"} + ${JSON.stringify(event)}`;
  const require = (ok: boolean, rule: string) => { if (!ok) violations.push(`${rule}: ${label}`); };
  // 6. write-before-act
  require(after === prev || ["persist", "purge"].includes(step.effects[0]!.type), "write-before-act");
  // exactly one next effect, last
  require(["call", "sleep", "verify", "commit", "finish"].includes(nextEffectOf(step).type), "one next effect");
  // never a key in any effect or outcome
  const text = JSON.stringify(step.effects);
  require(SECRET_STRINGS.every((secret) => !text.includes(secret)), "no key in effects");
  if (prev === undefined) return;
  // 1. no key past purge
  // (D-1) the purge time wins over EVERY event type, not only a tick: a run that is still live has no key at or past purgeAt
  require(!((before.settled === undefined || event.type === "start") && event.now >= purgeAt(prev)) || after?.keys === undefined, "no key past purge");
  // acked never holds a key
  require(after?.phase !== "acked" || after.keys === undefined, "acked holds no key");
  // 5. committed is monotone
  require(prev.phase !== "committed" || after === undefined || after.phase === "committed" || after.phase === "acked", "committed is monotone");
  // 2. exit 8 carries expiresAt and confirmedLiveAt, and only while the request is live
  const outcome = finish(step);
  if (outcome?.kind === "pending") {
    require(outcome.expiresAt === E && outcome.confirmedLiveAt > 0 && event.now < E && exitCodeOf(outcome) === 8, "pending needs expiry, liveness, now < E");
    // 2b. never from an invalid_proof
    require(!(event.type === "reply" && event.reply.kind === "error" && event.reply.code === "invalid_proof"), "no pending from invalid_proof");
  }
  // 4. no approval lost: an entry at or past `discovered` is dropped only by a named rule
  if (before.settled === undefined && prev.phase !== "open" && after === undefined) {
    require(
      event.type === "abandon" ||
        event.now >= purgeAt(prev) ||
        (event.type === "verdict" && (event.verdict === "refused" || event.verdict === "ended")) ||
        (event.type === "reply" && (event.reply.kind === "acked" ||
          (event.reply.kind === "error" && (
            (event.reply.call === "fetch" && ["not_found", "expired_result", "acknowledged", "request_binding"].includes(event.reply.code)) ||
            (event.reply.call === "ack" && ["not_found", "acknowledged", "expired_result", "ack_conflict"].includes(event.reply.code)))))),
      "no approval lost",
    );
  }
}

describe("random walks over every event from every phase", () => {
  test("10,000 walks keep every per-step invariant", () => {
    const random = rng(0x2377);
    const violations: string[] = [];
    for (let walk = 0; walk < 10_000; walk++) {
      const phase = pick(random, PHASES);
      let state: RequesterState = requesterState(entryIn(phase, { staged: random() < 0.5 && phase !== "committed" && phase !== "acked" }));
      let now = T0 + Math.floor(random() * 120_000);
      const deadline = random() < 0.5 ? now + Math.floor(random() * 30_000) : undefined;
      const started: Event = { type: "start", now, ...(deadline === undefined ? {} : { deadline }), ...(random() < 0.3 ? { createdThisRun: true } : {}) };
      const start = reduce(state, started);
      checkStep(state, started, start, violations);
      state = start.state;
      for (let step = 0; step < 30; step++) {
        now = nextNow(random, now);
        const event = randomEvent(random, now);
        const result = reduce(state, event);
        checkStep(state, event, result, violations);
        // 7. a settled state is final: the same event again is a no-op with the same finish
        if (result.state.settled !== undefined) {
          const again = reduce(result.state, event);
          if (again.state !== result.state || JSON.stringify(finish(again)) !== JSON.stringify(result.state.settled)) violations.push(`settled is final: ${JSON.stringify(event)}`);
          break;
        }
        state = result.state;
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });

  test("a clock hold or a failed ack never drops anything but keys the machine itself scrubs", () => {
    const random = rng(7);
    for (let walk = 0; walk < 2_000; walk++) {
      const entry = entryIn(pick(random, ["open", "discovered", "fetched", "committed"] as const), { staged: true });
      const state = requesterState(entry);
      const event: Event = random() < 0.5
        ? { type: "reply", now: T0 + 1_000, reply: { kind: "network" } }
        : { type: "reply", now: T0 + 1_000, reply: { kind: "malformed", call: entry.phase === "open" ? "discover" : entry.phase === "discovered" ? "fetch" : "ack" } };
      const step = reduce(state, event);
      if (step.state.entry !== undefined) expect(step.state.entry.keys).toEqual(entry.keys);
    }
  });
});

describe("termination: nothing loops past E + S", () => {
  /** Drive the machine with replies that never resolve the request; every call takes `callMs`. */
  function drive(options: { readonly deadline?: number; readonly startAt: number; readonly reply: (random: () => number) => Reply; readonly callMs: number; readonly seed: number }) {
    const random = rng(options.seed);
    let now = options.startAt;
    let step = reduce(requesterState(entryIn("open")), { type: "start", now, ...(options.deadline === undefined ? {} : { deadline: options.deadline }) });
    let iterations = 0;
    let calls = 0;
    for (;;) {
      const effect = nextEffectOf(step);
      if (effect.type === "finish") return { outcome: effect.outcome, now, iterations, calls, step };
      if (++iterations > 100_000) throw new Error("did not terminate");
      if (effect.type === "sleep") {
        now += effect.ms;
        step = reduce(step.state, { type: "tick", now });
      } else if (effect.type === "call") {
        calls++;
        now += options.callMs;
        step = reduce(step.state, { type: "reply", now, reply: options.reply(random) });
      } else throw new Error(`unexpected effect ${effect.type}`);
    }
  }
  const never: ((random: () => number) => Reply)[] = [
    () => ({ kind: "pending" }),
    () => ({ kind: "network" }),
    () => ({ kind: "error", call: "discover", status: 502, code: "unknown" }),
    (random) => (random() < 0.5 ? { kind: "pending" } : { kind: "network" }),
  ];

  test("without a caller deadline, a run that gets no answer ends by E + S plus two calls", () => {
    for (const [index, reply] of never.entries()) {
      for (const callMs of [0, 150, 10_000]) {
        const { outcome, now } = drive({ startAt: T0, reply, callMs, seed: index });
        expect(["pending", "unreachable", "unexpected", "clock"]).toContain(outcome.kind);
        expect(now).toBeLessThanOrEqual(E + S + 2 * callMs + APPROVAL_POLL_INTERVAL_MS);
      }
    }
  });

  test("a run that starts after E + S makes exactly one (settle) call", () => {
    const { iterations, outcome } = drive({ startAt: E + S + 5_000, reply: () => ({ kind: "pending" }), callMs: 100, seed: 1 });
    expect(iterations).toBe(1);
    expect(outcome.kind).toBe("unexpected");
  });

  test("with a deadline, the run ends at the deadline (plus the first check), pending only if OpenKey said live", () => {
    const deadline = T0 + 20_000;
    const live = drive({ startAt: T0, deadline, reply: () => ({ kind: "pending" }), callMs: 100, seed: 3 });
    expect(live.outcome).toMatchObject({ kind: "pending", expiresAt: E });
    expect(live.now).toBeLessThanOrEqual(deadline + APPROVAL_POLL_INTERVAL_MS);
    const dark = drive({ startAt: T0, deadline, reply: () => ({ kind: "network" }), callMs: 100, seed: 3 });
    expect(dark.outcome.kind).toBe("unreachable");
    expect(exitCodeOf(dark.outcome)).toBe(6);
  });

  test("five unexpected replies in a row end the run with exit 7, the entry kept", () => {
    const { outcome, calls, step } = drive({ startAt: T0, reply: () => ({ kind: "error", call: "discover", status: 500, code: "unknown" }), callMs: 100, seed: 4 });
    expect(outcome.kind).toBe("unexpected");
    expect(exitCodeOf(outcome)).toBe(7);
    expect(calls).toBe(5);
    expect(step.state.entry).toBeDefined();
  });
});

describe("no unmapped reply reaches keep-forever", () => {
  test("every (call x code x phase) either ends the run, drops, or is bounded by the purge time", () => {
    for (const call of CALLS) {
      for (const code of CODES) {
        for (const phase of PHASES) {
          const entry = entryIn(phase);
          const step = reduce({ entry, run: { unexpectedStreak: 4, firstCheckDone: true, finalPoll: false, collectUntil: T0 + 90_000 } }, {
            type: "reply", now: T0 + 60_000, reply: { kind: "error", call, status: 400, code },
          });
          // A kept entry must be reachable by a tick at its purge time; that is the bound on `keep`.
          if (step.state.entry !== undefined) {
            const purged = reduce({ entry: step.state.entry, run: { unexpectedStreak: 0, firstCheckDone: true, finalPoll: false } }, { type: "tick", now: purgeAt(step.state.entry) });
            expect(purged.state.entry).toBeUndefined();
            expect(purged.state.entry === undefined && hasKeys(purged.state)).toBe(false);
          }
        }
      }
    }
  });
});

test("the phase of every fixture is one of the five", () => {
  const seen: ApprovalPhase[] = PHASES.map((phase) => entryIn(phase).phase);
  expect(seen).toEqual(["open", "discovered", "fetched", "committed", "acked"]);
});
