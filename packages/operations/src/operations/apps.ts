import { z } from "zod";
import type { OperationContext, OperationDefinition, OperationExecutionOutcome, OperationExposure, TinyCloudPosture } from "../contract.js";
import { OPERATION_ERROR_CODES, operationError } from "../errors.js";
import { TC_APPS_ROOT } from "../tc-apps.js";
import { TC_APPS_RULES } from "../tc-apps/rules.generated.js";
import { appsDatabase, appsQueryAuthority, checkCopyKinds, hasCopyAuthority, queryCopy, syncCopyRows, type CopyRow } from "../tc-apps/copy.js";
import { decodeSqlInputValue, isSingleReadQuery, SqlOutputValueSchema, SqlParamsSchema } from "./sql.js";
import { appsAuthority, appsFailure, appsKv, appsSpace, jsonBytes, listAppsKeys, markAppsKindStale, readAppsRecords, withAppsWork, type AppsKv, type KvResult, type KvValue } from "../tc-apps/kv.js";
import { appsCopyState, appsNow, appsTimezone, validTimezone, withLocalOffset } from "../tc-apps/state.js";
import { catalogChangeAllowed, catalogParts, isObject, KeySchema, newRecordFits, ObjectSchema, PrefixSchema, recordParts, recordWarnings, WriteInputSchema, type JsonObject, type WriteInput, type WriteOp } from "../tc-apps/records.js";
import { emitDiagnostic, type DiagnosticFields } from "../diagnostics.js";

const ContextInputSchema = z.object({ timezone: z.string().refine(validTimezone, "An IANA timezone is required.").optional() }).strict();
const ReadInputSchema = z.object({ prefixes: z.array(PrefixSchema).optional(), keys: z.array(KeySchema).max(100).optional() }).strict();
const RecordSchema = z.object({ key: z.string(), value: ObjectSchema, etag: z.string().min(1) }).strict();
const ReadRecordSchema = z.union([RecordSchema, z.object({ key: z.string(), outcome: z.enum(["NOT_FOUND", "MALFORMED"]) }).strict()]);
const ContextOutputSchema = z.object({
  rules: z.string(), now: z.string(), timezone: z.string().nullable(),
  catalog: z.object({ keys: z.array(z.string()), records: z.array(RecordSchema).optional() }).strict(),
  copy: z.enum(["present", "expired", "none"]),
}).strict();
const ReadOutputSchema = z.object({ lists: z.array(z.object({ prefix: z.string(), keys: z.array(z.string()) }).strict()), records: z.array(ReadRecordSchema) }).strict();
const OpOutcomeSchema = z.object({
  key: z.string(), outcome: z.enum(["ok", "EXISTS", "CHANGED", "CATALOG_CHANGE", "INVALID", "NOT_FOUND", "TIMEZONE_REQUIRED", ...OPERATION_ERROR_CODES]),
  etag: z.string().optional(), value: ObjectSchema.optional(), steps: z.array(z.enum(["written", "deleted"])).optional(), warnings: z.array(z.string()).optional(),
}).strict();
const WriteOutputSchema = z.object({ ops: z.array(OpOutcomeSchema) }).strict();
const CopyKindSchema = z.object({ app: z.string().regex(/^[a-z0-9-]+$/).refine((app) => app !== "catalog" && app !== "index-stale"), kind: z.string().regex(/^[a-z0-9-]+$/) }).strict();
const QueryInputSchema = z.object({ kinds: z.array(CopyKindSchema).min(1), sql: z.string().min(1).max(64 * 1024).refine(isSingleReadQuery, "SQL must be one SELECT or WITH query."), params: SqlParamsSchema.optional() }).strict();
const QueryOutputSchema = z.union([
  z.object({ kinds: z.array(CopyKindSchema.extend({ records: z.number().int().nonnegative() })), columns: z.array(z.string()), rows: z.array(z.array(SqlOutputValueSchema)), rowCount: z.number().int().nonnegative() }).strict(),
  z.object({ outcome: z.literal("COPY_PARTIAL"), remaining: z.array(CopyKindSchema) }).strict(),
]);
type QueryInput = z.infer<typeof QueryInputSchema>;
export type QueryOutput = z.infer<typeof QueryOutputSchema>;
type ContextInput = z.infer<typeof ContextInputSchema>;
export type ContextOutput = z.infer<typeof ContextOutputSchema>;
type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadOutput = z.infer<typeof ReadOutputSchema>;
export type WriteOutput = z.infer<typeof WriteOutputSchema>;
type OpOutcome = z.infer<typeof OpOutcomeSchema>;
const POSTURES: readonly TinyCloudPosture[] = ["owner-openkey", "delegate-session", "local-owner-key"];
const EXPOSURE: OperationExposure = {
  cli: { status: "excluded", reason: "Personal apps use the hosted connector; the CLI skill keeps its existing commands." },
  mcp: { status: "required" }, skill: { status: "required" }, docs: { status: "required" },
};

