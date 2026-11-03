/**
 * The ONE state machine of an approval-request requester (the CLI and Courier both adopt it; see `README.md`).
 *
 * `reduce(state, event) -> { state, effects }` is PURE: no clock, no randomness, no I/O, no storage. Time and the measured
 * clock skew enter only as event fields. The driver (`approval-driver.ts`) runs the effects. Every step ends with exactly one
 * NEXT effect (`call`, `sleep`, `verify`, `commit` or `finish`); `persist`/`purge` effects come first, so the state is durable
 * BEFORE the next I/O (write-before-act), and an entry that is dropped is always accompanied by a `purge` of the keys it held.
 *
 * A pending entry holds PRIVATE KEYS. Effects and outcomes carry request ids and key NAMES only, never a key, and `reduce`
 * never throws or formats an entry into a message.
 */
import type { ApprovalAction } from "./approval-client.js";
import {
  APPROVAL_CLOCK_SKEW_MS,
  CLOCK_DISAGREEMENT_MS,
  COLLECT_GRACE_MS,
  MAX_UNEXPECTED_REPLIES,
  heldKeys,
  localExpiry,
  purgeAt,
  type ApprovalEntry,
  type ApprovalKeyName,
  type ApprovalPhase,
} from "./approval-entry.js";
import { APPROVAL_POLL_INTERVAL_MS } from "./constants.js";

// ---------------------------------------------------------------------------------------------------------------
// Replies: what OpenKey said, classified by `classifyReply` (approval-client.ts)

export type ReplyCode =
  | "expired_request" | "expired_result" | "acknowledged" | "not_found" | "ack_conflict"
  | "request_binding" | "invalid_proof" | "invalid_request" | "invalid_ack"
  /** HTTP 410 `expired_request` + `status:"denied"`, or the code `request_denied`: the owner declined. */
  | "request_denied"
  | "unknown";

export type Reply =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly resultRef: string; readonly resultExpiresAt: string }
  | { readonly kind: "envelope"; readonly envelope: unknown }
  | { readonly kind: "acked" }
  /** No answer: DNS, connection, or the request limit. */
  | { readonly kind: "network" }
  /** A 2xx whose body does not have the expected shape or binding. */
  | { readonly kind: "malformed"; readonly call: ApprovalAction }
  | { readonly kind: "error"; readonly call: ApprovalAction; readonly status: number; readonly code: ReplyCode };

// ---------------------------------------------------------------------------------------------------------------
// Events, effects, outcomes

export type AbandonReason = "rotate-key" | "key-sweep" | "logout" | "superseded";
/** The caller's local verification of the opened result. */
export type ApprovalVerdict = "ok" | "refused" | "clock" | "ended";

export type Event =
  /** Begin a run. `deadline` is the caller's `--timeout`; `createdThisRun`: the links API just answered 201 (the request is live). */
  | { readonly type: "start"; readonly now: number; readonly deadline?: number; readonly createdThisRun?: boolean }
  | { readonly type: "tick"; readonly now: number }
  /** `serverDateSkewMs`: local clock minus the reply's HTTP `Date` header, at receipt; absent when there was no usable header. */
  | { readonly type: "reply"; readonly now: number; readonly reply: Reply; readonly serverDateSkewMs?: number }
  | { readonly type: "verdict"; readonly now: number; readonly verdict: ApprovalVerdict }
  /** The caller saved the grant durably. `retainUntil`: keep a key-free `acked` entry until then (CLI command entries). */
  | { readonly type: "committed"; readonly now: number; readonly retainUntil?: number }
  | { readonly type: "abandon"; readonly now: number; readonly reason: AbandonReason };

export type GrantMayBeLive = "yes" | "maybe" | "no";

