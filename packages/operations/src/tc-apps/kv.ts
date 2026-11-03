import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { OperationContext } from "../contract.js";
import { isOperationErrorCode, nodeRetryOperationError, OperationInvocationError, operationError, storageFullOperationError, type OperationError } from "../errors.js";
import { authorizationFailure } from "../kv-failure.js";
import { evaluateOperationAuthority } from "../authority.js";
import { operationSpaceResolver } from "../secrets.js";
import { TC_APPS_CATALOG_READ_ACTIONS, TC_APPS_DISCOVERY_ACTIONS, TC_APPS_RECORDS_ACTIONS } from "../tc-apps.js";
import { appRoot, spaceName, staleKey, TC_APPS_DISCOVERY_ROOT, TC_APPS_LEGACY_ROOT, type Layout } from "./layout.js";
import { isObject, type JsonObject } from "./records.js";

export interface KvError { readonly code?: string; readonly meta?: Readonly<Record<string, unknown>> }
export type KvResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: KvError };
export interface KvValue { readonly data: unknown; readonly headers: { readonly etag?: string } }
export interface AppsKv {
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<KvResult<{ keys: readonly string[]; nextCursor?: string; truncated?: boolean }>>;
  batchGet(keys: string[]): Promise<KvResult<{ results: readonly { key: string; result: KvResult<KvValue> }[] }>>;
  put(key: string, value: Uint8Array, options: { ifNoneMatch?: "*"; ifMatch?: string }): Promise<KvResult<KvValue>>;
  delete(key: string, options: { ifMatch?: string }): Promise<KvResult<KvValue>>;
}
export type ReadRecord = { key: string; value: JsonObject; etag: string } | { key: string; outcome: "NOT_FOUND" | "MALFORMED" };

export function appsSpace(context: OperationContext, layout: Layout): string {
  if (!context.runtime) throw new TypeError("Authenticated operation runtime is unavailable.");
  return operationSpaceResolver(context.runtime.node, context.summary.space)(spaceName(layout));
}
export function appsKv(context: OperationContext, layout: Layout): AppsKv {
  return (context.runtime!.node as TinyCloudNode).kvForSpace(appsSpace(context, layout)) as unknown as AppsKv;
}

/** The connector's permission entries. Each is the whole grant for its scope, so one approval covers every later call. */
export type AppsPermission = { service: string; space: string; path: string; actions: string[] };
export function legacyRecordsPermission(context: OperationContext): AppsPermission {
  return { service: "tinycloud.kv", space: appsSpace(context, "legacy"), path: TC_APPS_LEGACY_ROOT, actions: [...TC_APPS_RECORDS_ACTIONS] };
}
export function legacyCatalogPermission(context: OperationContext): AppsPermission {
  return { service: "tinycloud.kv", space: appsSpace(context, "legacy"), path: `${TC_APPS_LEGACY_ROOT}catalog/`, actions: [...TC_APPS_CATALOG_READ_ACTIONS] };
}
export function appRecordsPermission(context: OperationContext, app: string): AppsPermission {
  return { service: "tinycloud.kv", space: appsSpace(context, "new"), path: appRoot(app), actions: [...TC_APPS_RECORDS_ACTIONS] };
}
export function discoveryPermission(context: OperationContext, actions: readonly string[] = TC_APPS_DISCOVERY_ACTIONS): AppsPermission {
  return { service: "tinycloud.kv", space: appsSpace(context, "new"), path: TC_APPS_DISCOVERY_ROOT, actions: [...actions] };
}

