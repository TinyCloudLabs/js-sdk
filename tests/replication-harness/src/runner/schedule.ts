import type { Clock } from "../contracts/clock";
import type { ScenarioRow } from "./registry";

export type ScheduledResult<T> = { row: ScenarioRow; value: T };

/** Runs normal rows in bounded parallel batches, then speed rows alone, one at a time. */
export async function scheduleRows<T>(rows: readonly ScenarioRow[], concurrency: number,
  execute: (row: ScenarioRow) => Promise<T>): Promise<ScheduledResult<T>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  const results: ScheduledResult<T>[] = [];
  const normal = rows.filter((row) => row.tier !== "speed" && !row.scenario.speed);
  const speed = rows.filter((row) => row.tier === "speed" || row.scenario.speed);
  for (let index = 0; index < normal.length; index += concurrency) {
    const batch = normal.slice(index, index + concurrency);
    results.push(...await Promise.all(batch.map(async (row) => ({ row, value: await execute(row) }))));
  }
  for (const row of speed) results.push({ row, value: await execute(row) });
  return results;
}

export type TimedOutcome<T> = { value: T; timedOut: false } | { value?: T; timedOut: true; abandoned: boolean };

/** Deadline and grace use the injected clock; both wait timers are always cancelled. */
export async function runWithDeadline<T>(clock: Clock, timeoutMs: number, abortGraceMs: number,
  runSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<TimedOutcome<T>> {
  const controller = new AbortController();
  const signal = runSignal ? AbortSignal.any([runSignal, controller.signal]) : controller.signal;
  const scenario = Promise.resolve().then(() => execute(signal));
  scenario.catch(() => undefined);
  const deadlineController = new AbortController();
  const deadline = clock.sleep(timeoutMs, deadlineController.signal).then(() => ({ kind: "deadline" as const }));
  const aborted = Promise.withResolvers<{ kind: "abort" }>();
  const onAbort = () => aborted.resolve({ kind: "abort" });
  if (runSignal?.aborted) onAbort();
  else runSignal?.addEventListener("abort", onAbort, { once: true });
  let first: { kind: "settled"; value: T } | { kind: "deadline" | "abort" };
  try {
    first = await Promise.race([scenario.then((value) => ({ kind: "settled" as const, value })), deadline, aborted.promise]);
  } finally {
    deadlineController.abort();
    runSignal?.removeEventListener("abort", onAbort);
  }
  if (first.kind === "settled") return { value: first.value, timedOut: false };
  controller.abort(first.kind === "abort" ? runSignal?.reason ?? "ABORTED" : "DEADLINE_EXCEEDED");
  const graceController = new AbortController();
  const grace = clock.sleep(abortGraceMs, graceController.signal).then(() => ({ kind: "grace" as const }));
  const settled = await Promise.race([
    scenario.then((value) => ({ kind: "settled" as const, value }), () => ({ kind: "rejected" as const })), grace,
  ]);
  graceController.abort();
  if (settled.kind === "settled") return { value: settled.value, timedOut: true, abandoned: false };
  return { timedOut: true, abandoned: settled.kind === "grace" };
}
