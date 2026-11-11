import { usingResponse } from "@tinycloud/sdk-services/internal/response-body";
import type { FetchFunction, FetchResponse, ServiceHeaders, ServiceSession } from "./types";
import { fetchResolved, routesRequests } from "./resolvedDispatch";

export type ResourceAccess = "read" | "write" | "host" | "encryption";
export interface ResourceDestination { readonly url: string; readonly nodeDid?: string }
export interface ResourceNodeInfo { readonly nodeId: string; readonly features?: unknown }
export interface ResourceRoutingConfig {
  resolveResource(resource: string, access: ResourceAccess): Promise<readonly ResourceDestination[]>;
  bindAudience(authorization: string, nodeDid: string): Promise<string>;
  /** Defaults to the raw transport's public node identity checks. */
  verifyDestination?(target: ResourceDestination): Promise<void | ResourceNodeInfo>;
}

/** An identity-checked destination bound to one live resource-routing decision. */
export interface ResourceTransportTarget {
  readonly url: string;
  readonly nodeDid: string;
  readonly fetch: FetchFunction;
  readonly nodeInfo: ResourceNodeInfo;
  bindAudience(authorization: string): Promise<string>;
}
export interface ResourceTransportOptions {
  /** CID-only controls are node-local and must not choose among several destinations. */
  readonly nodeLocal?: boolean;
  /** An existing node-bound authority must match the resolved destination. */
  readonly nodeDid?: string;
  /** A verified imported grant activates its resources independently, not atomically. */
  readonly independentResources?: boolean;
  /** Captured, verified share-session key for its own locally created invocations. */
  readonly invocationSession?: ServiceSession;
}
export type ResourceTransport = (
  resources: readonly { resource: string; access: ResourceAccess }[],
  send: (target: ResourceTransportTarget) => Promise<FetchResponse>,
  options?: ResourceTransportOptions,
) => Promise<FetchResponse>;

/** Compare both public node identity surfaces before sending a capability. */
export async function verifyResourceDestination(target: ResourceDestination, fetchFn: FetchFunction): Promise<ResourceNodeInfo | undefined> {
  if (!target.nodeDid) return;
  let info: unknown;
  let keys: unknown;
  try {
    const signal = AbortSignal.timeout(5_000);
    const replies = await Promise.all([
      `${target.url}/info`,
      `${target.url}/.well-known/tinycloud/node-keys`,
    ].map((url) => usingResponse(
      () => fetchFn(url, { signal, redirect: "error" }),
      async (response) => {
        // Consume each first body before another background request needs its slot.
        const status = response.status;
        const accepted = response.ok;
        const content = await Promise.resolve().then(() => accepted ? response.json() : undefined).catch(() => undefined);
        return { status, accepted, content };
      },
    )));
    if (replies.some(({ status }) => status >= 500)) throw new NodeNotRespondingError([target.url]);
    if (replies.some(({ accepted }) => !accepted)) throw new NodeIdentityMismatchError(target.url, target.nodeDid);
    [info, keys] = replies.map(({ content }) => content);
  } catch (error) {
    if (error instanceof NodeIdentityMismatchError || error instanceof NodeNotRespondingError) throw error;
    throw new NodeNotRespondingError([target.url], error);
  }
  const infoDid = typeof info === "object" && info !== null && "nodeId" in info && typeof info.nodeId === "string" ? info.nodeId : undefined;
  const keysDid = typeof keys === "object" && keys !== null && "nodeDid" in keys && typeof keys.nodeDid === "string" ? keys.nodeDid : undefined;
  if (infoDid !== target.nodeDid || keysDid !== target.nodeDid) {
    throw new NodeIdentityMismatchError(target.url, target.nodeDid, infoDid !== target.nodeDid ? infoDid : keysDid);
  }
  return info as ResourceNodeInfo;
}

export class NodeNotRespondingError extends Error {
  readonly code = "NODE_NOT_RESPONDING";
  constructor(readonly hosts: readonly string[], readonly cause?: unknown) {
    super("The place your data is stored isn't responding right now. Please try again.");
    this.name = "NodeNotRespondingError";
  }
}
export class NodeIdentityMismatchError extends Error {
  readonly code = "NODE_IDENTITY_MISMATCH";
  constructor(readonly url: string, readonly expectedDid: string, readonly actualDid?: string) {
    super(`TinyCloud node identity does not match the registry at ${url}`);
    this.name = "NodeIdentityMismatchError";
  }
}
export class ResourceNotRoutedError extends Error {
  readonly code = "RESOURCE_NOT_ROUTED";
  constructor(readonly resource: string) {
    super(`No registered destination can serve ${resource}`);
    this.name = "ResourceNotRoutedError";
  }
}
export class PartialNodeWriteError extends Error {
  readonly code = "PARTIAL_NODE_WRITE";
  constructor(readonly succeeded: readonly string[], readonly failed: readonly { url: string; status?: number; cause?: unknown }[]) {
    super("The write did not complete on every registered writable node.");
    this.name = "PartialNodeWriteError";
  }
}