export function appsFailure(error: unknown): OperationError {
  if (error instanceof OperationInvocationError) return error.operationError;
  const auth = authorizationFailure(error, "access personal records");
  if (auth?.status === "error") return auth.error;
  const storage = storageFullOperationError(error);
  if (storage) return storage;
  const nodeRetry = nodeRetryOperationError(error);
  if (nodeRetry) return nodeRetry;
  const code = typeof error === "object" && error !== null ? (error as KvError).code : undefined;
  if (code === "SPACE_NOT_HOSTED") return operationError("NODE_ERROR", "Your TinyCloud storage space is not set up. Try again in a minute; if it still fails, ask for help setting up the space.", { details: { reason: "space_not_hosted" } });
  if (isOperationErrorCode(code)) return operationError(code, "The node could not complete this personal-record operation.");
  return operationError("NODE_ERROR", "The node could not complete this personal-record operation.", { retryable: true });
}
export function requireKv<T>(result: KvResult<T>): T {
  if (!result.ok) throw new OperationInvocationError(appsFailure(result.error));
  return result.data;
}
export async function listAppsKeys(kv: AppsKv, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = requireKv(await kv.list({ prefix, limit: 1000, ...(cursor === undefined ? {} : { cursor }) }));
    keys.push(...page.keys);
    cursor = page.nextCursor;
    if ((page.truncated && !cursor) || (cursor !== undefined && seen.has(cursor))) throw new OperationInvocationError(operationError("NODE_ERROR", "The node returned incomplete pagination."));
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return keys;
}
export async function readAppsRecords(kv: AppsKv, keys: readonly string[]): Promise<ReadRecord[]> {
  if (!keys.length) return [];
  if (keys.length > 100) throw new TypeError("Personal-record batch reads accept at most 100 keys.");
  const batch = requireKv(await kv.batchGet([...new Set(keys)]));
  const byKey = new Map(batch.results.map((entry) => [entry.key, entry.result]));
  return keys.map((key): ReadRecord => {
    const result = byKey.get(key);
    if (!result) throw new OperationInvocationError(operationError("NODE_ERROR", "The node omitted a requested record."));
    if (!result.ok) {
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") return { key, outcome: "NOT_FOUND" };
      throw new OperationInvocationError(appsFailure(result.error));
    }
    let value = result.data.data;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return { key, outcome: "MALFORMED" }; }
    }
    if (!isObject(value)) return { key, outcome: "MALFORMED" };
    const etag = result.data.headers.etag;
    if (typeof etag !== "string" || etag.length === 0) throw new OperationInvocationError(operationError("NODE_ERROR", "The node omitted the record's ETag; it cannot be safely edited."));
    return { key, value, etag };
  });
}
export function jsonBytes(value: JsonObject): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Mark derived data stale; a caller with committed writes must retain their outcomes if this throws. */
export async function markAppsKindStale(kv: AppsKv, layout: Layout, app: string, kind: string, at: string): Promise<void> {
  requireKv(await kv.put(staleKey(layout, app, kind), jsonBytes({ since: at.slice(0, 10), by: "tinycloud-mcp" }), {}));
}

/** Whether the session already holds read access to the app list; layout checks that need it are skipped without it. */
export function hasDiscoveryAccess(context: OperationContext): boolean {
  const expected = discoveryPermission(context);
  return context.runtime!.granted.some((grant) => grant.service === expected.service && grant.space === expected.space && grant.path === expected.path && Array.isArray(grant.actions) && grant.actions.includes("tinycloud.kv/get"));
}
/** True when the app's discovery entry exists, i.e. its records now live in the applications space. Best effort: false without access. */
export async function appHasMoved(context: OperationContext, app: string): Promise<boolean> {
  if (!hasDiscoveryAccess(context)) return false;
  const [entry] = await readAppsRecords(appsKv(context, "new"), [`${TC_APPS_DISCOVERY_ROOT}${app}/entry`]);
  return entry !== undefined && "value" in entry;
}
/** True when the older layout already holds this app's catalog record. */
export async function legacyHasApp(context: OperationContext, app: string): Promise<boolean> {
  const [record] = await readAppsRecords(appsKv(context, "legacy"), [`${TC_APPS_LEGACY_ROOT}catalog/${app}`]);
  return record !== undefined && !("outcome" in record && record.outcome === "NOT_FOUND");
}

/** Whether the session already holds read access to the older layout's catalog (any grant covering it counts). */
export function hasLegacyCatalogAccess(context: OperationContext): boolean {
  const resolve = operationSpaceResolver(context.runtime!.node, context.summary.space);
  return evaluateOperationAuthority(context.runtime!.granted as never, [legacyCatalogPermission(context)] as never, resolve).satisfied;
}

/**
 * OpenKey signs one space per delegation, so a call that needs scopes in both spaces asks for one space at a time:
 * the first space not yet fully granted. Once every scope is granted the whole list is returned and the call runs.
 */
export function oneSpaceAtATime(context: OperationContext, scopes: readonly AppsPermission[]): AppsPermission[] {
  const resolve = operationSpaceResolver(context.runtime!.node, context.summary.space);
  for (const space of new Set(scopes.map((scope) => scope.space))) {
    const group = scopes.filter((scope) => scope.space === space);
    if (!evaluateOperationAuthority(context.runtime!.granted as never, group as never, resolve).satisfied) return group;
  }
  return [...scopes];
}