/** The end of a run. The adapter prints it and exits with `exitCodeOf(outcome)`; the entry is gone unless the outcome keeps it (see `stopped`). */
export type Outcome =
  | { readonly kind: "completed"; readonly warning?: "ack-pending" | "ack-conflict" }
  /** Exit 8: OpenKey confirmed the request live in this run, and `now < expiresAt`. */
  | { readonly kind: "pending"; readonly expiresAt: number; readonly confirmedLiveAt: number }
  | { readonly kind: "unreachable"; readonly expiresAt: number; readonly resultExpiresAt?: number }
  | { readonly kind: "unexpected" }
  | { readonly kind: "lapsed"; readonly reason: "expired_request" | "not_found" | "proof_after_expiry" | "purged"; readonly grantMayBeLive: "no" }
  | { readonly kind: "gone"; readonly reason: "expired_result" | "not_found" | "acknowledged" | "ended" | "purged"; readonly grantMayBeLive: "yes" }
  | { readonly kind: "refused"; readonly reason: "request_binding" | "request_invalid" | "proof" | "verification"; readonly grantMayBeLive: GrantMayBeLive }
  | { readonly kind: "denied" }
  /** Exit 12: the local clock disagrees with OpenKey's by more than 60 s. The entry is kept. */
  | { readonly kind: "clock"; readonly skewMs?: number }
  | { readonly kind: "abandoned"; readonly reason: AbandonReason; readonly grantMayBeLive: GrantMayBeLive }
  | { readonly kind: "internal"; readonly reason: "illegal-event" | "missing-entry" };

export type Effect =
  /** Write `state.entry` durably. */
  | { readonly type: "persist" }
  /** The keys named were destroyed. `remove`: delete the entry from the store. `rewrite`: write `state.entry`, which no longer holds them. */
  | { readonly type: "purge"; readonly requestId: string; readonly keys: readonly ApprovalKeyName[]; readonly entry: "remove" | "rewrite" }
  /**
   * Make the OpenKey call. `firstCheck`: the first discover of the run gets the full request limit, however late. `settle`: the one
   * last poll at `E + S`. `until`: the call must end by then (epoch ms); absent means the full request limit.
   */
  | { readonly type: "call"; readonly call: ApprovalAction; readonly firstCheck: boolean; readonly settle: boolean; readonly until?: number }
  | { readonly type: "sleep"; readonly ms: number }
  | { readonly type: "verify" }
  | { readonly type: "commit" }
  | { readonly type: "finish"; readonly outcome: Outcome };

/** Facts of this run only; never persisted. */
export interface RunContext {
  /** Set when OpenKey confirmed the request live in THIS run (the 201 that created it, or any 202). */
  readonly confirmedLiveAt?: number;
  readonly unexpectedStreak: number;
  readonly deadline?: number;
  /** The first discover of the run has been answered (or has failed). */
  readonly firstCheckDone: boolean;
  /** The settle poll at `E + S` has been issued. */
  readonly finalPoll: boolean;
  /** How long an approved result may still be fetched in this run. */
  readonly collectUntil?: number;
}

export interface LiveState {
  readonly entry: ApprovalEntry;
  readonly run: RunContext;
  readonly settled?: undefined;
}
/** The run ended. `entry` is undefined when it was dropped; a stopped run keeps its entry. */
export interface SettledState {
  readonly entry: ApprovalEntry | undefined;
  readonly run: RunContext;
  readonly settled: Outcome;
}
export type RequesterState = LiveState | SettledState;
export interface Step {
  readonly state: RequesterState;
  readonly effects: readonly Effect[];
}

/** A state ready for a `start` event. */
export function requesterState(entry: ApprovalEntry): LiveState {
  return { entry, run: { unexpectedStreak: 0, firstCheckDone: false, finalPoll: false } };
}

// ---------------------------------------------------------------------------------------------------------------
// The exit table