export type RoutingFailureCode =
  | "NODE_NOT_RESPONDING" | "DECRYPTION_DEPENDENCY_UNAVAILABLE" | "PARTIAL_NODE_WRITE" | "NODE_IDENTITY_MISMATCH" | "RESOURCE_NOT_ROUTED"
  | "registry_unavailable" | "node_not_found" | "node_registry_entry_exists";
export interface RoutingFailure {
  code: RoutingFailureCode;
  message: string;
  cause?: Error;
  meta?: Record<string, unknown>;
}
const ROUTING_FAILURE_CODES: Record<RoutingFailureCode, true> = {
  NODE_NOT_RESPONDING: true, PARTIAL_NODE_WRITE: true, NODE_IDENTITY_MISMATCH: true, RESOURCE_NOT_ROUTED: true,
  DECRYPTION_DEPENDENCY_UNAVAILABLE: true,
  registry_unavailable: true, node_not_found: true, node_registry_entry_exists: true,
};
function isRoutingFailureCode(code: string): code is RoutingFailureCode {
  return Object.prototype.hasOwnProperty.call(ROUTING_FAILURE_CODES, code);
}
/** Preserve routing failures through service-specific Result/error adapters. */
export function routingFailure(error: unknown): RoutingFailure | undefined {
  // Normalize the public error shape without retaining transport constructors
  // in single-host consumers that only import generic service error handling.
  if (typeof error === "object" && error !== null && "code" in error && "message" in error &&
    typeof error.code === "string" && typeof error.message === "string" &&
    isRoutingFailureCode(error.code)) {
    const candidate = "meta" in error ? error.meta : undefined;
    let meta = typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
      ? candidate as Record<string, unknown> : undefined;
    if (error.code === "NODE_NOT_RESPONDING" && "hosts" in error && Array.isArray(error.hosts)) {
      meta = { ...meta, hosts: error.hosts };
    } else if (error.code === "PARTIAL_NODE_WRITE" &&
        "succeeded" in error && Array.isArray(error.succeeded) &&
        "failed" in error && Array.isArray(error.failed)) {
      meta = { ...meta, succeeded: error.succeeded, failed: error.failed };
    }
    return { code: error.code, message: error.message, ...(error instanceof Error ? { cause: error } : {}), ...(meta ? { meta } : {}) };
  }
  return undefined;
}

function authorizationOf(headers: ServiceHeaders | undefined): string | undefined {
  if (headers === undefined) return undefined;
  return (Array.isArray(headers) ? headers : Object.entries(headers)).find(([name]) => name.toLowerCase() === "authorization")?.[1];
}

/** Extract the signed resource without inferring an account for node-local names. */
export function routingResourceOf(uri: string): string {
  if (uri.startsWith("tinycloud://")) {
    const resource = uri.slice("tinycloud://".length).split("/", 1)[0];
    if (resource) return resource;
  } else if (uri.startsWith("urn:tinycloud:encryption:")) {
    return uri;
  } else if (uri.startsWith("tinycloud:")) {
    return uri.split("/", 1)[0]!;
  }
  throw new ResourceNotRoutedError(uri);
}

type WriteReplies = { pending: number; retained: FetchResponse[] };
type OwnedReplies = { responses: FetchResponse[]; writes: Map<string, WriteReplies>; closed: boolean };

/** A FetchFunction owns its unreturned replies; generic resource transports do not. */
async function withOwnedReplies(run: (replies: OwnedReplies) => Promise<FetchResponse>): Promise<FetchResponse> {
  const replies: OwnedReplies = { responses: [], writes: new Map(), closed: false };
  let response: FetchResponse | undefined;
  try {
    response = await run(replies);
    return response;
  } finally {
    replies.closed = true;
    await Promise.all(replies.responses.filter((reply) => reply !== response).map((reply) => usingResponse(() => Promise.resolve(reply), () => undefined)));
  }
}

