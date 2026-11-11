import type { FetchFunction, FetchRequestInit, FetchResponse } from "./types";

export const routesRequests = Symbol.for("@tinycloud/sdk-services/routes-requests");
export const resolvedDispatch = Symbol.for("@tinycloud/sdk-services/resolved-dispatch");
export type ResolvedDispatch = (fetch: FetchFunction, url: string, init: FetchRequestInit) => Promise<FetchResponse>;

/** Preserve only routing metadata when another SDK lifetime wraps a transport. */
export function inheritResourceRouting(target: FetchFunction, source: FetchFunction): FetchFunction {
  return Object.assign(target, { [routesRequests]: (source as FetchFunction & { [routesRequests]?: boolean })[routesRequests] === true });
}

/** The router calls this only after selecting the physical destination. */
export function fetchResolved(fetch: FetchFunction, url: string, init?: FetchRequestInit): Promise<FetchResponse> {
  init?.signal?.throwIfAborted();
  const dispatch = (init as FetchRequestInit & { [resolvedDispatch]?: ResolvedDispatch } | undefined)?.[resolvedDispatch];
  return dispatch ? dispatch(fetch, url, init!) : fetch(url, init);
}