export const appsOperationDefinitions: readonly (
  OperationDefinition<ContextInput, ContextOutput> | OperationDefinition<ReadInput, ReadOutput> | OperationDefinition<WriteInput, WriteOutput> | OperationDefinition<QueryInput, QueryOutput>
)[] = [
  {
    id: "tinycloud.apps.context", version: 1, title: "Personal apps context",
    description: "Personal records kept in the user's TinyCloud: weight, workouts, goals, todos, anything they track. Use it whenever the user asks to log, record, track, add, look up, list or sum up something about their life, even without mentioning TinyCloud. Call it first: it returns the rules, the user's local time and their apps.",
    input: ContextInputSchema, output: ContextOutputSchema, effects: ["read"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/timezone"], output: ["/catalog", "/timezone", "/now"] }, authority: appsAuthority, execute: observeAppsExecution("apps_context", "catalog", executeContext),
  },
  {
    id: "tinycloud.apps.read", version: 1, title: "Read personal records", description: "List personal-record prefixes in full and read up to 100 records with their ETags. Read fresh before answering or editing.",
    input: ReadInputSchema, output: ReadOutputSchema, effects: ["read"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/prefixes", "/keys"], output: ["/lists", "/records"] }, authority: appsAuthority, execute: observeAppsExecution("apps_read", "record", executeRead),
  },
  {
    id: "tinycloud.apps.write", version: 1, title: "Write personal records", description: "Run 1–10 personal-record puts, moves or requested deletes in order. Omit an ETag to create; supply the read ETag to replace. Catalog writes may precede their records in the same call. Inspect every outcome and any completed move steps before retrying.",
    input: WriteInputSchema, output: WriteOutputSchema, effects: ["destructive"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/ops"], output: ["/ops"] }, authority: appsAuthority, execute: observeAppsExecution("apps_write", "record", executeWrite),
  },
  {
    id: "tinycloud.apps.query", version: 1, title: "Query personal records", description: "Answer questions over many personal records using a fast, searchable copy. List every app and kind covered; the server checks and rebuilds their copy before running one SELECT or WITH query with bound params. COPY_PARTIAL means retry with the remaining kinds before answering.",
    input: QueryInputSchema, output: QueryOutputSchema, effects: ["read"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/kinds", "/sql", "/params"], output: ["/kinds", "/rows", "/remaining"] }, authority: appsQueryAuthority, execute: observeAppsExecution("apps_index", "copy", executeQuery),
  },
];

/** Handler completion is not business completeness; writes report their measured steps. */
function observeAppsExecution<I, O>(activity: DiagnosticFields["activity"], role: DiagnosticFields["role"], execute: (context: OperationContext, input: I) => Promise<OperationExecutionOutcome<O>>) {
  return (context: OperationContext, input: I): Promise<OperationExecutionOutcome<O>> => withAppsWork({ activity, role }, async (finish) => {
    try {
      const result = await execute(context, input);
      // Successful write/read/query handlers own their more precise summaries below.
      if (result.status !== "ok" || activity === "apps_context") {
        emitDiagnostic({ type: "operation.step", phase: "execution", activity, role, business: result.status === "ok" ? "complete" : "failed" });
      }
      finish({ canonical_status: result.status, outcome: result.status === "ok" ? "complete" : "failed" });
      return result;
    } catch (error) {
      emitDiagnostic({ type: "operation.step", phase: "execution", activity, role, business: "failed" });
      throw error;
    }
  });
}

async function executeContext(context: OperationContext, input: ContextInput): Promise<OperationExecutionOutcome<ContextOutput>> {
  const parsed = ContextInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "An IANA timezone is required.") };
  try {
    const timezone = await appsTimezone(context.summary.profile, parsed.data.timezone);
    const kv = appsKv(context);
    const keys = await listAppsKeys(kv, `${TC_APPS_ROOT}catalog/`);
    let records: z.infer<typeof RecordSchema>[] | undefined;
    if (keys.length <= 40) {
      const read = await readAppsRecords(kv, keys);
      if (read.some((record) => "outcome" in record)) return { status: "error", error: operationError("NODE_ERROR", "A catalog record is missing or malformed. Read its key to inspect it.") };
      records = read as z.infer<typeof RecordSchema>[];
    } else {
      emitDiagnostic({ type: "operation.step", action: "read", role: "catalog", requested: keys.length, returned: 0, outcome: "skipped" });
    }
    return { status: "ok", output: { rules: TC_APPS_RULES, now: appsNow(timezone), timezone, catalog: { keys, ...(records === undefined ? {} : { records }) }, copy: await appsCopyState(context.summary.profile, appsSpace(context)) } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}
async function executeRead(context: OperationContext, input: ReadInput): Promise<OperationExecutionOutcome<ReadOutput>> {
  const parsed = ReadInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Personal-record keys or prefixes are invalid; read at most 100 keys.") };
  try {
    const kv = appsKv(context);
    const lists = [];
    for (const prefix of parsed.data.prefixes ?? []) lists.push({ prefix, keys: await listAppsKeys(kv, prefix) });
    const records = await readAppsRecords(kv, parsed.data.keys ?? []);
    let missing = 0;
    let malformed = 0;
    for (const record of records) if ("outcome" in record) {
      if (record.outcome === "NOT_FOUND") missing++;
      else malformed++;
    }
    emitDiagnostic({ type: "operation.step", phase: "execution", activity: "apps_read", role: "record", business: missing || malformed ? "partial" : "complete", requested: records.length, returned: records.length - missing - malformed, missing, malformed, verification: records.length ? "read_back" : "none", verification_result: missing || malformed ? "failed" : records.length ? "found" : "not_applicable" });
    return { status: "ok", output: { lists, records } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}

async function executeQuery(context: OperationContext, input: QueryInput): Promise<OperationExecutionOutcome<QueryOutput>> {
  const parsed = QueryInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "List valid app/kind names and supply one read-only SELECT or WITH query with bound parameters.") };
  try {
    const db = appsDatabase(context);
    const unique = [...new Map(parsed.data.kinds.map((kind) => [`${kind.app}/${kind.kind}`, kind])).values()];
    emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "index", requested: parsed.data.kinds.length, unique: unique.length });
    const checked = await checkCopyKinds(appsKv(context), db, unique);
    if ("outcome" in checked) {
      emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "query", outcome: "skipped" });
      emitDiagnostic({ type: "operation.step", phase: "execution", activity: "apps_index", role: "copy", business: "partial", copy_state: "partial", warning: "copy_partial", requested: unique.length, returned: unique.length - checked.remaining.length });
      return { status: "ok", output: checked };
    }
    const result = await queryCopy(db, parsed.data.sql, (parsed.data.params ?? []).map(decodeSqlInputValue));
    emitDiagnostic({ type: "operation.step", phase: "execution", activity: "apps_index", role: "copy", business: "complete", requested: unique.length, returned: checked.kinds.length });
    return { status: "ok", output: { ...checked, ...result, columns: [...result.columns], rows: result.rows.map((row) => [...row]) } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}

async function executeWrite(context: OperationContext, input: WriteInput): Promise<OperationExecutionOutcome<WriteOutput>> {
  // Validate the entire batch before obtaining a handle or executing its first op.
  const parsed = WriteInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Every op must have a valid personal-record key and JSON record or catalog value.", { details: { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) } }) };
  let kv: AppsKv;
  let timezone: string | null;
  try { kv = appsKv(context); timezone = await appsTimezone(context.summary.profile); }
  catch (error) { return { status: "error", error: appsFailure(error) }; }
  const ops: OpOutcome[] = [];
  const touched = new Map<string, OpOutcome[]>();
  const rows = new Map<string, CopyRow>();
  const refresh = new Set<string>();
  let mutations = 0;
  let attempted = false;
  let uncertain = false;
  for (const [index, op] of parsed.data.ops.entries()) {
    const key = op.op === "move" ? op.to : op.key;
    const evidence: RecordMutationEvidence = { confirmed: 0, attempted: false, unknown: false };
    const member: DiagnosticFields = {
      role: catalogParts(key) ? "catalog" : "record", ordinal: index + 1,
      action: op.op === "put" ? op.etag === undefined ? "create" : "replace" : op.op,
    };
    const outcome = await withAppsWork(member, async (finish) => {
      let result: OpOutcome;
      try { result = await writeOne(kv, op, timezone, evidence); }
      catch (error) { result = { key, outcome: appsFailure(error).code }; }
      const observed: DiagnosticFields = {
        business: result.outcome === "ok" ? "complete" : evidence.confirmed ? "partial" : "failed",
        mutation: evidence.unknown ? "unknown" : evidence.confirmed ? "confirmed" : evidence.attempted ? "rejected" : "not_dispatched",
        mutations: evidence.confirmed, outcome: result.outcome === "ok" ? "complete" : "failed",
        ...(result.outcome === "TIMEZONE_REQUIRED" ? { error_class: "timezone_required" } : result.outcome === "CATALOG_CHANGE" ? { error_class: "catalog_change" } : {}),
      };
      emitDiagnostic({ type: "operation.step", ...member, ...observed });
      finish(observed);
      return result;
    });
    mutations += evidence.confirmed;
    uncertain ||= evidence.unknown;
    attempted ||= evidence.attempted;
    ops.push(outcome);
    if (outcome.outcome === "ok" || outcome.steps?.includes("written")) {
      const keys = op.op === "move" ? [outcome.key, op.from] : [outcome.key];
      if (op.op === "move" && !outcome.steps?.includes("deleted")) refresh.add(op.from);
      for (const changed of keys) {
        if (!catalogParts(changed)) rows.set(changed, { k: changed, ...(changed === outcome.key && op.op !== "delete" && outcome.value ? { r: outcome.value } : {}) });
        const catalog = catalogParts(changed);
        const parts = catalog ?? recordParts(changed);
        if (parts.kind === undefined) continue;
        const marker = `${parts.app}/${parts.kind}`;
        const owners = touched.get(marker) ?? [];
        if (!owners.includes(outcome)) owners.push(outcome);
        touched.set(marker, owners);
      }
    }
  }
  // Upkeep must never erase committed outcomes or turn a refusal into an approval loop.
  let synced = false;
  let upkeepWarning: string | undefined;
  try {
    if (hasCopyAuthority(context)) {
      await withAppsWork({ phase: "copy", role: "copy", action: "upsert" }, async (finish) => {
        const sources = await withAppsWork({ phase: "copy", role: "copy", action: "source_read", requested: refresh.size }, () => readAppsRecords(kv, [...refresh]));
        for (const record of sources) {
          if ("value" in record) rows.set(record.key, { k: record.key, r: record.value });
          else if (record.outcome === "NOT_FOUND") rows.set(record.key, { k: record.key });
          else throw new Error("A move source is malformed.");
        }
        await syncCopyRows(appsDatabase(context), [...rows.values()]);
        synced = true;
        finish({ outcome: "complete" });
      });
    }
  } catch (error) {
    const failure = appsFailure(error);
    upkeepWarning = failure.details?.reason === "copy_unavailable"
      ? "The record changed, but the fast copy needs the node team. Answer from records; do not retry or ask for another approval."
      : `The record changed, but fast-copy upkeep failed (${failure.code}); its kind is marked stale.`;
    emitDiagnostic({ type: "operation.step", phase: "copy", role: "copy", action: "upsert", outcome: "failed", copy_state: failure.details?.reason === "copy_unavailable" ? "unavailable" : "failed", warning: failure.details?.reason === "copy_unavailable" ? "copy_unavailable" : "copy_maintenance_failed" });
  }
  for (const [key, owners] of touched) {
    if (upkeepWarning) for (const owner of owners) (owner.warnings ??= []).push(upkeepWarning);
    if (synced && rows.size > 0) continue;
    try {
      const [app, kind] = key.split("/");
      await markAppsKindStale(kv, app!, kind!, appsNow(timezone));
    } catch (error) {
      const code = appsFailure(error).code;
      for (const owner of owners) (owner.warnings ??= []).push(`The record changed, but its fast-copy stale mark failed (${code}); rebuild this kind before relying on the copy.`);
    }
  }
  let completed = 0;
  for (const op of ops) if (op.outcome === "ok") completed++;
  emitDiagnostic({ type: "operation.step", phase: "execution", activity: "apps_write", role: "record", requested: ops.length, returned: completed, mutations, business: completed === ops.length ? "complete" : completed || mutations ? "partial" : "failed", mutation: uncertain ? "unknown" : mutations ? "confirmed" : attempted ? "rejected" : "not_dispatched" });
  return { status: "ok", output: { ops } };
}

interface RecordMutationEvidence { confirmed: number; attempted: boolean; unknown: boolean }

/** Responses confirm writes; application errors alone cannot establish dispatch or commit. */
async function mutateRecord(action: DiagnosticFields["action"], evidence: RecordMutationEvidence, run: () => Promise<KvResult<KvValue>>): Promise<KvResult<KvValue>> {
  evidence.attempted = true;
  try {
    const result = await run();
    if (result.ok) {
      evidence.confirmed++;
      emitDiagnostic({ type: "operation.step", action, mutation: "confirmed", mutations: 1, verification: "write_response", outcome: "complete" });
    } else {
      const rejected = result.error.code === "KV_PRECONDITION_FAILED" || result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND";
      evidence.unknown ||= !rejected;
      emitDiagnostic({ type: "operation.step", action, mutation: rejected ? "rejected" : "unknown", outcome: "failed", ...(result.error.code === "KV_PRECONDITION_FAILED" ? { error_class: "precondition" } : {}) });
    }
    return result;
  } catch (error) {
    evidence.unknown = true;
    emitDiagnostic({ type: "operation.step", action, mutation: "unknown", outcome: "failed" });
    throw error;
  }
}
async function conflict(kv: AppsKv, key: string, outcome: "EXISTS" | "CHANGED" | "CATALOG_CHANGE"): Promise<OpOutcome> {
  const current = (await readAppsRecords(kv, [key]))[0]!;
  if ("outcome" in current) {
    if (current.outcome === "MALFORMED") emitDiagnostic({ type: "operation.step", warning: "malformed_record", action: "read" });
    return { key, outcome: current.outcome === "NOT_FOUND" ? "NOT_FOUND" : "INVALID", ...(current.outcome === "MALFORMED" ? { warnings: ["The stored value is not a JSON object."] } : {}) };
  }
  return { ...current, outcome };
}
async function writeOne(kv: AppsKv, op: WriteOp, timezone: string | null, evidence: RecordMutationEvidence): Promise<OpOutcome> {
  const key = op.op === "move" ? op.to : op.key;
  const catalog = catalogParts(key);
  if (!catalog && timezone === null) return { key, outcome: "TIMEZONE_REQUIRED" };
  if (op.op === "delete") {
    const deleted = await mutateRecord("delete", evidence, () => kv.delete(key, op.etag === undefined ? {} : { ifMatch: op.etag }));
    if (deleted.ok) return { key, outcome: "ok" };
    if (deleted.error.code === "KV_PRECONDITION_FAILED") return conflict(kv, key, "CHANGED");
    if (deleted.error.code === "KV_NOT_FOUND") return { key, outcome: "NOT_FOUND" };
    return { key, outcome: appsFailure(deleted.error).code };
  }
  let value: JsonObject = { ...op.value, by: "tinycloud-mcp" };
  let kind: JsonObject | undefined;
  if (catalog) {
    if (catalog.kind !== undefined) {
      const app = (await readAppsRecords(kv, [`${TC_APPS_ROOT}catalog/${catalog.app}`]))[0]!;
      if (!("value" in app)) {
        emitDiagnostic({ type: "operation.step", warning: "schema_warning", outcome: "refused" });
        return { key, outcome: "INVALID", warnings: ["A kind requires its app's catalog record."] };
      }
    }
    if (op.op === "put" && op.etag !== undefined) {
      const current = (await readAppsRecords(kv, [key]))[0]!;
      if (!("value" in current)) return { key, outcome: current.outcome === "NOT_FOUND" ? "NOT_FOUND" : "INVALID" };
      if (current.etag !== op.etag) return { ...current, outcome: "CHANGED" };
      if (!catalogChangeAllowed(current.value, value)) return { ...current, outcome: "CATALOG_CHANGE" };
    }
  } else {
    const parts = recordParts(key);
    const records = await readAppsRecords(kv, [`${TC_APPS_ROOT}catalog/${parts.app}`, `${TC_APPS_ROOT}catalog/${parts.app}/${parts.kind}`]);
    const app = records[0]!;
    const kindRecord = records[1]!;
    if ("value" in kindRecord) kind = kindRecord.value;
    if (op.op === "put" && op.etag === undefined) {
      if (!("value" in app) || !kind) {
        emitDiagnostic({ type: "operation.step", warning: "schema_warning", outcome: "refused" });
        return { key, outcome: "INVALID", warnings: ["A new record requires its app and kind catalog records."] };
      }
      if (!newRecordFits(key, kind)) {
        emitDiagnostic({ type: "operation.step", warning: "schema_warning", outcome: "refused" });
        return { key, outcome: "INVALID", warnings: ["The new record key does not fit its kind's shape."] };
      }
    }
    if (value.v === undefined && kind?.v === undefined) {
      const existing = (await readAppsRecords(kv, [op.op === "move" ? op.from : key]))[0]!;
      if ("value" in existing && typeof existing.value.v === "number") value.v = existing.value.v;
      else {
        emitDiagnostic({ type: "operation.step", warning: "schema_warning", outcome: "refused" });
        return { key, outcome: "INVALID", warnings: ["The record's version cannot be defaulted without a kind catalog or existing record version."] };
      }
    }
    value = { ...value, v: value.v ?? kind!.v!, at: typeof value.at === "string" ? withLocalOffset(value.at, timezone!) : appsNow(timezone) };
  }
  const warnings = catalog ? catalogWarnings(value) : recordWarnings(key, value, kind);
  if (typeof value.v === "number" && Number.isSafeInteger(value.v) && value.v >= 0 && value.v <= 1_000_000_000) emitDiagnostic({ type: "operation.step", schema_revision: value.v });
  const bytes = jsonBytes(value);
  if (op.op === "move") {
    const steps: ("written" | "deleted")[] = [];
    let etag: string | undefined;
    try {
      const written = await mutateRecord("destination_write", evidence, () => kv.put(op.to, bytes, { ifNoneMatch: "*" }));
      if (!written.ok) {
        if (written.error.code === "KV_PRECONDITION_FAILED") return { ...await conflict(kv, op.to, "EXISTS"), steps, warnings };
        return { key, outcome: appsFailure(written.error).code, steps, warnings };
      }
      steps.push("written");
      etag = written.data.headers.etag;
      const deleted = await mutateRecord("source_delete", evidence, () => kv.delete(op.from, { ifMatch: op.etag }));
      if (!deleted.ok) return { key, value, etag, steps, warnings, outcome: deleted.error.code === "KV_PRECONDITION_FAILED" ? "CHANGED" : deleted.error.code === "KV_NOT_FOUND" ? "NOT_FOUND" : appsFailure(deleted.error).code };
      steps.push("deleted");
      return { key, outcome: "ok", value, etag, steps, warnings };
    } catch (error) { return { key, outcome: appsFailure(error).code, ...(steps.length ? { value, etag } : {}), steps, warnings }; }
  }
  const timedCreate = op.etag === undefined && !catalog && kind?.shape === "log" && kind.per === "time";
  let destination = key;
  let suffix = 2;
  for (;;) {
    const result = await mutateRecord("put", evidence, () => kv.put(destination, bytes, op.etag === undefined ? { ifNoneMatch: "*" } : { ifMatch: op.etag }));
    if (result.ok) return { key: destination, outcome: "ok", value, etag: result.data.headers.etag, warnings };
    if (result.error.code !== "KV_PRECONDITION_FAILED") return { key: destination, outcome: appsFailure(result.error).code, warnings };
    if (op.etag === undefined) emitDiagnostic({ type: "operation.step", action: "collision", collisions: 1, warning: "collision", error_class: "precondition" });
    if (!timedCreate) return { ...await conflict(kv, destination, op.etag === undefined ? "EXISTS" : "CHANGED"), warnings };
    destination = `${key}-${suffix++}`;
  }
}

function catalogWarnings(value: JsonObject): string[] {
  const warnings: string[] = [];
  if (isObject(value.fields)) for (const field of Object.keys(value.fields)) if (!/^[a-z0-9_]+$/.test(field)) {
    warnings.push(`Field ${field} does not use lowercase letters, digits and underscores.`);
    emitDiagnostic({ type: "operation.step", warning: "field_name_invalid", role: "catalog" });
  }
  for (const field of ["created", "updated"]) if (typeof value[field] === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value[field] as string)) {
    warnings.push(`${field} should be YYYY-MM-DD.`);
    emitDiagnostic({ type: "operation.step", warning: "date_format_invalid", role: "catalog" });
  }
  return warnings;
}
