import type { FetchFunction } from "./types";
import { loadRequestPriority } from "./requestPriorityLoader";

/** Apply the background lane to a node request made outside a ServiceContext. */
export function backgroundFetch(fetch: FetchFunction): FetchFunction {
  return async (url, init) => {
    const { backgroundRequest, scheduledRequest } = await loadRequestPriority();
    const signal = init?.signal ?? new AbortController().signal;
    return backgroundRequest(url, signal, () => fetch(url, scheduledRequest({ ...init, signal }, "background")));
  };
}