function invocationResources(authorization: string): Array<{ resource: string; access: ResourceAccess }> {
  const encoded = authorization.split(".")[1];
  if (!encoded) throw new ResourceNotRoutedError("invalid invocation");
  const payload: unknown = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
  if (typeof payload !== "object" || payload === null || !("att" in payload) || typeof payload.att !== "object" || payload.att === null || Array.isArray(payload.att)) {
    throw new ResourceNotRoutedError("invalid invocation attenuation");
  }
  const resources: Array<{ resource: string; access: ResourceAccess }> = [];
  for (const [uri, abilities] of Object.entries(payload.att)) {
    if (typeof abilities !== "object" || abilities === null || Array.isArray(abilities)) throw new ResourceNotRoutedError(uri);
    for (const action of Object.keys(abilities)) {
      const resource = routingResourceOf(uri);
      // Only named, known read abilities are reads. Unknown abilities must not broaden a read-only membership.
      const read = /^(tinycloud\.(kv\/(get|list|metadata|head|sync)|sql\/(read|export)|duckdb\/(read|describe|export)|capabilities\/read|space\/(list|info)|hooks\/list))$/.test(action);
      const access: ResourceAccess = resource.startsWith("urn:tinycloud:encryption:") ? "encryption" : action === "tinycloud.space/host" ? "host" : read ? "read" : "write";
      if (!resources.some((entry) => entry.resource === resource && entry.access === access)) resources.push({ resource, access });
    }
  }
  if (resources.length === 0) throw new ResourceNotRoutedError("empty invocation");
  return resources;
}

/** Share target selection and read/write outcomes with resource-specific adapters. */
export async function routeResourceRequest(
  resources: readonly { resource: string; access: ResourceAccess }[],
  routing: Pick<ResourceRoutingConfig, "resolveResource">,
  send: (target: ResourceDestination) => Promise<FetchResponse>,
  options?: ResourceTransportOptions,
): Promise<FetchResponse> {
  if (resources.length === 0) throw new ResourceNotRoutedError("empty request");
  const routes = await Promise.all(resources.map(({ resource, access }) => routing.resolveResource(resource, access)));
  if (routes.some((route) => route.length === 0)) throw new ResourceNotRoutedError(resources[routes.findIndex((route) => route.length === 0)].resource);
  const write = options?.independentResources === true || resources.some(({ access }) => access === "write" || access === "host");
  let targets: readonly ResourceDestination[];
  if (options?.independentResources) {
    targets = routes.flat();
    const identities = new Map<string, string | undefined>();
    for (const target of targets) {
      if (identities.has(target.url) && identities.get(target.url) !== target.nodeDid) throw new ResourceNotRoutedError(target.url);
      identities.set(target.url, target.nodeDid);
    }
  } else {
    targets = routes[0].filter((target) => routes.every((route) => route.some((other) => other.url === target.url && other.nodeDid === target.nodeDid)));
    // A single atomic operation cannot be split across different destination sets.
    if (targets.length === 0 || (write && routes.some((route) => route.length !== targets.length))) throw new ResourceNotRoutedError(resources.map(({ resource }) => resource).join(", "));
  }
  targets = targets.filter((target, index) => targets.findIndex((other) => other.url === target.url) === index);
  if (options?.nodeDid) targets = targets.filter((target) => target.nodeDid === options.nodeDid || target.nodeDid === undefined);
  if (targets.length === 0 || (options?.nodeLocal && targets.length !== 1)) throw new ResourceNotRoutedError(resources.map(({ resource }) => resource).join(", "));
  if (!write) {
    let response: FetchResponse | undefined;
    let failure: unknown;
    for (const target of targets) {
      try {
        response = await send(target);
        if (response.ok || response.status !== 404) return response;
      } catch (error) {
        if (!(error instanceof NodeNotRespondingError)) throw error;
        failure = error;
      }
    }
    if (failure) throw new NodeNotRespondingError(targets.map(({ url }) => url), failure);
    if (response) return response;
    throw new NodeNotRespondingError(targets.map(({ url }) => url), failure);
  }
  const succeeded: string[] = [];
  const failed: Array<{ url: string; status?: number; cause?: unknown }> = [];
  let response: FetchResponse | undefined;
  let failureResponse: FetchResponse | undefined;
  for (const target of targets) {
    try {
      const result = await send(target);
      if (result.ok) { succeeded.push(target.url); response ??= result; }
      else { failed.push({ url: target.url, status: result.status }); failureResponse ??= result; }
    } catch (error) {
      if (!routingFailure(error) && succeeded.length === 0) throw error;
      failed.push({ url: target.url, cause: error });
    }
  }
  if (failed.length > 0) {
    if (succeeded.length > 0 || targets.length > 1) throw new PartialNodeWriteError(succeeded, failed);
    if (failureResponse) return failureResponse;
    if (failed[0]?.cause && !(failed[0].cause instanceof NodeNotRespondingError)) throw failed[0].cause;
    throw new NodeNotRespondingError(targets.map(({ url }) => url), failed[0]?.cause);
  }
  return response!;
}

/** Finish an intermediate reply before another write needs that host's slot.
 * Reading a clone preserves the original receipt and its body for the caller. */
async function drainWriteClone(response: FetchResponse): Promise<void> {
  if (response.clone) await usingResponse(() => Promise.resolve(response.clone!()), (clone) => clone.arrayBuffer()).catch(() => undefined);
}

