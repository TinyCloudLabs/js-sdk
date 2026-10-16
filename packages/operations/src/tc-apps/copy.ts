import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import { OperationInvocationError, operationError } from "../errors.js";
import { TC_APPS_COPY_ACTIONS, TC_APPS_DATABASE, TC_APPS_ROOT } from "../tc-apps.js";
import { normalizeQueryResult } from "../operations/sql.js";
import { appsAuthority, appsFailure, appsSpace, listAppsKeys, markAppsKindStale, readAppsRecords, requireKv, withAppsWork, type AppsKv } from "./kv.js";
import { isObject, type JsonObject } from "./records.js";
import { diagnosticId, emitDiagnostic, getDiagnosticContext, type DiagnosticFields } from "../diagnostics.js";

export type AppsDatabase = ReturnType<ReturnType<TinyCloudNode["sqlForSpace"]>["db"]>;
export interface CopyKind { app: string; kind: string }
export interface CopyRow { k: string; r?: JsonObject }
export const COPY_REQUEST_LIMIT = 1.5 * 1024 * 1024;
export const COPY_INSERT = "INSERT OR REPLACE INTO records (key, rec) SELECT json_extract(value, '$.k'), json_extract(value, '$.r') FROM json_each(?) WHERE json_extract(value, '$.r') IS NOT NULL";
export const COPY_DELETE = "DELETE FROM records WHERE key IN (SELECT json_extract(value, '$.k') FROM json_each(?) WHERE json_extract(value, '$.r') IS NULL)";
const CREATE_TABLE = "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, rec TEXT NOT NULL)";
const CREATE_VIEW = "CREATE VIEW IF NOT EXISTS entries AS SELECT key, app, kind, substr(r2, 1, instr(r2, '/') - 1) AS folder, substr(r2, instr(r2, '/') + 1) AS id, substr(r2, instr(r2, '/') + 1, 10) AS day, json_extract(rec, '$.v') AS v, json_extract(rec, '$.at') AS at, json_extract(rec, '$.by') AS by, json_extract(rec, '$.data') AS data, rec FROM (SELECT key, rec, app, substr(r1, 1, instr(r1, '/') - 1) AS kind, substr(r1, instr(r1, '/') + 1) AS r2 FROM (SELECT key, rec, substr(p, 1, instr(p, '/') - 1) AS app, substr(p, instr(p, '/') + 1) AS r1 FROM (SELECT key, rec, substr(key, 26) AS p FROM records)))";

