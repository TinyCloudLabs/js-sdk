import type { FetchResponse } from "./types";

type ResponseReader = { cancel(): Promise<unknown>; releaseLock?(): void };

/** Release a response the SDK owns but does not return to its caller. */
export async function discardResponse(response: FetchResponse): Promise<void> {
  let body: { cancel?: () => Promise<void> } | null | undefined;
  try { body = response.body as typeof body; } catch { /* Fall back to the response reader. */ }
  try {
    if (typeof body?.cancel === "function") { await body.cancel(); return; }
  } catch { /* A custom cancellation can fail; try consuming the response. */ }
  try { await response.text(); } catch {
    // Cleanup never replaces the consumer's result or primary error.
  }
}

/**
 * Own an acquired response until consumption finishes or its body is returned.
 * Every other exit, including a throwing guard or reader, releases the body.
 * Install this scope around acquisition before racing it with cancellation.
 * `transfer` explicitly returns a wrapper that adopts the body; a thrown
 * consumer still cleans up, even if it had prepared such a wrapper.
 * Pass transfer(body) into native stream constructors to preserve their brand.
 */
export async function usingResponse<R extends FetchResponse, T>(
  acquire: () => Promise<R>,
  consume: (response: R, transfer: <V>(value: V) => V) => T | Promise<T>,
): Promise<T> {
  const response = await acquire();
  let read = false;
  let transferred = false;
  const readers = new Set<ResponseReader>();
  let body: { cancel?(): Promise<unknown>; getReader?: (...args: unknown[]) => unknown } | null | undefined;
  try {
    let observedBody: typeof body;
    const currentBody = () => {
      const actual = response.body as typeof body;
      // clone() can replace a response's body with a tee branch.
      if (actual !== body || observedBody === undefined) {
        body = actual;
        observedBody = actual && typeof actual.getReader === "function" ? new Proxy(Object.create(Object.getPrototypeOf(actual)) as NonNullable<typeof actual>, {
          get(_target, key) {
            const value = Reflect.get(actual, key, actual);
            if (key === "getReader") return (...args: unknown[]) => {
              const reader = Reflect.apply(value, actual, args) as ResponseReader;
              readers.add(reader);
              return reader;
            };
            return typeof value === "function" ? value.bind(actual) : value;
          },
        }) : actual;
      }
      return observedBody;
    };
    // A facade also supports frozen structural FetchResponse implementations.
    const observed = new Proxy(Object.create(Object.getPrototypeOf(response)) as R, {
      get(_target, key) {
        if (key === "body") return currentBody();
        const value = Reflect.get(response, key, response);
        if (typeof value !== "function") return value;
        if (["text", "json", "arrayBuffer", "blob", "formData", "bytes"].includes(String(key))) {
          return (...args: unknown[]) => {
            return Promise.resolve(Reflect.apply(value, response, args)).then((result) => {
              read = true;
              return result;
            });
          };
        }
        return value.bind(response);
      },
      set(_target, key, value) { return Reflect.set(response, key, value, response); },
    });
    let adopted = false;
    const transfer = <V>(value: V): V => {
      adopted = true;
      if ((value as unknown) === observed) return response as unknown as V;
      if (body != null && (value as unknown) === observedBody) return body as unknown as V;
      return value;
    };
    const result = await consume(observed, transfer);
    const returned: unknown = result;
    transferred = adopted || returned === observed || returned === response ||
      (body != null && (returned === observedBody || returned === body)) ||
      readers.has(returned as ResponseReader);
    if (returned === observed) return response as unknown as T;
    if (body != null && returned === observedBody) return body as unknown as T;
    return result;
  } finally {
    if (!transferred) {
      try { body = response.body as typeof body; } catch { /* discardResponse can fall back to text. */ }
      for (const reader of readers) {
        try { await reader.cancel(); } catch { /* A reader may already be closed or released. */ }
        try { reader.releaseLock?.(); } catch { /* Cleanup preserves the consumer's result. */ }
      }
      if (!read || (body != null && (response as R & { bodyUsed?: boolean }).bodyUsed === false)) await discardResponse(response);
    }
  }
}
