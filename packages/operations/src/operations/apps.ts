import { z } from "zod";
import type { OperationContext, OperationDefinition, OperationExecutionOutcome, OperationExposure, TinyCloudPosture } from "../contract.js";
import { OPERATION_ERROR_CODES, operationError } from "../errors.js";
import { TC_APPS_ROOT } from "../tc-apps.js";
import { TC_APPS_RECORDS_RULES } from "../tc-apps/rules.generated.js";
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
  OperationDefinition<ContextInput, ContextOutput> | OperationDefinition<ReadInput, ReadOutput> | OperationDefinition<WriteInput, WriteOutput>
)[] = [
  {
    id: "tinycloud.apps.context", version: 1, title: "Personal apps context",
    description: "Personal records kept in the user's TinyCloud: weight, workouts, goals, todos, anything they track. Use it whenever the user asks to log, record, track, add, look up, list or sum up something about their life, even without mentioning TinyCloud. Call it first: it returns the rules, the user's local time and their apps.",
    input: ContextInputSchema, output: ContextOutputSchema, effects: ["read"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/timezone"], output: ["/catalog", "/timezone", "/now"] }, authority: appsAuthority, execute: executeContext,
  },
  {
    id: "tinycloud.apps.read", version: 1, title: "Read personal records", description: "List personal-record prefixes in full and read up to 100 records with their ETags. Read fresh before answering or editing.",
    input: ReadInputSchema, output: ReadOutputSchema, effects: ["read"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/prefixes", "/keys"], output: ["/lists", "/records"] }, authority: appsAuthority, execute: executeRead,
  },
  {
    id: "tinycloud.apps.write", version: 1, title: "Write personal records", description: "Run 1–10 personal-record puts, moves or requested deletes in order. Omit an ETag to create; supply the read ETag to replace. Catalog writes may precede their records in the same call. Inspect every outcome and any completed move steps before retrying.",
    input: WriteInputSchema, output: WriteOutputSchema, effects: ["destructive"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
    sensitivity: { input: ["/ops"], output: ["/ops"] }, authority: appsAuthority, execute: executeWrite,
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
    return { status: "ok", output: { rules: TC_APPS_RECORDS_RULES, now: appsNow(timezone), timezone, catalog: { keys, ...(records === undefined ? {} : { records }) }, copy: await appsCopyState(context.summary.profile, appsSpace(context)) } };
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
  for (const op of parsed.data.ops) {
    const key = op.op === "move" ? op.to : op.key;
    let outcome: OpOutcome;
    try { outcome = await writeOne(kv, op, timezone); }
    catch (error) { outcome = { key, outcome: appsFailure(error).code }; }
    ops.push(outcome);
    if (outcome.outcome === "ok" || outcome.steps?.includes("written")) {
      const keys = op.op === "move" ? [op.from, op.to] : [op.key];
      for (const changed of keys) {
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
  // Step 2 deliberately leaves rebuilds to a client with the optional copy grant.
  // Do not let upkeep failures erase a committed write's outcome.
  for (const [key, owners] of touched) {
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
