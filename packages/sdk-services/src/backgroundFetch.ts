import type { FetchFunction } from "./types";
import { loadRequestPriority } from "./requestPriorityLoader";

/** Apply the background lane to a node request made outside a ServiceContext. */
export function backgroundFetch(fetch: FetchFunction): FetchFunction {
  return async (url, init) => {
    const { dispatchRequest } = await loadRequestPriority();
    const signal = init?.signal ?? new AbortController().signal;
    return dispatchRequest(url, { ...init, signal }, "background", (request) => fetch(url, request), fetch);
  };
}
