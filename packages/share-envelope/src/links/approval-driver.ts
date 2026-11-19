/**
 * The effect runner of the approval requester machine: the ONE loop that polls, sleeps, fetches, verifies, commits and
 * acknowledges. Everything it touches is injected (clock, sleep, store, OpenKey transport, the caller's verification and
 * durable commit), so it runs unchanged in the CLI, in Courier and in tests, and it has no file system of its own.
 *
 * Write-before-act: `reduce` returns `persist`/`purge` effects BEFORE the next effect, and this loop performs them in order, so
 * a crash between any two steps resumes from the stored entry. The driver never logs, prints or copies an entry; the entry only
 * goes to the store, the transport and the caller's `verify`/`commit`.
 */
import {
  reduce,
  requesterState,
  exitCodeOf,
  type ApprovalVerdict,
  type Event,
  type Outcome,
  type Reply,
  type RequesterState,
  type Step,
} from "./approval-requester.js";
import type { ApprovalEntry } from "./approval-entry.js";
import { APPROVAL_REQUEST_TIMEOUT_MS } from "./constants.js";

const MIN_CALL_TIMEOUT_MS = 1000;

export interface ApprovalStore {
  /** The stored entry, or `undefined` when there is none (the adapter owns the file, the lock and the format version). */
  read(requestId: string): Promise<ApprovalEntry | undefined>;
  /** Write the entry durably (atomic, 0600). */
  write(entry: ApprovalEntry): Promise<void>;
  /** Delete the entry. */
  remove(requestId: string): Promise<void>;
}

export interface CallOptions {
  /** The request must end within this many milliseconds. */
  readonly timeoutMs: number;
}
export interface CallResult {
  readonly reply: Reply;
  /** Local clock minus the reply's HTTP `Date` header at receipt (see `callApproval`). */
  readonly serverDateSkewMs?: number;
}
/** Each call reads what it needs (result reference, ack id, keys to sign with) from the entry; `callApproval` does the wire work. */
export interface ApprovalTransport {
  discover(entry: ApprovalEntry, options: CallOptions): Promise<CallResult>;
  fetch(entry: ApprovalEntry, options: CallOptions): Promise<CallResult>;
  ack(entry: ApprovalEntry, options: CallOptions): Promise<CallResult>;
}

export interface ApprovalDriverIo {
  readonly store: ApprovalStore;
  readonly transport: ApprovalTransport;
  /** The caller's local verification of the fetched, still-encrypted result. */
  verify(entry: ApprovalEntry): Promise<ApprovalVerdict>;
  /** Save the grant durably (the profile, the session). Resolves with `retainUntil` to keep a key-free entry after the ack. */
  commit(entry: ApprovalEntry): Promise<{ readonly retainUntil?: number } | void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  readonly signal?: AbortSignal;
}

export interface DriveOptions {
  /** The caller's `--timeout` / `--wait`, epoch ms. Without it a run still ends by `E + S`. */
  readonly deadline?: number;
  /** The links API just answered 201 for this request in this run. */
  readonly createdThisRun?: boolean;
}

export interface DriveResult {
  readonly outcome: Outcome;
  readonly exitCode: number;
  /** The entry as it stays in the store, when the outcome keeps it. Holds private keys: never print it. */
  readonly entry: ApprovalEntry | undefined;
}

/**
 * Run one request to the end of this run: until it completes, is dropped, or has to stop (deadline, clock, unexpected). Errors
 * thrown by `verify`, `commit`, the store or an aborted call propagate; the stored entry is as the last `persist` left it.
 */
export async function driveApproval(io: ApprovalDriverIo, requestId: string, options: DriveOptions = {}): Promise<DriveResult> {
  const entry = await io.store.read(requestId);
  if (entry === undefined) return { outcome: { kind: "internal", reason: "missing-entry" }, exitCode: 7, entry: undefined };
  let step = reduce(requesterState(entry), {
    type: "start", now: io.now(), ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.createdThisRun === true ? { createdThisRun: true } : {}),
  });
  for (;;) {
    const next = await perform(io, step);
    if ("outcome" in next) return { outcome: next.outcome, exitCode: exitCodeOf(next.outcome), entry: step.state.entry };
    step = reduce(step.state, next.event);
  }
}

async function perform(io: ApprovalDriverIo, step: Step): Promise<{ readonly event: Event } | { readonly outcome: Outcome }> {
  const state: RequesterState = step.state;
  let next: { readonly event: Event } | { readonly outcome: Outcome } | undefined;
  for (const effect of step.effects) {
    switch (effect.type) {
      case "persist": await io.store.write(state.entry!); break;
      case "purge": if (effect.entry === "remove") await io.store.remove(effect.requestId); else await io.store.write(state.entry!); break;
      case "finish": return { outcome: effect.outcome };
      case "sleep":
        await io.sleep(effect.ms);
        if (io.signal?.aborted) throw io.signal.reason;
        next = { event: { type: "tick", now: io.now() } };
        break;
      case "call": {
        const entry = state.entry!;
        const bound = effect.firstCheck || effect.until === undefined ? APPROVAL_REQUEST_TIMEOUT_MS
          : Math.min(APPROVAL_REQUEST_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, effect.until - io.now()));
        const result = await io.transport[effect.call](entry, { timeoutMs: bound });
        next = { event: { type: "reply", now: io.now(), reply: result.reply, ...(result.serverDateSkewMs === undefined ? {} : { serverDateSkewMs: result.serverDateSkewMs }) } };
        break;
      }
      case "verify": next = { event: { type: "verdict", now: io.now(), verdict: await io.verify(state.entry!) } }; break;
      case "commit": {
        const saved = await io.commit(state.entry!);
        next = { event: { type: "committed", now: io.now(), ...(saved?.retainUntil === undefined ? {} : { retainUntil: saved.retainUntil }) } };
        break;
      }
    }
  }
  if (next === undefined) throw new Error("the machine returned no next effect");
  return next;
}