export function copyPermission(context: OperationContext) {
  return { service: "tinycloud.sql", space: appsSpace(context), path: TC_APPS_DATABASE, actions: [...TC_APPS_COPY_ACTIONS] };
}
export async function appsQueryAuthority(context: RuntimeOperationContext) {
  return [...await appsAuthority(context), copyPermission(context)];
}
export function hasCopyAuthority(context: OperationContext): boolean {
  const expected = copyPermission(context);
  const allowed = context.runtime!.granted.some((grant) => {
    const actions = grant.actions;
    return grant.service === expected.service && grant.space === expected.space && grant.path === expected.path && Array.isArray(actions) && expected.actions.every((action) => actions.includes(action));
  });
  emitDiagnostic({ type: "operation.step", phase: "authority_planning", role: "copy", outcome: allowed ? "pass" : "fail" });
  return allowed;
}
export function appsDatabase(context: OperationContext): AppsDatabase {
  return (context.runtime!.node as TinyCloudNode).sqlForSpace(appsSpace(context)).db(TC_APPS_DATABASE);
}
function missingSchema(error: unknown): boolean {
  return isObject(error) && (error.code === "SQL_DATABASE_NOT_FOUND" || (typeof error.message === "string" && /no such (?:table|view)/i.test(error.message)));
}
export function copyFailure(error: unknown): OperationInvocationError {
  if (isObject(error) && isObject(error.meta) && error.meta.status === 409) return new OperationInvocationError(operationError("NODE_ERROR", "The fast, searchable copy is unavailable and needs the node team. Answer from the records; do not retry or ask for another approval.", { retryable: false, details: { reason: "copy_unavailable" } }));
  if (isObject(error) && error.code === "SQL_RESPONSE_TOO_LARGE") return new OperationInvocationError(operationError("SQL_RESULT_LIMIT_EXCEEDED", "Narrow the fast-copy query to return fewer records or fields."));
  return new OperationInvocationError(appsFailure(error));
}
async function execute(db: AppsDatabase, sql: string, params: string[] = [], action: DiagnosticFields["action"] = "execute"): Promise<void> {
  try {
    const result = await db.execute(sql, params);
    if (!result.ok) throw result.error;
    emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action, mutation: "confirmed", verification: "write_response", outcome: "complete" });
  } catch (error) {
    emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action, mutation: "unknown", outcome: "failed" });
    throw error;
  }
}
async function createSchema(db: AppsDatabase): Promise<void> {
  return withAppsWork({ phase: "copy", role: "copy", action: "create" }, async () => {
    await execute(db, CREATE_TABLE);
    await execute(db, CREATE_VIEW);
  });
}
/** Each parameter is a JSON array; size includes its second escaping in the SDK request body. */
export function copyRowChunks(rows: readonly CopyRow[], limit = COPY_REQUEST_LIMIT): string[] {
  const overhead = Math.max(...[COPY_INSERT, COPY_DELETE].map((sql) => Buffer.byteLength(JSON.stringify({ action: "execute", sql, params: ["[]"] }))));
  const chunks: string[] = [];
  let encoded: string[] = [];
  let bytes = overhead;
  for (const row of rows) {
    const text = JSON.stringify(row);
    const size = Buffer.byteLength(JSON.stringify(text)) - 2;
    if (overhead + size >= limit) {
      emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", warning: "size_limit", bytes: overhead + size, outcome: "refused", mutation: "not_dispatched" });
      throw new OperationInvocationError(operationError("NODE_ERROR", "One record is too large to safely copy; read it from the records instead.", { retryable: false }));
    }
    if (bytes + size + (encoded.length ? 1 : 0) >= limit) {
      chunks.push(`[${encoded.join(",")}]`);
      emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "upsert", ordinal: chunks.length, bytes, requested: encoded.length });
      encoded = [];
      bytes = overhead;
    }
    bytes += size + (encoded.length ? 1 : 0);
    encoded.push(text);
  }
  if (encoded.length) {
    chunks.push(`[${encoded.join(",")}]`);
    emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "upsert", ordinal: chunks.length, bytes, requested: encoded.length });
  }
  return chunks;
}
export async function syncCopyRows(db: AppsDatabase, rows: readonly CopyRow[]): Promise<void> {
  const chunks = copyRowChunks(rows);
  for (const [index, chunk] of chunks.entries()) {
    await withAppsWork({ phase: "copy", role: "copy", action: "upsert", ordinal: index + 1, chunks: chunks.length }, async () => {
      for (let attempt = 0; ; attempt++) {
        let attempt_id: string | undefined;
        try { if (getDiagnosticContext()) attempt_id = diagnosticId(); } catch { /* Capture cannot affect the existing retry. */ }
        const started = attempt_id === undefined ? undefined : performance.now();
        emitDiagnostic({ type: "attempt.start", role: "copy", action: "upsert", layer: "copy_chunk", attempt_id, ordinal: attempt + 1 });
        try {
          await execute(db, COPY_INSERT, [chunk], "upsert");
          await execute(db, COPY_DELETE, [chunk], "delete");
          emitDiagnostic({ type: "attempt.finish", role: "copy", action: "upsert", layer: "copy_chunk", attempt_id, ordinal: attempt + 1, outcome: "complete", duration_ms: started === undefined ? undefined : performance.now() - started, timing_scope: "copy_chunk" });
          break;
        } catch (error) {
          emitDiagnostic({ type: "attempt.finish", role: "copy", action: "upsert", layer: "copy_chunk", attempt_id, ordinal: attempt + 1, outcome: "failed", duration_ms: started === undefined ? undefined : performance.now() - started, timing_scope: "copy_chunk" });
          const failure = copyFailure(error);
          if (missingSchema(error) || failure.operationError.details?.reason === "copy_unavailable" || attempt === 1) throw failure;
          emitDiagnostic({ type: "retry.scheduled", phase: "copy", role: "copy", layer: "copy_chunk", attempt_id, retries: 1, ordinal: attempt + 2 });
        }
      }
    });
  }
}
async function schemaRetry<T>(db: AppsDatabase, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!missingSchema(error)) throw error;
    emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "create", warning: "schema_warning", outcome: "started" });
    await createSchema(db);
    emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "query", retries: 1, outcome: "started" });
    return run();
  }
}
export async function queryCopy(db: AppsDatabase, sql: string, params: (null | number | string | Uint8Array)[]) {
  return withAppsWork({ phase: "copy", role: "copy", action: "query" }, async (finish) => {
    try {
      const result = await schemaRetry(db, async () => {
        const result = await db.query(sql, params, { maxRows: 1000, maxBytes: 1024 * 1024 });
        if (!result.ok) throw result.error;
        return result.data;
      });
      const normalized = normalizeQueryResult(result, 1000, 1024 * 1024);
      finish({ returned: normalized.rows.length, outcome: "complete" });
      return { ...normalized, rowCount: normalized.rows.length };
    } catch (error) {
      const failure = copyFailure(error);
      finish({ outcome: "failed", ...(failure.operationError.details?.reason === "copy_unavailable" ? { copy_state: "unavailable", warning: "copy_unavailable" } : failure.operationError.code === "SQL_RESULT_LIMIT_EXCEEDED" ? { warning: "size_limit" } : {}) });
      throw failure;
    }
  });
}
async function countCopy(db: AppsDatabase, prefix: string): Promise<number> {
  const result = await queryCopy(db, "SELECT count(*) AS n FROM records WHERE instr(key, ?) = 1", [prefix]);
  const count = result.rows[0]?.[0];
  if (result.rows.length !== 1 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw copyFailure(undefined);
  return count;
}
/** Finishes a started kind, but never starts another after the elapsed-time budget. */
export async function checkCopyKinds(kv: AppsKv, db: AppsDatabase, kinds: readonly CopyKind[], clock: () => number = Date.now): Promise<{ kinds: (CopyKind & { records: number })[] } | { outcome: "COPY_PARTIAL"; remaining: CopyKind[] }> {
  const started = clock();
  const checked: (CopyKind & { records: number })[] = [];
  try {
    const stale = new Set(await listAppsKeys(kv, `${TC_APPS_ROOT}index-stale/`));
    for (let index = 0; index < kinds.length; index++) {
      if (clock() - started >= 60_000) {
        const remaining = kinds.slice(index);
        for (const kind of remaining) await markAppsKindStale(kv, kind.app, kind.kind, new Date().toISOString());
        emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "index", copy_state: "partial", warning: "copy_partial", requested: kinds.length, returned: checked.length, outcome: "partial" });
        return { outcome: "COPY_PARTIAL", remaining };
      }
      const kind = kinds[index]!;
      await withAppsWork({ phase: "copy", role: "copy", action: "index", ordinal: index + 1 }, async (finish) => {
        const prefix = `${TC_APPS_ROOT}${kind.app}/${kind.kind}/`;
        const marker = `${TC_APPS_ROOT}index-stale/${kind.app}/${kind.kind}`;
        const count = await countCopy(db, prefix);
        const keys = await listAppsKeys(kv, prefix);
        emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "count_check", copy_check: "count", requested: keys.length, returned: count, verification_result: count === keys.length ? "match" : "mismatch" });
        if (stale.has(marker) || count !== keys.length) {
          await withAppsWork({ phase: "copy", role: "copy", action: "rebuild", copy_check: "rebuild" }, async (finishRebuild) => {
            await markAppsKindStale(kv, kind.app, kind.kind, new Date().toISOString());
            const marked = (await readAppsRecords(kv, [marker]))[0]!;
            if (!("value" in marked)) throw copyFailure(undefined);
            await execute(db, "DELETE FROM records WHERE instr(key, ?) = 1", [prefix], "delete");
            for (let offset = 0; offset < keys.length; offset += 100) {
              const records = await readAppsRecords(kv, keys.slice(offset, offset + 100));
              const rows: CopyRow[] = records.map((record) => {
                if (!("value" in record)) throw new OperationInvocationError(operationError("NODE_ERROR", "A listed record disappeared or is malformed; the kind remains stale."));
                return { k: record.key, r: record.value };
              });
              await syncCopyRows(db, rows);
            }
            const verifiedCount = await countCopy(db, prefix);
            const verifiedKeys = await listAppsKeys(kv, prefix);
            const original = new Set(keys);
            const sameKeys = verifiedKeys.length === keys.length && !verifiedKeys.some((key) => !original.has(key));
            emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "count_check", copy_check: "count", requested: keys.length, returned: verifiedCount, verification_result: verifiedCount === keys.length ? "match" : "mismatch" });
            // This compares canonical KV keys before/after, never SQL keys or record values.
            emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "key_set_check", copy_check: "key_set", requested: keys.length, returned: verifiedKeys.length, verification_result: sameKeys ? "match" : "mismatch" });
            if (verifiedCount !== keys.length || !sameKeys) throw new OperationInvocationError(operationError("NODE_ERROR", "The records changed during the rebuild; the kind remains stale.", { retryable: true }));
            let mutation: DiagnosticFields["mutation"] = "unknown";
            try {
              const removed = await kv.delete(marker, { ifMatch: marked.etag });
              if (!removed.ok && removed.error.code === "KV_PRECONDITION_FAILED") mutation = "rejected";
              requireKv(removed);
              emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "stale_mark", mutation: "confirmed", verification: "write_response", copy_state: "ready", outcome: "complete" });
            } catch (error) {
              emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "stale_mark", mutation, copy_state: "unknown", outcome: "failed" });
              throw error;
            }
            finishRebuild({ outcome: "complete" });
          });
        }
        checked.push({ ...kind, records: keys.length });
        finish({ returned: keys.length, copy_state: "ready", outcome: "complete" });
      });
    }
    return { kinds: checked };
  } catch (error) { throw copyFailure(error); }
}