/** One exit number per outcome. Image: {0,3,5,6,7,8,11,12}; 9, 10 and 126..130 belong to other commands and are never used. */
export const APPROVAL_EXIT: Readonly<Record<Outcome["kind"], 0 | 3 | 5 | 6 | 7 | 8 | 11 | 12>> = {
  completed: 0,
  /** The caller removed the request itself; the number is only used if a caller prints it. */
  abandoned: 3,
  lapsed: 3,
  gone: 3,
  refused: 5,
  unreachable: 6,
  unexpected: 7,
  internal: 7,
  pending: 8,
  denied: 11,
  clock: 12,
};

export function exitCodeOf(outcome: Outcome): number {
  return APPROVAL_EXIT[outcome.kind];
}

// ---------------------------------------------------------------------------------------------------------------
// The one code -> action table

export type Rule =
  | { readonly id: string; readonly act: "lapse"; readonly reason: "expired_request" | "not_found" }
  | { readonly id: string; readonly act: "gone"; readonly reason: "expired_result" | "not_found" | "acknowledged" }
  | { readonly id: string; readonly act: "refuse"; readonly reason: "request_binding" | "request_invalid"; readonly grantMayBeLive: GrantMayBeLive }
  | { readonly id: string; readonly act: "denied" }
  /** 401 `invalid_proof` is AMBIGUOUS (clock skew, wrong binding, an expired request seen through a skewed clock). */
  | { readonly id: string; readonly act: "proof" }
  | { readonly id: string; readonly act: "ack-done"; readonly warning?: "ack-conflict" };

/**
 * Keyed `<call>:<code>`. Everything NOT listed is an unmapped reply: on discover/fetch it counts toward `unexpected` (5 in a
 * row ends the run, exit 7, entry kept until its purge time); on ack the grant is already saved, so the run completes with an
 * `ack-pending` warning. A 400 `invalid_request` on discover is a refusal of the request, NEVER an expiry: only 410
 * `expired_request` lapses it.
 */
export const RULES: Readonly<Record<string, Rule>> = {
  "discover:expired_request": { id: "T4", act: "lapse", reason: "expired_request" },
  "discover:request_denied": { id: "T5", act: "denied" },
  "discover:invalid_request": { id: "T6", act: "refuse", reason: "request_invalid", grantMayBeLive: "no" },
  "discover:not_found": { id: "T8", act: "lapse", reason: "not_found" },
  "discover:expired_result": { id: "T10", act: "gone", reason: "expired_result" },
  "discover:request_binding": { id: "T12", act: "refuse", reason: "request_binding", grantMayBeLive: "maybe" },
  "discover:invalid_proof": { id: "T14", act: "proof" },
  "fetch:not_found": { id: "T9", act: "gone", reason: "not_found" },
  "fetch:expired_result": { id: "T10", act: "gone", reason: "expired_result" },
  "fetch:acknowledged": { id: "T11", act: "gone", reason: "acknowledged" },
  "fetch:request_binding": { id: "T13", act: "refuse", reason: "request_binding", grantMayBeLive: "yes" },
  "fetch:invalid_proof": { id: "T14", act: "proof" },
  "ack:not_found": { id: "T23", act: "ack-done" },
  "ack:acknowledged": { id: "T23", act: "ack-done" },
  "ack:expired_result": { id: "T23", act: "ack-done" },
  "ack:ack_conflict": { id: "T24", act: "ack-done", warning: "ack-conflict" },
};

// ---------------------------------------------------------------------------------------------------------------
// Steps

const CALL_OF_PHASE: Readonly<Record<ApprovalPhase, ApprovalAction | undefined>> = {
  open: "discover", discovered: "fetch", fetched: undefined, committed: "ack", acked: undefined,
};
const S = APPROVAL_CLOCK_SKEW_MS;
const CALL_BOUND_SLACK_MS = 1000;
const isoOf = (ms: number): string => new Date(ms).toISOString();
/** A clock value `Date` can represent: `NaN`, infinities and out-of-range numbers are illegal events, never exceptions. */
const validTime = (ms: number): boolean => Number.isFinite(new Date(ms).getTime());
const clockOff = (skewMs: number | undefined): boolean => skewMs !== undefined && Math.abs(skewMs) > CLOCK_DISAGREEMENT_MS;

