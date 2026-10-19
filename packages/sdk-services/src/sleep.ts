/** An abortable, unref'd wait: resolves after `delayMs` or at once when `signal` aborts, so a parked backoff never keeps the process alive. */
export function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    if (signal.aborted) {
      finish();
    } else {
      signal.addEventListener("abort", finish, { once: true });
    }
  });
}
