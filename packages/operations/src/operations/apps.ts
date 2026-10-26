import { z } from "zod";
import type { OperationContext, OperationDefinition, OperationExecutionOutcome, OperationExposure, TinyCloudPosture } from "../contract.js";
import { OPERATION_ERROR_CODES, operationError } from "../errors.js";
import { TC_APPS_ROOT } from "../tc-apps.js";
import { TC_APPS_RULES } from "../tc-apps/rules.generated.js";
import { appsDatabase, appsQueryAuthority, checkCopyKinds, hasCopyAuthority, queryCopy, syncCopyRows, type CopyRow } from "../tc-apps/copy.js";
import { decodeSqlInputValue, isSingleReadQuery, SqlOutputValueSchema, SqlParamsSchema } from "./sql.js";
import { appsAuthority, appsFailure, appsKv, appsSpace, jsonBytes, listAppsKeys, markAppsKindStale, readAppsRecords, type AppsKv } from "../tc-apps/kv.js";
import { appsCopyState, appsNow, appsTimezone, validTimezone, withLocalOffset } from "../tc-apps/state.js";
import { catalogChangeAllowed, catalogParts, isObject, KeySchema, newRecordFits, ObjectSchema, PrefixSchema, recordParts, recordWarnings, WriteInputSchema, type JsonObject, type WriteInput, type WriteOp } from "../tc-apps/records.js";

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
    description: "Read the connected user's TinyCloud personal-record catalog, local time and record-handling rules. Call first when the user requests a personal-record task. Supplying an IANA timezone saves or replaces their timezone setting for later calls. Do not use personal records to store credentials, payment-card data, government identifiers or protected health information.",
    input: ContextInputSchema, output: ContextOutputSchema, effects: ["read", "local_write"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/timezone"], output: ["/catalog", "/timezone", "/now"] }, authority: appsAuthority, execute: executeContext,
  },
  {
    id: "tinycloud.apps.read", version: 1, title: "Read personal records", description: "List personal-record prefixes in full and read up to 100 records with their ETags. Read fresh before answering or editing.",
    input: ReadInputSchema, output: ReadOutputSchema, effects: ["read"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/prefixes", "/keys"], output: ["/lists", "/records"] }, authority: appsAuthority, execute: executeRead,
  },
  {
    id: "tinycloud.apps.write", version: 1, title: "Write personal records", description: "Run 1–10 personal-record puts, moves or requested deletes in order. Every value must omit top-level by, including when editing or moving a read-back record; the server supplies it. Omit an ETag to create; supply the read ETag to replace. Catalog writes may precede their records in the same call. Inspect every outcome and any completed move steps before retrying.",
    input: WriteInputSchema, output: WriteOutputSchema, effects: ["destructive"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/ops"], output: ["/ops"] }, authority: appsAuthority, execute: executeWrite,
  },
  {
    id: "tinycloud.apps.query", version: 1, title: "Query personal records", description: "Answer the user's question over their personal records using an optional searchable copy. Requires separate copy approval. List every app and kind covered; the server writes or replaces their derived SQL copy before running one SELECT or WITH query with bound params. Canonical records are unchanged. COPY_PARTIAL means the answer is incomplete; continue with the remaining kinds before answering.",
    input: QueryInputSchema, output: QueryOutputSchema, effects: ["read", "write", "destructive"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/kinds", "/sql", "/params"], output: ["/kinds", "/rows", "/remaining"] }, authority: appsQueryAuthority, execute: executeQuery,
  },
];

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
    return { status: "ok", output: { lists, records: await readAppsRecords(kv, parsed.data.keys ?? []) } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}

async function executeQuery(context: OperationContext, input: QueryInput): Promise<OperationExecutionOutcome<QueryOutput>> {
  const parsed = QueryInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "List valid app/kind names and supply one read-only SELECT or WITH query with bound parameters.") };
  try {
    const db = appsDatabase(context);
    const unique = [...new Map(parsed.data.kinds.map((kind) => [`${kind.app}/${kind.kind}`, kind])).values()];
    const checked = await checkCopyKinds(appsKv(context), db, unique);
    if ("outcome" in checked) return { status: "ok", output: checked };
    const result = await queryCopy(db, parsed.data.sql, (parsed.data.params ?? []).map(decodeSqlInputValue));
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
  for (const op of parsed.data.ops) {
    const key = op.op === "move" ? op.to : op.key;
    let outcome: OpOutcome;
    try { outcome = await writeOne(kv, op, timezone); }
    catch (error) { outcome = { key, outcome: appsFailure(error).code }; }
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
      for (const record of await readAppsRecords(kv, [...refresh])) {
        if ("value" in record) rows.set(record.key, { k: record.key, r: record.value });
        else if (record.outcome === "NOT_FOUND") rows.set(record.key, { k: record.key });
        else throw new Error("A move source is malformed.");
      }
      await syncCopyRows(appsDatabase(context), [...rows.values()]);
      synced = true;
    }
  } catch (error) {
    const failure = appsFailure(error);
    upkeepWarning = failure.details?.reason === "copy_unavailable"
      ? "The record changed, but the fast copy needs the node team. Answer from records; do not retry or ask for another approval."
      : `The record changed, but fast-copy upkeep failed (${failure.code}); its kind is marked stale.`;
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
  return { status: "ok", output: { ops } };
}

async function conflict(kv: AppsKv, key: string, outcome: "EXISTS" | "CHANGED" | "CATALOG_CHANGE"): Promise<OpOutcome> {
  const current = (await readAppsRecords(kv, [key]))[0]!;
  if ("outcome" in current) return { key, outcome: current.outcome === "NOT_FOUND" ? "NOT_FOUND" : "INVALID", ...(current.outcome === "MALFORMED" ? { warnings: ["The stored value is not a JSON object."] } : {}) };
  return { ...current, outcome };
}
async function writeOne(kv: AppsKv, op: WriteOp, timezone: string | null): Promise<OpOutcome> {
  const key = op.op === "move" ? op.to : op.key;
  const catalog = catalogParts(key);
  if (!catalog && timezone === null) return { key, outcome: "TIMEZONE_REQUIRED" };
  if (op.op === "delete") {
    const deleted = await kv.delete(key, op.etag === undefined ? {} : { ifMatch: op.etag });
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
      if (!("value" in app)) return { key, outcome: "INVALID", warnings: ["A kind requires its app's catalog record."] };
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
      if (!("value" in app) || !kind) return { key, outcome: "INVALID", warnings: ["A new record requires its app and kind catalog records."] };
      if (!newRecordFits(key, kind)) return { key, outcome: "INVALID", warnings: ["The new record key does not fit its kind's shape."] };
    }
    if (value.v === undefined && kind?.v === undefined) {
      const existing = (await readAppsRecords(kv, [op.op === "move" ? op.from : key]))[0]!;
      if ("value" in existing && typeof existing.value.v === "number") value.v = existing.value.v;
      else return { key, outcome: "INVALID", warnings: ["The record's version cannot be defaulted without a kind catalog or existing record version."] };
    }
    value = { ...value, v: value.v ?? kind!.v!, at: typeof value.at === "string" ? withLocalOffset(value.at, timezone!) : appsNow(timezone) };
  }
  const warnings = catalog ? catalogWarnings(value) : recordWarnings(key, value, kind);
  const bytes = jsonBytes(value);
  if (op.op === "move") {
    const steps: ("written" | "deleted")[] = [];
    let etag: string | undefined;
    try {
      const written = await kv.put(op.to, bytes, { ifNoneMatch: "*" });
      if (!written.ok) {
        if (written.error.code === "KV_PRECONDITION_FAILED") return { ...await conflict(kv, op.to, "EXISTS"), steps, warnings };
        return { key, outcome: appsFailure(written.error).code, steps, warnings };
      }
      steps.push("written");
      etag = written.data.headers.etag;
      const deleted = await kv.delete(op.from, { ifMatch: op.etag });
      if (!deleted.ok) return { key, value, etag, steps, warnings, outcome: deleted.error.code === "KV_PRECONDITION_FAILED" ? "CHANGED" : deleted.error.code === "KV_NOT_FOUND" ? "NOT_FOUND" : appsFailure(deleted.error).code };
      steps.push("deleted");
      return { key, outcome: "ok", value, etag, steps, warnings };
    } catch (error) { return { key, outcome: appsFailure(error).code, ...(steps.length ? { value, etag } : {}), steps, warnings }; }
  }
  const timedCreate = op.etag === undefined && !catalog && kind?.shape === "log" && kind.per === "time";
  let destination = key;
  let suffix = 2;
  for (;;) {
    const result = await kv.put(destination, bytes, op.etag === undefined ? { ifNoneMatch: "*" } : { ifMatch: op.etag });
    if (result.ok) return { key: destination, outcome: "ok", value, etag: result.data.headers.etag, warnings };
    if (result.error.code !== "KV_PRECONDITION_FAILED") return { key: destination, outcome: appsFailure(result.error).code, warnings };
    if (!timedCreate) return { ...await conflict(kv, destination, op.etag === undefined ? "EXISTS" : "CHANGED"), warnings };
    destination = `${key}-${suffix++}`;
  }
}

function catalogWarnings(value: JsonObject): string[] {
  const warnings: string[] = [];
  if (isObject(value.fields)) for (const field of Object.keys(value.fields)) if (!/^[a-z0-9_]+$/.test(field)) warnings.push(`Field ${field} does not use lowercase letters, digits and underscores.`);
  for (const field of ["created", "updated"]) if (typeof value[field] === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value[field] as string)) warnings.push(`${field} should be YYYY-MM-DD.`);
  return warnings;
}
