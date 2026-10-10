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
    lastValue = await probe();
    if (clock.now() >= deadline) throw new HarnessError("DEADLINE_EXCEEDED", o.describe, { lastValue });
    if (lastValue !== undefined) return lastValue;
    const remaining = deadline - clock.now();
    if (remaining > 0) await clock.sleep(Math.min(o.intervalMs ?? 100, remaining), o.signal);
  }
  throw new HarnessError("DEADLINE_EXCEEDED", o.describe, { lastValue });
}
