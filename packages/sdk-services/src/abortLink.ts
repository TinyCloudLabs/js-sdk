/**
 * Links a request's own abort signal to a long-lived one (a context's or a
 * service graph's) without leaving a listener on the long-lived signal.
 */
import type { FetchResponse } from "./types";

/** How long a response body nobody has started reading keeps its listener on the long-lived signal. */
const UNREAD_BODY_MS = 60_000;

// This package compiles against the ES2020 lib, which predates FinalizationRegistry; it exists on every supported runtime.
declare const FinalizationRegistry:
  | (new (cleanup: (release: () => void) => void) => { register(target: object, release: () => void): void })
  | undefined;

const collected =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((release) => release())
    : undefined;

/**
 * Combine `signal` with the long-lived `own` signal. `release` removes the listener this adds to `own`
 * (safe to call any number of times). With no `signal` it returns `own` itself and nothing to release.
 * `keepReason` copies the aborting signal's reason; without it the combined signal aborts with a bare AbortError.
 */
export function linkAbortSignal(
  own: AbortSignal,
  signal: AbortSignal | undefined,
  keepReason?: boolean,
): { signal: AbortSignal; release: () => void } {
  if (!signal) return { signal: own, release: () => {} };
  const combined = new AbortController();
  const abort = (source: AbortSignal) => combined.abort(keepReason ? source.reason : undefined);
  const onOwn = () => abort(own);
  if (signal.aborted) {
    abort(signal);
  } else if (own.aborted) {
    abort(own);
  } else {
    signal.addEventListener("abort", () => abort(signal), { once: true });
    own.addEventListener("abort", onOwn, { once: true });
  }
  return { signal: combined.signal, release: () => own.removeEventListener("abort", onOwn) };
}

/**
 * Call `release` when `response`'s body is done, so the long-lived signal stays linked for as long as the body can
 * still be read: aborting it cancels a body in flight. `release` runs when the body is read to the end, cancelled or
 * errors; at once when there is no body (204, HEAD) or `response` is not a real Response; when the returned response is
 * garbage collected; and, for a body nobody has started reading, after `idleMs`. A body that is being read has no
 * timer, so a stalled stream stays abortable. Backstop limit: a response held unread past `idleMs` and read later is
 * no longer cancelled by the long-lived signal.
 *
 * The result is a new Response over a pass-through stream (reads on demand, cancel goes to the source) with the
 * original's status, status text and headers; `url`, `redirected` and `type` are not carried over.
 */
export function releaseWithBody<T extends FetchResponse>(response: T, release: () => void, idleMs = UNREAD_BODY_MS): T {
  const body = response instanceof Response ? response.body : null;
  if (!body) {
    release();
    return response;
  }
  const reader = body.getReader();
  let finished = false;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (): void => {
    clearTimeout(timer);
    if (!finished) {
      finished = true;
      release();
    }
  };
  // Node's timer handle can be unref'd so an unread body never keeps the process alive; browsers return a number.
  const handle = (timer = setTimeout(finish, idleMs)) as unknown as { unref?: () => void };
  handle.unref?.();
  const held = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          clearTimeout(timer);
          try {
            const { done, value } = await reader.read();
            if (done) {
              finish();
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            failure = error;
            finish();
            controller.error(error);
          }
        },
        cancel(reason) {
          finish();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    ),
    // A real Response (checked above): its status, statusText and headers are the init.
    response as unknown as ResponseInit,
  );
  // Chrome turns a stream error met by text(), json(), ... into a TypeError; hand back the error that ended the body
  // (an AbortError after an abort), as a native fetch body does.
  const readers = held as unknown as Record<string, () => Promise<unknown>>;
  for (const read of ["arrayBuffer", "blob", "json", "text"]) {
    const native = readers[read].bind(held);
    readers[read] = () => native().catch((error: unknown) => { throw failure ?? error; });
  }
  collected?.register(held, release);
  return held as unknown as T;
}