function replyCall(reply: Reply, phase: ApprovalPhase): ApprovalAction | undefined {
  switch (reply.kind) {
    case "pending": case "ready": return "discover";
    case "envelope": return "fetch";
    case "acked": return "ack";
    case "network": return CALL_OF_PHASE[phase];
    default: return reply.call;
  }
}

function settle(entry: ApprovalEntry | undefined, run: RunContext, outcome: Outcome, before: readonly Effect[] = []): Step {
  return { state: { entry, run, settled: outcome }, effects: [...before, { type: "finish", outcome }] };
}

/** The run ends and the entry stays (kept-by-clock, pending, unreachable, unexpected, an ack warning). */
function stopKeep(live: LiveState, outcome: Outcome, entry: ApprovalEntry = live.entry): Step {
  return settle(entry, live.run, outcome, entry === live.entry ? [] : [{ type: "persist" }]);
}

/** The run ends and the entry is REMOVED with every key it held. */
function drop(live: LiveState, outcome: Outcome): Step {
  return settle(undefined, live.run, outcome, [{ type: "purge", requestId: live.entry.requestId, keys: heldKeys(live.entry), entry: "remove" }]);
}

const illegal = (live: LiveState): Step => settle(live.entry, live.run, { kind: "internal", reason: "illegal-event" });

function unreachable(entry: ApprovalEntry): Outcome {
  return {
    kind: "unreachable", expiresAt: localExpiry(entry),
    ...(entry.resultExpiresAt === undefined ? {} : { resultExpiresAt: Date.parse(entry.resultExpiresAt) }),
  };
}

/** Pending (exit 8) ONLY while OpenKey confirmed the request live in this run and the signed expiry has not passed. */
function deadlineOutcome(live: LiveState, now: number): Outcome {
  const expiresAt = localExpiry(live.entry);
  return live.run.confirmedLiveAt !== undefined && now < expiresAt
    ? { kind: "pending", expiresAt, confirmedLiveAt: live.run.confirmedLiveAt }
    : unreachable(live.entry);
}

function holdClock(live: LiveState, now: number, skewMs: number | undefined): Step {
  const held: ApprovalEntry = { ...live.entry, hold: { kind: "clock", since: isoOf(now) } };
  return stopKeep(live, { kind: "clock", ...(skewMs !== undefined && Number.isFinite(skewMs) ? { skewMs } : {}) }, held);
}

function dropPurged(live: LiveState): Step {
  switch (live.entry.phase) {
    case "open": return drop(live, { kind: "lapsed", reason: "purged", grantMayBeLive: "no" });
    case "acked": return drop(live, { kind: "completed" });
    default: return drop(live, { kind: "gone", reason: "purged", grantMayBeLive: "yes" });
  }
}

const sleepFor = (now: number, ...bounds: number[]): Effect =>
  ({ type: "sleep", ms: Math.max(0, Math.min(APPROVAL_POLL_INTERVAL_MS, ...bounds.map((bound) => bound - now))) });

/** The next call of an `open` entry: the first check, the settle poll at `E + S`, or an ordinary poll bounded by the deadline. */
function openCall(live: LiveState, now: number): Step {
  const { entry, run } = live;
  const first = !run.firstCheckDone;
  if (now >= localExpiry(entry) + S) {
    return { state: { entry, run: { ...run, finalPoll: true } }, effects: [{ type: "call", call: "discover", firstCheck: first, settle: true }] };
  }
  if (!first && run.deadline !== undefined && now >= run.deadline) return stopKeep(live, deadlineOutcome(live, now));
  if (first) return { state: live, effects: [{ type: "call", call: "discover", firstCheck: true, settle: false }] };
  return {
    state: live,
    effects: [{ type: "call", call: "discover", firstCheck: false, settle: false, ...(run.deadline === undefined ? {} : { until: run.deadline + CALL_BOUND_SLACK_MS }) }],
  };
}

