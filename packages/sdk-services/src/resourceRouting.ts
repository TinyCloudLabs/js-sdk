import type { FetchFunction, FetchResponse, ServiceHeaders } from "./types";

export type ResourceAccess = "read" | "write" | "host" | "encryption";
export interface ResourceDestination { readonly url: string; readonly nodeDid?: string }
export interface ResourceRoutingConfig {
  resolveResource(resource: string, access: ResourceAccess): Promise<readonly ResourceDestination[]>;
  bindAudience(authorization: string, nodeDid: string): Promise<string>;
  /** Defaults to the raw transport's public node identity checks. */
  verifyDestination?(target: ResourceDestination): Promise<void>;
}

/** Compare both public node identity surfaces before sending a capability. */
export async function verifyResourceDestination(target: ResourceDestination, fetchFn: FetchFunction): Promise<void> {
  if (!target.nodeDid) return;
  let info: unknown;
  let keys: unknown;
  try {
    const signal = AbortSignal.timeout(5_000);
    const responses = await Promise.all([
      fetchFn(`${target.url}/info`, { signal, redirect: "error" }),
      fetchFn(`${target.url}/.well-known/tinycloud/node-keys`, { signal, redirect: "error" }),
    ]);
    if (responses.some((response) => response.status >= 500)) throw new NodeNotRespondingError([target.url]);
    if (responses.some((response) => !response.ok)) throw new NodeIdentityMismatchError(target.url, target.nodeDid);
    try {
      [info, keys] = await Promise.all(responses.map((response) => response.json()));
    } catch {
      throw new NodeIdentityMismatchError(target.url, target.nodeDid);
    }
  } catch (error) {
    if (error instanceof NodeIdentityMismatchError || error instanceof NodeNotRespondingError) throw error;
    throw new NodeNotRespondingError([target.url], error);
  }
  const infoDid = typeof info === "object" && info !== null && "nodeId" in info && typeof info.nodeId === "string" ? info.nodeId : undefined;
  const keysDid = typeof keys === "object" && keys !== null && "nodeDid" in keys && typeof keys.nodeDid === "string" ? keys.nodeDid : undefined;
  if (infoDid !== target.nodeDid || keysDid !== target.nodeDid) {
    throw new NodeIdentityMismatchError(target.url, target.nodeDid, infoDid !== target.nodeDid ? infoDid : keysDid);
  }
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
      const resource = uri.startsWith("tinycloud:") ? uri.split("/")[0] : uri;
      if (!resource.startsWith("tinycloud:") && !resource.startsWith("urn:tinycloud:encryption:")) throw new ResourceNotRoutedError(uri);
      // Only named, known read abilities are reads. Unknown abilities must not broaden a read-only membership.
      const read = /^(tinycloud\.(kv\/(get|list|metadata|head|sync)|sql\/(read|export)|duckdb\/(read|describe|export)|capabilities\/read|space\/(list|info)|hooks\/list))$/.test(action);
      const access: ResourceAccess = resource.startsWith("urn:tinycloud:encryption:") ? "encryption" : action === "tinycloud.space/host" ? "host" : read ? "read" : "write";
      if (!resources.some((entry) => entry.resource === resource && entry.access === access)) resources.push({ resource, access });
    }
  }
  if (resources.length === 0) throw new ResourceNotRoutedError("empty invocation");
  return resources;
}

/** Route signed /invoke traffic. Non-invocation endpoints retain their own resource-specific adapters. */
export function createResourceRoutingFetch(fetchFn: FetchFunction, routing: ResourceRoutingConfig): FetchFunction {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname !== "/invoke") return fetchFn(url, init);
    const authorization = authorizationOf(init?.headers);
    if (!authorization) throw new ResourceNotRoutedError("unsigned invocation");
    const resources = invocationResources(authorization);
    const routes = await Promise.all(resources.map(({ resource, access }) => routing.resolveResource(resource, access)));
    if (routes.some((route) => route.length === 0)) throw new ResourceNotRoutedError(resources[routes.findIndex((route) => route.length === 0)].resource);
    const write = resources.some(({ access }) => access === "write" || access === "host");
    let targets = routes[0].filter((target) => routes.every((route) => route.some((other) => other.url === target.url && other.nodeDid === target.nodeDid)));
    // A single atomic invocation cannot be split into capabilities for different node sets.
    if (targets.length === 0 || (write && routes.some((route) => route.length !== targets.length))) throw new ResourceNotRoutedError(resources.map(({ resource }) => resource).join(", "));
    targets = targets.filter((target, index) => targets.findIndex((other) => other.url === target.url) === index);
    const send = async (target: ResourceDestination): Promise<FetchResponse> => {
      init?.signal?.throwIfAborted();
      if (routing.verifyDestination) await routing.verifyDestination(target);
      else await verifyResourceDestination(target, fetchFn);
      const signed = target.nodeDid ? await routing.bindAudience(authorization, target.nodeDid) : authorization;
      const headers = (Array.isArray(init?.headers) ? init.headers : Object.entries(init?.headers ?? {})).filter(([name]) => name.toLowerCase() !== "authorization");
      headers.push(["Authorization", signed]);
      const timeout = AbortSignal.timeout(5_000);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      try {
        return await fetchFn(`${target.url}${parsed.pathname}${parsed.search}`, { ...init, headers, signal, redirect: "error" });
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        if (routingFailure(error)) throw error;
        throw new NodeNotRespondingError([target.url], error);
      }
    };
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
  };
}
