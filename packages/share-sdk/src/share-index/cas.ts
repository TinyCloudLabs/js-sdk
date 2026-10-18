import { INVALID_ETAG_MESSAGE, type ShareWriteResult } from "./backend.js";

/**
 * The compare-and-swap loop policy shared by the index and the record stores
 * (design C §4, plus the lead's rule for slice 2):
 * - every attempt starts with a fresh network read and re-applies the change,
 *   so a lost race (`ETAG_MISMATCH`) and an unknown outcome (`OUTCOME_UNKNOWN`)
 *   are both decided from what the node now holds, never by a blind re-put;
 * - `ETAG_MISMATCH` and `NODE_BUSY` back off 50 ms·2ⁿ with jitter, capped at
 *   1 s, for at most 6 attempts;
 * - `INVALID_ETAG` is never retried: the first one throws
 *   {@link ShareIndexCasError} with the SDK's own message (an ETag weakened
 *   in transit, for example by a CDN, cannot be used for compare-and-swap).
 */
export interface CasPolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export const DEFAULT_CAS_POLICY: CasPolicy = {
  maxAttempts: 6,
  backoffBaseMs: 50,
  backoffCapMs: 1000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export type ShareIndexCasErrorCode =
  /** The etag was refused as malformed; compare-and-swap is unavailable through this path. Never retried. */
  | "INVALID_ETAG"
  /** Every attempt lost a race or found the node busy. */
  | "EXHAUSTED"
  /** The write was refused (authorization, storage) or the read failed. */
  | "FAILED";

export class ShareIndexCasError extends Error {
  constructor(readonly code: ShareIndexCasErrorCode, message: string, readonly key: string, readonly attempts: number) {
    super(message);
    this.name = "ShareIndexCasError";
  }
}

/** One attempt: read, decide, and either finish or report a write result. */
export type CasAttempt<T> = { readonly done: T } | { readonly write: ShareWriteResult; readonly onSuccess: () => T };

export async function runCas<T>(key: string, policy: CasPolicy, attempt: () => Promise<CasAttempt<T>>): Promise<T> {
  for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber++) {
    const step = await attempt();
    if ("done" in step) return step.done;
    const result = step.write;
    if (result.ok) return step.onSuccess();
    if (result.code === "invalid_etag") throw new ShareIndexCasError("INVALID_ETAG", result.message || INVALID_ETAG_MESSAGE, key, attemptNumber);
    if (result.code === "unauthorized" || result.code === "failed") throw new ShareIndexCasError("FAILED", `write of ${key} was refused (${result.code})`, key, attemptNumber);
    // conflict and busy back off; outcome_unknown re-reads at once and decides from the node's state.
    if (result.code !== "outcome_unknown" && attemptNumber < policy.maxAttempts) {
      const ceiling = Math.min(policy.backoffCapMs, policy.backoffBaseMs * 2 ** (attemptNumber - 1));
      await policy.sleep(Math.floor(ceiling / 2 + policy.random() * (ceiling / 2)));
    }
  }
  throw new ShareIndexCasError("EXHAUSTED", `compare-and-swap of ${key} did not converge in ${policy.maxAttempts} attempts`, key, policy.maxAttempts);
}
