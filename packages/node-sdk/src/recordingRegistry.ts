import type { FetchFunction, ServiceContext } from "@tinycloud/sdk-services";

const unrecordedFetches = new WeakMap<ServiceContext, () => FetchFunction>();

/** Registers a recording context's raw transport, read at call time so `_fetch` overrides still reach it. */
export function registerRecording(context: ServiceContext, unrecordedFetch: () => FetchFunction): void {
  unrecordedFetches.set(context, unrecordedFetch);
}

/**
 * The transport fetch for a context: `context.fetch` for a plain context, the raw transport for a
 * recording context. Child contexts that record their own calls use this so the parent's per-call
 * recording is not doubled.
 */
export function unrecordedFetchOf(context: ServiceContext): FetchFunction {
  const unrecordedFetch = unrecordedFetches.get(context);
  return unrecordedFetch ? unrecordedFetch() : context.fetch;
}
