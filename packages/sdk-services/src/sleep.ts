/** An abortable wait: resolves after `delayMs` or at once when `signal` aborts. Ref'd by default so a one-shot process (`tc`) stays alive through a retry backoff; `unref` lets a long-lived poller not hold the process open. */
export function abortableSleep(delayMs: number, signal: AbortSignal, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    if (unref) timer.unref?.();
    if (signal.aborted) {
      finish();
    } else {
      signal.addEventListener("abort", finish, { once: true });
    }
  });
}
