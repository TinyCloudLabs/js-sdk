/**
 * Retry policy override for monitors and probes: `--no-retry` (which sets the
 * env var) or `TINYCLOUD_RETRY=0` makes every request single-attempt, so the
 * node's honest `NODE_BUSY` is seen instead of a slow success.
 */
export function cliRetryPolicy(): { retryPolicy?: { maxAttempts: number } } {
  return process.env.TINYCLOUD_RETRY === "0" ? { retryPolicy: { maxAttempts: 1 } } : {};
}

/** Apply commander's global `--no-retry` (`opts.retry === false`). */
export function applyNoRetryFlag(opts: { retry?: boolean }): void {
  if (opts.retry === false) process.env.TINYCLOUD_RETRY = "0";
}
