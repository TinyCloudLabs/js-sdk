import { z } from "zod";
import type { OperationContext, OperationDefinition, OperationExecutionOutcome, OperationExposure, RuntimeOperationContext, TinyCloudPosture } from "../contract.js";
import { OPERATION_ERROR_CODES, operationError } from "../errors.js";
import { TC_APPS_RULES } from "../tc-apps/rules.generated.js";
import { appsDatabase, checkCopyKinds, copyPermission, hasCopyAuthority, queryCopy, syncCopyRows, type CopyRow } from "../tc-apps/copy.js";
import { decodeSqlInputValue, isSingleReadQuery, SqlOutputValueSchema, SqlParamsSchema } from "./sql.js";
import { appHasMoved, appRecordsPermission, type AppsPermission, type ReadRecord, appsFailure, appsKv, appsSpace, discoveryPermission, hasLegacyCatalogAccess, jsonBytes, legacyCatalogPermission, legacyHasApp, legacyRecordsPermission, listAppsKeys, markAppsKindStale, oneSpaceAtATime, readAppsRecords, type AppsKv } from "../tc-apps/kv.js";
import { catalogKey, catalogPrefix, copyKey, discoveryKey, newApp, parseKey, parsePrefix, TC_APPS_DISCOVERY_ROOT, TC_APPS_LEGACY_ROOT, type KeyParts, type Layout } from "../tc-apps/layout.js";
import { appsCopyState, appsNow, appsTimezone, validTimezone, withLocalOffset } from "../tc-apps/state.js";
import { catalogChangeAllowed, isObject, keyParts, KeySchema, newRecordFits, ObjectSchema, PrefixSchema, recordParts, recordWarnings, WriteInputSchema, type JsonObject, type WriteInput, type WriteOp } from "../tc-apps/records.js";

const LayoutSchema = z.enum(["legacy", "new"]);
const CopyStateSchema = z.enum(["present", "expired", "none"]);
const ContextInputSchema = z.object({ timezone: z.string().refine(validTimezone, "An IANA timezone is required.").optional() }).strict();
const ReadInputSchema = z.object({ prefixes: z.array(PrefixSchema).optional(), keys: z.array(KeySchema).max(100).optional() }).strict();
const RecordSchema = z.object({ key: z.string(), value: ObjectSchema, etag: z.string().min(1) }).strict();
const ReadRecordSchema = z.union([RecordSchema, z.object({ key: z.string(), outcome: z.enum(["NOT_FOUND", "MALFORMED"]) }).strict()]);
const AppSchema = z.object({ app: z.string(), layout: LayoutSchema, title: z.string().optional(), copy: CopyStateSchema }).strict();
const ContextOutputSchema = z.object({
  rules: z.string(), now: z.string(), timezone: z.string().nullable(),
  apps: z.array(AppSchema),
  legacy: z.enum(["listed", "not_approved"]).describe("not_approved: the older layout's app list was not readable, so older apps are not in apps."),
  catalog: z.object({ keys: z.array(z.string()), records: z.array(RecordSchema).optional() }).strict(),
}).strict();
const ReadOutputSchema = z.object({ lists: z.array(z.object({ prefix: z.string(), keys: z.array(z.string()) }).strict()), records: z.array(ReadRecordSchema) }).strict();
const OpOutcomeSchema = z.object({
  key: z.string(), outcome: z.enum(["ok", "EXISTS", "CHANGED", "CATALOG_CHANGE", "INVALID", "NOT_FOUND", "TIMEZONE_REQUIRED", ...OPERATION_ERROR_CODES]),
  etag: z.string().optional(), value: ObjectSchema.optional(), steps: z.array(z.enum(["written", "deleted"])).optional(), warnings: z.array(z.string()).optional(),
}).strict();
const WriteOutputSchema = z.object({ ops: z.array(OpOutcomeSchema) }).strict();
const CopyKindSchema = z.object({ app: z.string().regex(/^[a-z0-9-]+$/).refine((app) => app !== "catalog" && app !== "index-stale"), kind: z.string().regex(/^[a-z0-9-]+$/) }).strict();
const QueryInputSchema = z.object({
  layout: LayoutSchema.describe("The app's layout from tinycloud_apps_context: new for apps in xyz.tinycloud.tinyapps.<app>/, legacy for apps in xyz.tinycloud.agent-data/."),
  kinds: z.array(CopyKindSchema).min(1), sql: z.string().min(1).max(64 * 1024).refine(isSingleReadQuery, "SQL must be one SELECT or WITH query."), params: SqlParamsSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.kinds.some((kind) => kind.app !== input.kinds[0]!.app)) context.addIssue({ code: "custom", path: ["kinds"], message: "One query covers one app; query each app separately." });
  if (input.layout === "new" && !newApp(input.kinds[0]!.app)) context.addIssue({ code: "custom", path: ["kinds", 0, "app"], message: "That app name is reserved or invalid in the new layout." });
  if (input.layout === "new" && input.kinds.some((kind) => kind.kind === "catalog" || kind.kind === "index-stale")) context.addIssue({ code: "custom", path: ["kinds"], message: "catalog and index-stale are not kinds in the new layout." });
});
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

