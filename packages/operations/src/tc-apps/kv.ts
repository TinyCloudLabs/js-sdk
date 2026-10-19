import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import { isOperationErrorCode, nodeRetryOperationError, OperationInvocationError, operationError, storageFullOperationError, type OperationError } from "../errors.js";
import { authorizationFailure } from "../kv-failure.js";
import { operationSpaceResolver } from "../secrets.js";
import { TC_APPS_RECORDS_ACTIONS, TC_APPS_ROOT } from "../tc-apps.js";
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

export function appsSpace(context: OperationContext): string {
  if (!context.runtime) throw new TypeError("Authenticated operation runtime is unavailable.");
  return operationSpaceResolver(context.runtime.node, context.summary.space)("default");
}
export function appsKv(context: OperationContext): AppsKv {
  const space = appsSpace(context);
  return (context.runtime!.node as TinyCloudNode).kvForSpace(space) as unknown as AppsKv;
}
export async function appsAuthority(context: RuntimeOperationContext) {
  return [{ service: "tinycloud.kv", space: appsSpace(context), path: TC_APPS_ROOT, actions: [...TC_APPS_RECORDS_ACTIONS] }];
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
  if (code === "SPACE_NOT_HOSTED") return operationError("NODE_ERROR", "Your TinyCloud default space is not set up. Try again in a minute; if it still fails, ask for help setting up the space.", { details: { reason: "space_not_hosted" } });
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
export async function markAppsKindStale(kv: AppsKv, app: string, kind: string, at: string): Promise<void> {
  requireKv(await kv.put(`${TC_APPS_ROOT}index-stale/${app}/${kind}`, jsonBytes({ since: at.slice(0, 10), by: "tinycloud-mcp" }), {}));
}
