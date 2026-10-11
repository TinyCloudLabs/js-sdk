import { HarnessError } from "./common";

export interface Clock {
  now(): number;
  wallNow(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  sleepUntilWall(epochMs: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(new HarnessError("ABORTED", String(signal.reason ?? "Aborted")));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new HarnessError("ABORTED", String(signal?.reason ?? "Aborted")));
    }
    signal?.addEventListener("abort", abort, { once: true });
    return promise;
  },
  async sleepUntilWall(epochMs, signal) {
    while (this.wallNow() < epochMs) await this.sleep(epochMs - this.wallNow(), signal);
  },
};

export async function waitFor<T>(clock: Clock, probe: () => Promise<T | undefined>,
  o: { deadlineMs: number; intervalMs?: number; describe: string; signal?: AbortSignal }): Promise<T> {
  const deadline = clock.now() + o.deadlineMs;
  let lastValue: T | undefined;
  while (clock.now() < deadline) {
    if (o.signal?.aborted) throw new HarnessError("ABORTED", String(o.signal.reason ?? "Aborted"));
    const timerController = new AbortController();
    const timerSignal = o.signal ? AbortSignal.any([o.signal, timerController.signal]) : timerController.signal;
    const remaining = deadline - clock.now();
    const timer = clock.sleep(remaining, timerSignal).then(() => ({ kind: "deadline" as const }));
    let outcome: { kind: "deadline" } | { kind: "probe"; value: T | undefined };
    try {
      outcome = await Promise.race([
        probe().then((value) => ({ kind: "probe" as const, value })),
        timer,
      ]);
    } finally {
      timerController.abort();
    }
    if (o.signal?.aborted) throw new HarnessError("ABORTED", String(o.signal.reason ?? "Aborted"));
    if (outcome.kind === "deadline" || clock.now() >= deadline) throw new HarnessError("DEADLINE_EXCEEDED", o.describe, { lastValue });
    lastValue = outcome.value;
    if (lastValue !== undefined) return lastValue;
    const sleepMs = Math.min(o.intervalMs ?? 100, deadline - clock.now());
    if (sleepMs > 0) await clock.sleep(sleepMs, o.signal);
  }
  throw new HarnessError("DEADLINE_EXCEEDED", o.describe, { lastValue });
}
