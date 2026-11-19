import type { FetchFunction, FetchRequestInit, FetchResponse } from "./types";

export const routesRequests = Symbol.for("@tinycloud/sdk-services/routes-requests");
export const resolvedDispatch = Symbol.for("@tinycloud/sdk-services/resolved-dispatch");
/** Marks a fetch that may hold a request in a priority lane before dispatching it. */
export const schedulesRequests = Symbol.for("@tinycloud/sdk-services/schedules-requests");
/** Long-lived requests (event streams) bypass the priority lanes: their bodies never finish. */
export const outsideLanes = Symbol.for("@tinycloud/sdk-services/outside-lanes");
const requestDeadline = Symbol.for("@tinycloud/sdk-services/request-deadline");
export type ResolvedDispatch = (fetch: FetchFunction, url: string, init: FetchRequestInit) => Promise<FetchResponse>;
type Deferred = FetchRequestInit & { [requestDeadline]?: number };

/** Preserve only routing metadata when another SDK lifetime wraps a transport. */
export function inheritResourceRouting(target: FetchFunction, source: FetchFunction): FetchFunction {
  return Object.assign(target, { [routesRequests]: (source as FetchFunction & { [routesRequests]?: boolean })[routesRequests] === true });
}

/** Mark a long-lived request (an event stream) to bypass the priority lanes. */
export function outsideLanesRequest(init: FetchRequestInit): FetchRequestInit {
  const request: FetchRequestInit & { [outsideLanes]: boolean } = { ...init, [outsideLanes]: true };
  return request;
}

/** Bound the request's own exchange to `ms`, starting when it is dispatched rather than while it waits for a lane. */
export function deferDeadline(init: FetchRequestInit, ms: number): FetchRequestInit {
  return { ...init, [requestDeadline]: ms } as Deferred;
}

/** Like deferDeadline, but a fetch that never schedules requests starts the deadline now. */
export function withDeadline(fetch: FetchFunction, init: FetchRequestInit, ms: number): FetchRequestInit {
  const deferred = deferDeadline(init, ms);
  return (fetch as FetchFunction & { [schedulesRequests]?: boolean })[schedulesRequests] === true ? deferred : startDeadline(deferred);
}

/** Start a deferred deadline: the request is being dispatched now. */
export function startDeadline(init: FetchRequestInit): FetchRequestInit {
  const ms = (init as Deferred)[requestDeadline];
  if (ms === undefined) return init;
  const timeout = AbortSignal.timeout(ms);
  return { ...init, [requestDeadline]: undefined, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout } as Deferred;
}

/** The router calls this only after selecting the physical destination. */
export function fetchResolved(fetch: FetchFunction, url: string, init?: FetchRequestInit): Promise<FetchResponse> {
  const dispatch = (init as FetchRequestInit & { [resolvedDispatch]?: ResolvedDispatch } | undefined)?.[resolvedDispatch];
  return dispatch ? dispatch(fetch, url, init!) : fetch(url, init && startDeadline(init));
}
