import { usingResponse } from "@tinycloud/sdk-services/internal/response-body";
import { nodeRetryError } from "./errors";
import { abortableSleep } from "./sleep";
import { ErrorCodes, type FetchFunction, type FetchRequestInit, type FetchResponse, type RetryPolicy } from "./types";
import type { RequestPriority } from "./requestPriority";

export type RetryInvocationOptions = {
  url: string;
  build: () => FetchRequestInit | Promise<FetchRequestInit>;
  fetch: FetchFunction;
  policy: RetryPolicy;
  priority: RequestPriority;
  signal: AbortSignal;
  combineSignals(signal?: AbortSignal): AbortSignal;
};

/** Retry after the lane module is loaded, using the caller's signing and cancellation. */
export async function retryInvocation({ url, build, fetch, policy, priority, combineSignals }: RetryInvocationOptions): Promise<FetchResponse> {
  const startedAt = Date.now();
  let backoffMs = 0;
  let signal: AbortSignal | undefined;
  for (let attempt = 1; ; attempt++) {
    const init = await build();
    signal ??= combineSignals(init.signal);
    const outcome = await usingResponse(
      () => fetch(url, init),
      async (response) => {
        const done = (): FetchResponse => {
          try { response.retry = { attempts: attempt, backoffMs }; } catch { /* frozen custom response */ }
          return response;
        };
        if (attempt >= policy.maxAttempts || response.status !== 503 || !response.clone) return done();
        const text = await usingResponse(() => Promise.resolve(response.clone!()), (clone) => clone.text()).catch(() => "");
        const error = nodeRetryError("", "", response, text);
        if (!error || error.meta?.retryable !== true || !policy.retryableErrors.includes(error.code)) {
          return done();
        }
        const busyBudget = error.code === ErrorCodes.NODE_BUSY && priority === "foreground"
          ? policy.foregroundBusyMaxTotalMs
          : undefined;
        const budget = Math.min(policy.maxTotalMs ?? Infinity, busyBudget ?? Infinity);
        const remaining = budget - (Date.now() - startedAt);
        if (remaining <= 0) return done();
        const retryAfterMs = error.meta.retryAfterMs;
        const step = Math.min(
          policy.maxDelayMs,
          policy.backoff === "exponential"
            ? policy.baseDelayMs * 2 ** (attempt - 1)
            : policy.backoff === "linear"
              ? policy.baseDelayMs * attempt
              : 0,
        );
        // A retry scheduled outside the budget would also ignore the node's Retry-After.
        if (busyBudget !== undefined && typeof retryAfterMs === "number" && retryAfterMs >= remaining) {
          return done();
        }
        const delay = Math.min(
          typeof retryAfterMs === "number" ? retryAfterMs : Math.random() * step,
          remaining,
        );
        if (busyBudget !== undefined && delay >= remaining) return done();
        return delay;
      },
    );
    if (typeof outcome !== "number") return outcome;
    const delay = outcome;
    await abortableSleep(delay, signal);
    if (signal.aborted) throw signal.reason;
    backoffMs += delay;
  }
}
