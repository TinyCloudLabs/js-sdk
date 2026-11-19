/** Abortable wait; ref'd unless `unref`. */
export const abortableSleep = (ms: number, signal: AbortSignal, unref = false): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (unref) timer.unref?.();
    signal.aborted ? done() : signal.addEventListener("abort", done);
  });