/** What the machine asks for next when no reply is pending: the purge check, then the call for the entry's phase. */
function beforeCall(live: LiveState, now: number): Step {
  const { entry, run } = live;
  if (now >= purgeAt(entry)) return dropPurged(live);
  switch (entry.phase) {
    case "open": return openCall(live, now);
    case "discovered": {
      const collectUntil = run.collectUntil ?? Math.max(run.deadline ?? now, now) + COLLECT_GRACE_MS;
      const next: LiveState = { entry, run: { ...run, collectUntil } };
      if (now >= collectUntil) return stopKeep(next, unreachable(entry));
      return { state: next, effects: [{ type: "call", call: "fetch", firstCheck: false, settle: false, until: collectUntil }] };
    }
    case "fetched": return { state: live, effects: [{ type: "verify" }] };
    case "committed": return { state: live, effects: [{ type: "call", call: "ack", firstCheck: false, settle: false }] };
    case "acked": return stopKeep(live, { kind: "completed" });
  }
}

/** `beforeCall` after the entry changed: the change is persisted first, unless the entry is being dropped. */
function advance(previous: ApprovalEntry, live: LiveState, now: number): Step {
  const step = beforeCall(live, now);
  if (step.state.entry === undefined || step.state.entry === previous) return step;
  return step.effects.some((effect) => effect.type === "purge") ? step : { state: step.state, effects: [{ type: "persist" }, ...step.effects] };
}

type Failure = "pending" | "network" | "unexpected";

/** An `open` poll that did not end the request: stop, settle, or sleep. */
function afterOpenPoll(live: LiveState, now: number, why: Failure): Step {
  const { entry, run } = live;
  if (run.finalPoll) return stopKeep(live, why === "network" ? unreachable(entry) : { kind: "unexpected" });
  if (why === "unexpected" && run.unexpectedStreak >= MAX_UNEXPECTED_REPLIES) return stopKeep(live, { kind: "unexpected" });
  if (run.deadline !== undefined && now >= run.deadline) return stopKeep(live, deadlineOutcome(live, now));
  if (now >= localExpiry(entry) + S) return openCall(live, now);
  return { state: live, effects: [sleepFor(now, localExpiry(entry) + S, run.deadline ?? Number.POSITIVE_INFINITY)] };
}

/** A fetch that did not succeed: retry until the collect bound, never past it. */
function afterFetchFailure(live: LiveState, now: number, why: "network" | "unexpected"): Step {
  const { run } = live;
  if (why === "unexpected" && run.unexpectedStreak >= MAX_UNEXPECTED_REPLIES) return stopKeep(live, { kind: "unexpected" });
  const collectUntil = run.collectUntil ?? now;
  if (now >= collectUntil) return stopKeep(live, why === "network" ? unreachable(live.entry) : { kind: "unexpected" });
  return { state: live, effects: [sleepFor(now, collectUntil)] };
}

function onFailure(live: LiveState, now: number, why: "network" | "unexpected"): Step {
  const run: RunContext = {
    ...live.run,
    unexpectedStreak: why === "unexpected" ? live.run.unexpectedStreak + 1 : live.run.unexpectedStreak,
    firstCheckDone: live.run.firstCheckDone || live.entry.phase === "open",
  };
  const next: LiveState = { entry: live.entry, run };
  switch (live.entry.phase) {
    case "open": return afterOpenPoll(next, now, why);
    case "discovered": return afterFetchFailure(next, now, why);
    // The grant is saved: a failed ack never retries inside the run, never holds, never drops.
    case "committed": return stopKeep(next, { kind: "completed", warning: "ack-pending" });
    default: return illegal(live);
  }
}

