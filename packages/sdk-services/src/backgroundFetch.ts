import type { FetchFunction } from "./types";
import { loadRequestPriority } from "./requestPriorityLoader";
import { schedulesRequests } from "./resolvedDispatch";

/** Apply the background lane to a node request made outside a ServiceContext. */
export function backgroundFetch(fetch: FetchFunction): FetchFunction {
  return Object.assign(async (url: string, init?: Parameters<FetchFunction>[1]) => {
    const { dispatchRequest } = await loadRequestPriority();
    const signal = init?.signal ?? new AbortController().signal;
    return dispatchRequest(url, { ...init, signal }, "background", (request) => fetch(url, request), fetch);
  }, { [schedulesRequests]: true });
}