async function prepareWrite(replies: OwnedReplies, url: string, write: boolean): Promise<WriteReplies | undefined> {
  if (!write) return undefined;
  const host = new URL(url).origin;
  let state = replies.writes.get(host);
  if (!state) { state = { pending: 0, retained: [] }; replies.writes.set(host, state); }
  await Promise.all(state.retained.splice(0).map(drainWriteClone));
  state.pending++;
  return state;
}

async function retainedWriteReply(response: FetchResponse, state: WriteReplies | undefined): Promise<FetchResponse> {
  // A custom transport can also dispatch its targets concurrently.
  if (state && state.pending > 1) await drainWriteClone(response);
  return response;
}

async function rememberReply(replies: OwnedReplies, response: FetchResponse, state: WriteReplies | undefined): Promise<FetchResponse> {
  if (replies.closed) {
    // The transport may have rejected before an abort-ignoring fetch replied.
    await usingResponse(() => Promise.resolve(response), () => undefined);
  } else {
    replies.responses.push(response);
    state?.retained.push(response);
  }
  return response;
}

/** Route only locally generated data invocations through a captured share session. */
export function createResourceTransportInvocationFetch(transport: ResourceTransport, session: ServiceSession): FetchFunction {
  return Object.assign(async (url: string, init?: Parameters<FetchFunction>[1]) => {
    const parsed = new URL(url);
    if (parsed.pathname !== "/invoke") throw new ResourceNotRoutedError(parsed.pathname);
    const authorization = authorizationOf(init?.headers);
    if (!authorization) throw new ResourceNotRoutedError("unsigned invocation");
    const resources = invocationResources(authorization);
    const write = resources.some(({ access }) => access === "write" || access === "host");
    return withOwnedReplies((replies) => transport(resources, async (target) => {
      const signed = await target.bindAudience(authorization);
      init?.signal?.throwIfAborted();
      const headers = (Array.isArray(init?.headers) ? init.headers : Object.entries(init?.headers ?? {}))
        .filter(([name]) => name.toLowerCase() !== "authorization");
      headers.push(["Authorization", signed]);
      const state = await prepareWrite(replies, target.url, write);
      try {
        init?.signal?.throwIfAborted();
        const response = await usingResponse(
          () => fetchResolved(target.fetch, `${target.url}${parsed.pathname}${parsed.search}`, { ...init, headers }),
          (reply) => retainedWriteReply(reply, state),
        );
        return await rememberReply(replies, response, state);
      } finally { if (state) state.pending--; }
    }, { invocationSession: session }));
  }, { [routesRequests]: true });
}

/** Route signed /invoke traffic. Non-invocation endpoints retain their own resource-specific adapters. */
export function createResourceRoutingFetch(fetchFn: FetchFunction, routing: ResourceRoutingConfig): FetchFunction {
  return Object.assign(async (url: string, init?: Parameters<FetchFunction>[1]) => {
    const parsed = new URL(url);
    if (parsed.pathname !== "/invoke") return fetchResolved(fetchFn, url, init);
    const authorization = authorizationOf(init?.headers);
    if (!authorization) throw new ResourceNotRoutedError("unsigned invocation");
    const resources = invocationResources(authorization);
    return withOwnedReplies(async (replies) => {
      const write = resources.some(({ access }) => access === "write" || access === "host");
      const send = async (target: ResourceDestination): Promise<FetchResponse> => {
        if (!write && replies.responses.at(-1)?.status === 404) await usingResponse(() => Promise.resolve(replies.responses.at(-1)!), () => undefined);
        init?.signal?.throwIfAborted();
        if (routing.verifyDestination) await routing.verifyDestination(target);
        else await verifyResourceDestination(target, fetchFn);
        const signed = target.nodeDid ? await routing.bindAudience(authorization, target.nodeDid) : authorization;
        init?.signal?.throwIfAborted();
        const headers = (Array.isArray(init?.headers) ? init.headers : Object.entries(init?.headers ?? {})).filter(([name]) => name.toLowerCase() !== "authorization");
        headers.push(["Authorization", signed]);
        const timeout = AbortSignal.timeout(5_000);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        const state = await prepareWrite(replies, target.url, write);
        try {
          signal.throwIfAborted();
          const response = await usingResponse(
            () => fetchResolved(fetchFn, `${target.url}${parsed.pathname}${parsed.search}`, { ...init, headers, signal, redirect: "error" }),
            (reply) => retainedWriteReply(reply, state),
          );
          return await rememberReply(replies, response, state);
        } catch (error) {
          if (init?.signal?.aborted) throw error;
          if (routingFailure(error)) throw error;
          throw new NodeNotRespondingError([target.url], error);
        } finally { if (state) state.pending--; }
      };
      return routeResourceRequest(resources, routing, send);
    });
  }, { [routesRequests]: true });
}