function onPending(live: LiveState, now: number, skewMs: number | undefined): Step {
  const next: LiveState = { entry: live.entry, run: { ...live.run, confirmedLiveAt: now, unexpectedStreak: 0, firstCheckDone: true } };
  // OpenKey still serves a request the local clock says is long expired: the clocks disagree.
  if (live.run.finalPoll) return clockOff(skewMs) ? holdClock(next, now, skewMs) : stopKeep(next, { kind: "unexpected" });
  return afterOpenPoll(next, now, "pending");
}

function onReady(live: LiveState, now: number, reply: Extract<Reply, { kind: "ready" }>): Step {
  const entry: ApprovalEntry = { ...live.entry, phase: "discovered", resultRef: reply.resultRef, resultExpiresAt: reply.resultExpiresAt };
  const collectUntil = Math.max(live.run.deadline ?? now, now) + COLLECT_GRACE_MS;
  return advance(live.entry, { entry, run: { ...live.run, unexpectedStreak: 0, firstCheckDone: true, collectUntil } }, now);
}

function onEnvelope(live: LiveState, now: number, reply: Extract<Reply, { kind: "envelope" }>): Step {
  const entry: ApprovalEntry = { ...live.entry, phase: "fetched", resultEnvelope: reply.envelope };
  return advance(live.entry, { entry, run: { ...live.run, unexpectedStreak: 0 } }, now);
}

/** The ack settled (or was refused as already done): the entry is removed, or kept KEY-FREE until `retainUntil`. */
function onAckDone(live: LiveState, now: number, warning: "ack-conflict" | undefined): Step {
  const { entry } = live;
  const outcome: Outcome = warning === undefined ? { kind: "completed" } : { kind: "completed", warning };
  if (entry.retainUntil === undefined || Date.parse(entry.retainUntil) <= now) return drop(live, outcome);
  const acked: ApprovalEntry = { ...entry, phase: "acked" };
  delete acked.keys;
  delete acked.resultEnvelope;
  return settle(acked, live.run, outcome, [{ type: "purge", requestId: entry.requestId, keys: heldKeys(entry), entry: "rewrite" }]);
}

/** 401 `invalid_proof`: the clock case is kept by the clock, bounded by `E + S`; anything else is a permanent refusal. */
function onProof(live: LiveState, now: number, skewMs: number | undefined): Step {
  const { entry } = live;
  // The request itself has run out (a skewed clock hides that behind this same 401): lapsed, keys dropped.
  if (entry.phase === "open" && now >= localExpiry(entry) + S) return drop(live, { kind: "lapsed", reason: "proof_after_expiry", grantMayBeLive: "no" });
  if (clockOff(skewMs)) return holdClock(live, now, skewMs);
  return drop(live, { kind: "refused", reason: "proof", grantMayBeLive: entry.phase === "open" ? "maybe" : "yes" });
}

function onError(live: LiveState, now: number, reply: Extract<Reply, { kind: "error" }>, skewMs: number | undefined): Step {
  const rule = RULES[`${reply.call}:${reply.code}`];
  if (rule === undefined) return onFailure(live, now, "unexpected");
  switch (rule.act) {
    case "lapse": return drop(live, { kind: "lapsed", reason: rule.reason, grantMayBeLive: "no" });
    case "gone": return drop(live, { kind: "gone", reason: rule.reason, grantMayBeLive: "yes" });
    case "refuse": return drop(live, { kind: "refused", reason: rule.reason, grantMayBeLive: rule.grantMayBeLive });
    case "denied": return drop(live, { kind: "denied" });
    case "proof": return onProof(live, now, skewMs);
    case "ack-done": return onAckDone(live, now, rule.warning);
  }
}