/** One entry per distinct scope. Each is the whole grant for its prefix, so one approval covers every later call. A discovery entry read needs only the app list; writing one also reads the app's own catalog. */
function scopesFor(context: RuntimeOperationContext, targets: readonly string[], createsApp: readonly string[] = [], forWrite = false) {
  const entries = new Map<string, AppsPermission>();
  const add = (entry: AppsPermission) => entries.set(`${entry.space}|${entry.path}|${entry.service}`, entry);
  for (const target of targets) {
    const parts = parseKey(target);
    const prefix = parts === undefined ? parsePrefix(target) : undefined;
    if (parts?.area === "discovery") { add(discoveryPermission(context)); if (forWrite) add(appRecordsPermission(context, parts.app)); }
    else if (parts?.layout === "legacy" || prefix?.layout === "legacy") add(legacyRecordsPermission(context));
    else if (prefix?.discovery) add(discoveryPermission(context));
    else if (parts !== undefined || prefix?.app !== undefined) add(appRecordsPermission(context, (parts?.app ?? prefix!.app)!));
  }
  if (createsApp.length > 0) add(legacyCatalogPermission(context));
  return oneSpaceAtATime(context, [...entries.values()]);
}
const contextAuthority = async (context: RuntimeOperationContext) => [discoveryPermission(context)];
const readAuthority = async (context: RuntimeOperationContext, input: ReadInput) => scopesFor(context, [...(input.prefixes ?? []), ...(input.keys ?? [])]);
const writeAuthority = async (context: RuntimeOperationContext, input: WriteInput) => scopesFor(
  context,
  input.ops.flatMap((op) => op.op === "move" ? [op.from, op.to] : [op.key]),
  input.ops.flatMap((op) => op.op === "put" && op.etag === undefined && isNewAppCatalog(op.key) ? [op.key] : []),
  true,
);
const queryAuthority = async (context: RuntimeOperationContext, input: QueryInput) => {
  const app = input.kinds[0]!.app;
  return input.layout === "legacy"
    ? [legacyRecordsPermission(context), copyPermission(context, "legacy", app)]
    : [appRecordsPermission(context, app), copyPermission(context, "new", app)];
};
function isNewAppCatalog(key: string): boolean {
  const parts = parseKey(key);
  return parts?.layout === "new" && parts.area === "catalog" && parts.kind === undefined;
}

