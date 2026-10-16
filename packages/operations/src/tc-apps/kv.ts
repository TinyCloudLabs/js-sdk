import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import { isOperationErrorCode, OperationInvocationError, operationError, storageFullOperationError, type OperationError } from "../errors.js";
import { authorizationFailure } from "../kv-failure.js";
import { operationSpaceResolver } from "../secrets.js";
import { TC_APPS_RECORDS_ACTIONS, TC_APPS_ROOT } from "../tc-apps.js";
import { isObject, type JsonObject } from "./records.js";
import { beginDiagnosticPhase, diagnosticId, emitDiagnostic, getDiagnosticContext, withDiagnosticContext, type DiagnosticFields } from "../diagnostics.js";

const unobserved = (_fields?: DiagnosticFields): void => {};
/** A logical apps boundary owns its immutable scope, including physical SDK children. */
export async function withAppsWork<T>(fields: DiagnosticFields, run: (finish: (fields?: DiagnosticFields) => void) => Promise<T>): Promise<T> {
  const current = getDiagnosticContext();
  if (!current) return run(unobserved);
  let operation_id: string;
  try { operation_id = diagnosticId(); } catch { return run(unobserved); }
  const child = { ...current, operation_id, parent_id: current.operation_id ?? current.invocation_id, role: fields.role ?? current.role, role_provenance: "observed" as const };
  return withDiagnosticContext(child, async () => {
    const finish = beginDiagnosticPhase(fields.phase ?? "execution", { ...fields, operation_id });
    try {
      const result = await run(finish);
      finish({ outcome: "complete" });
      return result;
    } catch (error) {
      finish({ outcome: "failed" });
      throw error;
    }
  });
}

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
  return withAppsWork({ action: "list", service: "kv" }, async (finish) => {
    const keys: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    let pages = 0;
    try {
      do {
        const page = requireKv(await kv.list({ prefix, limit: 1000, ...(cursor === undefined ? {} : { cursor }) }));
        pages++;
        keys.push(...page.keys);
        cursor = page.nextCursor;
        if ((page.truncated && !cursor) || (cursor !== undefined && seen.has(cursor))) {
          emitDiagnostic({ type: "operation.step", action: "list", warning: "pagination_incomplete", pages, returned: keys.length, truncated: true, outcome: "failed" });
          throw new OperationInvocationError(operationError("NODE_ERROR", "The node returned incomplete pagination."));
        }
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined);
      finish({ pages, returned: keys.length, truncated: false, outcome: "complete" });
      return keys;
    } catch (error) {
      finish({ pages, returned: keys.length, outcome: "failed" });
      throw error;
    }
  });
}
export async function readAppsRecords(kv: AppsKv, keys: readonly string[]): Promise<ReadRecord[]> {
  if (!keys.length) return [];
  if (keys.length > 100) throw new TypeError("Personal-record batch reads accept at most 100 keys.");
  const unique = [...new Set(keys)];
  return withAppsWork({ action: "batchGet", service: "kv", requested: keys.length, unique: unique.length }, async (finish) => {
    // Returned counts readable input slots, not raw service entries or delivered output.
    let returned = 0;
    let missing = 0;
    let malformed = 0;
    try {
      const batch = requireKv(await kv.batchGet(unique));
      const byKey = new Map(batch.results.map((entry) => [entry.key, entry.result]));
      const records = keys.map((key, index): ReadRecord => {
        const result = byKey.get(key);
        if (!result) {
          emitDiagnostic({ type: "operation.step", action: "read", ordinal: index + 1, warning: "read_member_omitted", outcome: "failed" });
          throw new OperationInvocationError(operationError("NODE_ERROR", "The node omitted a requested record."));
        }
        if (!result.ok) {
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            missing++;
            emitDiagnostic({ type: "operation.step", action: "read", ordinal: index + 1, warning: "read_partial", verification_result: "missing" });
            return { key, outcome: "NOT_FOUND" };
          }
          throw new OperationInvocationError(appsFailure(result.error));
        }
        let value = result.data.data;
        if (typeof value === "string") {
          try { value = JSON.parse(value); } catch {
            malformed++;
            emitDiagnostic({ type: "operation.step", action: "read", ordinal: index + 1, warning: "malformed_record", verification_result: "failed" });
            return { key, outcome: "MALFORMED" };
          }
        }
        if (!isObject(value)) {
          malformed++;
          emitDiagnostic({ type: "operation.step", action: "read", ordinal: index + 1, warning: "malformed_record", verification_result: "failed" });
          return { key, outcome: "MALFORMED" };
        }
        const etag = result.data.headers.etag;
        if (typeof etag !== "string" || etag.length === 0) {
          emitDiagnostic({ type: "operation.step", action: "read", ordinal: index + 1, warning: "read_etag_missing", outcome: "failed" });
          throw new OperationInvocationError(operationError("NODE_ERROR", "The node omitted the record's ETag; it cannot be safely edited."));
        }
        returned++;
        return { key, value, etag };
      });
      finish({ returned, missing, malformed, outcome: missing || malformed ? "partial" : "complete" });
      return records;
    } catch (error) {
      finish({ returned, missing, malformed, outcome: "failed" });
      throw error;
    }
  });
}
export function jsonBytes(value: JsonObject): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Mark derived data stale; a caller with committed writes must retain their outcomes if this throws. */
export async function markAppsKindStale(kv: AppsKv, app: string, kind: string, at: string): Promise<void> {
  return withAppsWork({ phase: "copy", role: "copy", action: "stale_mark", service: "kv" }, async (finish) => {
    try {
      requireKv(await kv.put(`${TC_APPS_ROOT}index-stale/${app}/${kind}`, jsonBytes({ since: at.slice(0, 10), by: "tinycloud-mcp" }), {}));
      finish({ mutation: "confirmed", verification: "write_response", copy_state: "stale", outcome: "complete" });
    } catch (error) {
      finish({ mutation: "unknown", copy_state: "unknown", warning: "stale_mark_failed", outcome: "failed" });
      throw error;
    }
  });
}