function onReply(live: LiveState, event: Extract<Event, { type: "reply" }>): Step {
  const { reply, now } = event;
  const expected = CALL_OF_PHASE[live.entry.phase];
  if (expected === undefined || replyCall(reply, live.entry.phase) !== expected) return illegal(live);
  switch (reply.kind) {
    case "pending": return onPending(live, now, event.serverDateSkewMs);
    case "ready": return onReady(live, now, reply);
    case "envelope": return onEnvelope(live, now, reply);
    case "acked": return onAckDone(live, now, undefined);
    case "network": return onFailure(live, now, "network");
    case "malformed": return onFailure(live, now, "unexpected");
    case "error": return onError(live, now, reply, event.serverDateSkewMs);
  }
}

function onVerdict(live: LiveState, now: number, verdict: ApprovalVerdict): Step {
  if (live.entry.phase !== "fetched") return illegal(live);
  switch (verdict) {
    case "ok": return { state: live, effects: [{ type: "commit" }] };
    case "refused": return drop(live, { kind: "refused", reason: "verification", grantMayBeLive: "yes" });
    case "clock": return holdClock(live, now, undefined);
    case "ended": return drop(live, { kind: "gone", reason: "ended", grantMayBeLive: "yes" });
  }
}

function onCommitted(live: LiveState, now: number, retainUntil: number | undefined): Step {
  const { entry } = live;
  if (entry.phase !== "fetched" || entry.keys === undefined || (retainUntil !== undefined && !validTime(retainUntil))) return illegal(live);
  const committed: ApprovalEntry = {
    ...entry, phase: "committed", keys: { relayPrivateKey: entry.keys.relayPrivateKey },
    ...(retainUntil === undefined ? {} : { retainUntil: isoOf(retainUntil) }),
  };
  const next: LiveState = { entry: committed, run: { ...live.run, unexpectedStreak: 0 } };
  const step = advance(entry, next, now);
  // The staged signing key is scrubbed from the entry now that the grant is committed: the rewrite IS the purge.
  if (entry.keys.stagedSigningKey === undefined || step.state.entry === undefined) return step;
  const purge: Effect = { type: "purge", requestId: entry.requestId, keys: ["stagedSigningKey"], entry: "rewrite" };
  return { state: step.state, effects: [purge, ...step.effects.filter((effect) => effect.type !== "persist")] };
}

function onStart(state: RequesterState, event: Extract<Event, { type: "start" }>): Step {
  if (state.entry === undefined) return { state, effects: [{ type: "finish", outcome: state.settled! }] };
  // A new run retries a held entry: the hold is cleared (and persisted).
  let entry = state.entry;
  if (entry.hold !== undefined) {
    entry = { ...entry };
    delete entry.hold;
  }
  const run: RunContext = {
    unexpectedStreak: 0, firstCheckDone: false, finalPoll: false,
    ...(event.deadline === undefined ? {} : { deadline: event.deadline }),
    ...(event.createdThisRun === true ? { confirmedLiveAt: event.now } : {}),
  };
  return advance(state.entry, { entry, run }, event.now);
}

/**
 * The machine. Total: an event that is not legal in the entry's phase stops the run with an `internal` outcome and changes
 * nothing; it never throws.
 */
export function reduce(state: RequesterState, event: Event): Step {
  if (event.type === "start") return validTime(event.now) ? onStart(state, event) : settle(state.entry, state.run, { kind: "internal", reason: "illegal-event" });
  if (state.settled !== undefined) return { state, effects: [{ type: "finish", outcome: state.settled }] };
  if (!validTime(event.now)) return illegal(state);
  switch (event.type) {
    case "tick": return beforeCall(state, event.now);
    case "reply": return onReply(state, event);
    case "verdict": return onVerdict(state, event.now, event.verdict);
    case "committed": return onCommitted(state, event.now, event.retainUntil);
    case "abandon": return drop(state, { kind: "abandoned", reason: event.reason, grantMayBeLive: state.entry.phase === "open" ? "maybe" : "yes" });
  }
}