const contextDefinition: OperationDefinition<ContextInput, ContextOutput> = {
  id: "tinycloud.apps.context", version: 1, title: "Personal apps context",
  description: "Read the connected user's list of personal apps (each with its layout), local time and record-handling rules. Call first when the user requests a personal-record task. Supplying an IANA timezone saves or replaces their timezone setting for later calls. Do not use personal records to store credentials, payment-card data, government identifiers or protected health information.",
  input: ContextInputSchema, output: ContextOutputSchema, effects: ["read", "local_write"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
  sensitivity: { input: ["/timezone"], output: ["/apps", "/catalog", "/timezone", "/now"] }, authority: contextAuthority, execute: executeContext,
};
const readDefinition: OperationDefinition<ReadInput, ReadOutput> = {
  id: "tinycloud.apps.read", version: 1, title: "Read personal records", description: "List personal-record prefixes in full and read up to 100 records with their ETags. Read fresh before answering or editing.",
  input: ReadInputSchema, output: ReadOutputSchema, effects: ["read"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
  sensitivity: { input: ["/prefixes", "/keys"], output: ["/lists", "/records"] }, authority: readAuthority, execute: executeRead,
};
const writeDefinition: OperationDefinition<WriteInput, WriteOutput> = {
  id: "tinycloud.apps.write", version: 1, title: "Write personal records", description: "Run 1–10 personal-record puts, moves or requested deletes in order. Every value must omit top-level by, including when editing or moving a read-back record; the server supplies it. Omit an ETag to create; supply the read ETag to replace. Catalog writes may precede their records in the same call. Inspect every outcome and any completed move steps before retrying.",
  input: WriteInputSchema, output: WriteOutputSchema, effects: ["destructive"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
  sensitivity: { input: ["/ops"], output: ["/ops"] }, authority: writeAuthority, execute: executeWrite,
};
const queryDefinition: OperationDefinition<QueryInput, QueryOutput> = {
  id: "tinycloud.apps.query", version: 1, title: "Query personal records", description: "Answer the user's question over one app's personal records using an optional searchable copy. Requires separate copy approval. Name the app's layout and every kind covered; the server writes or replaces the app's derived SQL copy before running one SELECT or WITH query with bound params. Canonical records are unchanged. COPY_PARTIAL means the answer is incomplete; continue with the remaining kinds before answering.",
  input: QueryInputSchema, output: QueryOutputSchema, effects: ["read", "write", "destructive"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
  sensitivity: { input: ["/kinds", "/sql", "/params"], output: ["/kinds", "/rows", "/remaining"] }, authority: queryAuthority, execute: executeQuery,
};

export const appsOperationDefinitions = [contextDefinition, readDefinition, writeDefinition, queryDefinition] as const;

async function executeContext(context: OperationContext, input: ContextInput): Promise<OperationExecutionOutcome<ContextOutput>> {
  const parsed = ContextInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "An IANA timezone is required.") };
  try {
    const timezone = await appsTimezone(context.summary.profile, parsed.data.timezone);
    const legacyKv = appsKv(context, "legacy");
    // The older layout is listed only when the session can already read it: asking would be a second approval screen for every first use.
    const legacy = hasLegacyCatalogAccess(context);
    const keys = legacy ? await listAppsKeys(legacyKv, `${TC_APPS_LEGACY_ROOT}catalog/`) : [];
    let records: z.infer<typeof RecordSchema>[] | undefined;
    if (legacy && keys.length <= 40) {
      const read = await readAppsRecords(legacyKv, keys);
      if (read.some((record) => "outcome" in record)) return { status: "error", error: operationError("NODE_ERROR", "A catalog record is missing or malformed. Read its key to inspect it.") };
      records = read as z.infer<typeof RecordSchema>[];
    }
    const moved = await discoveredApps(appsKv(context, "new"));
    const apps = new Map<string, { layout: Layout; title?: string }>();
    for (const key of keys) {
      const parts = parseKey(key);
      if (parts?.layout !== "legacy" || parts.area !== "catalog" || parts.kind !== undefined) continue;
      const title = records?.find((record) => record.key === key)?.value.title;
      apps.set(parts.app, { layout: "legacy", ...(typeof title === "string" ? { title } : {}) });
    }
    for (const [app, title] of moved) apps.set(app, { layout: "new", ...(title === undefined ? {} : { title }) });
    const listed = await Promise.all([...apps].sort(([a], [b]) => a.localeCompare(b)).map(async ([app, entry]) => ({
      app, ...entry, copy: await appsCopyState(context.summary.profile, entry.layout, app, appsSpace(context, entry.layout)),
    })));
    return { status: "ok", output: { rules: TC_APPS_RULES, now: appsNow(timezone), timezone, apps: listed, legacy: legacy ? "listed" : "not_approved", catalog: { keys, ...(records === undefined ? {} : { records }) } } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}
/** Every app with a discovery entry, with its title when the entry is well formed. */
async function discoveredApps(kv: AppsKv): Promise<Map<string, string | undefined>> {
  const apps = new Map<string, string | undefined>();
  const keys = (await listAppsKeys(kv, TC_APPS_DISCOVERY_ROOT)).filter((key) => parseKey(key)?.area === "discovery");
  for (let offset = 0; offset < keys.length; offset += 100) {
    for (const record of await readAppsRecords(kv, keys.slice(offset, offset + 100))) {
      const parts = parseKey(record.key) as KeyParts;
      apps.set(parts.app, "value" in record && typeof record.value.title === "string" ? record.value.title : undefined);
    }
  }
  return apps;
}
async function executeRead(context: OperationContext, input: ReadInput): Promise<OperationExecutionOutcome<ReadOutput>> {
  const parsed = ReadInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Personal-record keys or prefixes are invalid; read at most 100 keys.") };
  try {
    const lists = [];
    for (const prefix of parsed.data.prefixes ?? []) lists.push({ prefix, keys: await listAppsKeys(appsKv(context, parsePrefix(prefix)!.layout), prefix) });
    const requested = parsed.data.keys ?? [];
    const found = new Map<string, ReadRecord>();
    for (const layout of ["legacy", "new"] as const) {
      const keys = requested.filter((key) => keyParts(key).layout === layout);
      for (const record of await readAppsRecords(appsKv(context, layout), keys)) found.set(record.key, record);
    }
    return { status: "ok", output: { lists, records: requested.map((key) => found.get(key)!) } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}

async function executeQuery(context: OperationContext, input: QueryInput): Promise<OperationExecutionOutcome<QueryOutput>> {
  const parsed = QueryInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Name one app's layout and kinds and supply one read-only SELECT or WITH query with bound parameters.") };
  try {
    const { layout } = parsed.data;
    const app = parsed.data.kinds[0]!.app;
    if (layout === "legacy" && await appHasMoved(context, app)) return { status: "error", error: operationError("INPUT_INVALID", `${app} has moved to xyz.tinycloud.tinyapps.${app}/; query it with layout "new".`) };
    const db = appsDatabase(context, layout, app);
    const unique = [...new Map(parsed.data.kinds.map((kind) => [`${kind.app}/${kind.kind}`, kind])).values()];
    const checked = await checkCopyKinds(appsKv(context, layout), db, layout, unique);
    if ("outcome" in checked) return { status: "ok", output: checked };
    const result = await queryCopy(db, layout, parsed.data.sql, (parsed.data.params ?? []).map(decodeSqlInputValue));
    return { status: "ok", output: { ...checked, ...result, columns: [...result.columns], rows: result.rows.map((row) => [...row]) } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}

/** The KV handles a write needs, opened on first use so a batch only touches the spaces it names. */
class Handles {
  readonly #open = new Map<Layout, AppsKv>();
  constructor(readonly context: OperationContext) {}
  kv(layout: Layout): AppsKv {
    let kv = this.#open.get(layout);
    if (!kv) { kv = appsKv(this.context, layout); this.#open.set(layout, kv); }
    return kv;
  }
}
interface Touched { layout: Layout; app: string; kind: string; owners: OpOutcome[] }
interface CopyBatch { layout: Layout; app: string; rows: Map<string, CopyRow> }

async function executeWrite(context: OperationContext, input: WriteInput): Promise<OperationExecutionOutcome<WriteOutput>> {
  // Validate the entire batch before obtaining a handle or executing its first op.
  const parsed = WriteInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Every op must have a valid personal-record key and JSON record, catalog or discovery value.", { details: { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) } }) };
  const handles = new Handles(context);
  let timezone: string | null;
  try { timezone = await appsTimezone(context.summary.profile); }
  catch (error) { return { status: "error", error: appsFailure(error) }; }
  const ops: OpOutcome[] = [];
  const touched = new Map<string, Touched>();
  const batches = new Map<string, CopyBatch>();
  const refresh: { layout: Layout; app: string; key: string }[] = [];
  for (const op of parsed.data.ops) {
    const key = op.op === "move" ? op.to : op.key;
    const parts = keyParts(key);
    let outcome: OpOutcome;
    try { outcome = await writeOne(handles, op, timezone); }
    catch (error) { outcome = { key, outcome: appsFailure(error).code }; }
    ops.push(outcome);
    if (parts.area === "discovery" || !(outcome.outcome === "ok" || outcome.steps?.includes("written"))) continue;
    const changedKeys = op.op === "move" ? [outcome.key, op.from] : [outcome.key];
    if (op.op === "move" && !outcome.steps?.includes("deleted")) refresh.push({ layout: parts.layout, app: parts.app, key: op.from });
    for (const changed of changedKeys) {
      const changedParts = keyParts(changed);
      if (changedParts.area === "record") {
        const batch = batches.get(`${changedParts.layout}/${changedParts.app}`) ?? { layout: changedParts.layout, app: changedParts.app, rows: new Map() };
        batch.rows.set(changed, { k: copyKey(changedParts.layout, changedParts.app, changed), ...(changed === outcome.key && op.op !== "delete" && outcome.value ? { r: outcome.value } : {}) });
        batches.set(`${changedParts.layout}/${changedParts.app}`, batch);
      }
      if (changedParts.area === "stale" || changedParts.area === "discovery" || changedParts.kind === undefined) continue;
      const marker = `${changedParts.layout}/${changedParts.app}/${changedParts.kind}`;
      const entry = touched.get(marker) ?? { layout: changedParts.layout, app: changedParts.app, kind: changedParts.kind, owners: [] };
      if (!entry.owners.includes(outcome)) entry.owners.push(outcome);
      touched.set(marker, entry);
    }
  }
  // Upkeep must never erase committed outcomes or turn a refusal into an approval loop.
  const synced = new Set<string>();
  let upkeepWarning: string | undefined;
  try {
    for (const [name, batch] of batches) {
      if (!hasCopyAuthority(context, batch.layout, batch.app)) continue;
      const sources = refresh.filter((entry) => `${entry.layout}/${entry.app}` === name).map((entry) => entry.key);
      for (const record of await readAppsRecords(handles.kv(batch.layout), sources)) {
        const k = copyKey(batch.layout, batch.app, record.key);
        if ("value" in record) batch.rows.set(record.key, { k, r: record.value });
        else if (record.outcome === "NOT_FOUND") batch.rows.set(record.key, { k });
        else throw new Error("A move source is malformed.");
      }
      await syncCopyRows(appsDatabase(context, batch.layout, batch.app), [...batch.rows.values()]);
      synced.add(name);
    }
  } catch (error) {
    const failure = appsFailure(error);
    upkeepWarning = failure.details?.reason === "copy_unavailable"
      ? "The record changed, but the fast copy needs the node team. Answer from records; do not retry or ask for another approval."
      : `The record changed, but fast-copy upkeep failed (${failure.code}); its kind is marked stale.`;
  }
  for (const { layout, app, kind, owners } of touched.values()) {
    if (upkeepWarning) for (const owner of owners) (owner.warnings ??= []).push(upkeepWarning);
    if (synced.has(`${layout}/${app}`) && batches.get(`${layout}/${app}`)!.rows.size > 0) continue;
    try { await markAppsKindStale(handles.kv(layout), layout, app, kind, appsNow(timezone)); }
    catch (error) {
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
async function writeOne(handles: Handles, op: WriteOp, timezone: string | null): Promise<OpOutcome> {
  const key = op.op === "move" ? op.to : op.key;
  const parts = keyParts(key);
  const kv = handles.kv(parts.layout);
  if (parts.area === "discovery") return writeDiscovery(handles, op, parts.app);
  const catalog = parts.area === "catalog" ? parts : undefined;
  if (!catalog && timezone === null) return { key, outcome: "TIMEZONE_REQUIRED" };
  if (parts.layout === "legacy" && await appHasMoved(handles.context, parts.app)) {
    return { key, outcome: "INVALID", warnings: [`${parts.app} has moved to xyz.tinycloud.tinyapps.${parts.app}/; use keys under that root.`] };
  }
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
      const app = (await readAppsRecords(kv, [catalogKey(parts.layout, parts.app)]))[0]!;
      if (!("value" in app)) return { key, outcome: "INVALID", warnings: ["A kind requires its app's catalog record."] };
    } else if (parts.layout === "new" && op.op === "put" && op.etag === undefined && await legacyHasApp(handles.context, parts.app)) {
      return { key, outcome: "INVALID", warnings: [`${parts.app} already exists in the older layout (xyz.tinycloud.agent-data/). Keep using keys under that root, or ask the owner to move it.`] };
    }
    if (op.op === "put" && op.etag !== undefined) {
      const current = (await readAppsRecords(kv, [key]))[0]!;
      if (!("value" in current)) return { key, outcome: current.outcome === "NOT_FOUND" ? "NOT_FOUND" : "INVALID" };
      if (current.etag !== op.etag) return { ...current, outcome: "CHANGED" };
      if (!catalogChangeAllowed(current.value, value)) return { ...current, outcome: "CATALOG_CHANGE" };
    }
  } else {
    const record = recordParts(key);
    const records = await readAppsRecords(kv, [catalogKey(parts.layout, record.app), catalogKey(parts.layout, record.app, record.kind)]);
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

/** The discovery entry is the switch other clients read, so it only follows its app's catalog record and a first kind record. */
async function writeDiscovery(handles: Handles, op: WriteOp, app: string): Promise<OpOutcome> {
  const key = discoveryKey(app);
  const kv = handles.kv("new");
  if (op.op !== "put") return { key, outcome: "INVALID", warnings: ["A discovery entry is only created or replaced."] };
  const record = (await readAppsRecords(kv, [catalogKey("new", app)]))[0]!;
  if (!("value" in record)) return { key, outcome: "INVALID", warnings: ["Write the app's catalog record and a kind record before its discovery entry."] };
  if ((await listAppsKeys(kv, catalogPrefix("new", app))).length === 0) return { key, outcome: "INVALID", warnings: ["Write a kind record before the app's discovery entry."] };
  if (op.value.title !== record.value.title) return { key, outcome: "INVALID", warnings: ["The discovery title must be the title in the app's catalog record."] };
  const result = await kv.put(key, jsonBytes(op.value as JsonObject), op.etag === undefined ? { ifNoneMatch: "*" } : { ifMatch: op.etag });
  if (result.ok) return { key, outcome: "ok", value: op.value as JsonObject, etag: result.data.headers.etag };
  if (result.error.code === "KV_PRECONDITION_FAILED") return conflict(kv, key, op.etag === undefined ? "EXISTS" : "CHANGED");
  return { key, outcome: appsFailure(result.error).code };
}

function catalogWarnings(value: JsonObject): string[] {
  const warnings: string[] = [];
  if (isObject(value.fields)) for (const field of Object.keys(value.fields)) if (!/^[a-z0-9_]+$/.test(field)) warnings.push(`Field ${field} does not use lowercase letters, digits and underscores.`);
  for (const field of ["created", "updated"]) if (typeof value[field] === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value[field] as string)) warnings.push(`${field} should be YYYY-MM-DD.`);
  return warnings;
}
