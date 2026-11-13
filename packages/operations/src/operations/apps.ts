import { z } from "zod";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import { evaluateOperationAuthority } from "../authority.js";
import { operationSpaceResolver } from "../secrets.js";
import { TC_APPS_CATALOG_PERMISSIONS, TC_APPS_CATALOG_READ_ACTIONS } from "../tc-apps.js";
import type { OperationContext, OperationDefinition, OperationExecutionOutcome, OperationExposure, RuntimeOperationContext, TinyCloudPosture } from "../contract.js";
import { OPERATION_ERROR_CODES, operationError } from "../errors.js";
import { TC_APPS_RULES } from "../tc-apps/rules.generated.js";
import { appsDatabase, checkCopyKinds, copyPermission, hasCopyAuthority, queryCopy, syncCopyRows, type CopyRow } from "../tc-apps/copy.js";
import { decodeSqlInputValue, isSingleReadQuery, SqlOutputValueSchema, SqlParamsSchema } from "./sql.js";
import { appDiscoveryPermission, appRecordsPermission, type AppsPermission, type ReadRecord, appsFailure, appsKv, appsSpace, discoveryPermission, hasDiscoveryAccess, jsonBytes, listAppsKeys, markAppsKindStale, readAppsRecords, type AppsKv } from "../tc-apps/kv.js";
import { appRoot, catalogKey, catalogPrefix, copyKey, discoveryKey, newApp, parseKey, parsePrefix, TC_APPS_DISCOVERY_ROOT, type KeyParts } from "../tc-apps/layout.js";
import { appsCopyState, appsNow, appsTimezone, validTimezone, withLocalOffset } from "../tc-apps/state.js";
import { catalogChangeAllowed, isObject, keyParts, KeySchema, newRecordFits, ObjectSchema, PrefixSchema, recordParts, recordWarnings, WriteInputSchema, type JsonObject, type WriteInput, type WriteOp } from "../tc-apps/records.js";

const CopyStateSchema = z.enum(["present", "expired", "none"]);
const ContextInputSchema = z.object({
  timezone: z.string().refine(validTimezone, "An IANA timezone is required.").optional(),
  app: z.string().refine((app) => Object.prototype.hasOwnProperty.call(TC_APPS_CATALOG_PERMISSIONS, app) || newApp(app), "A valid app id is required.").optional().describe("Pass one personal app id or catalog slug (healthlog or recipes) to request its task access together."),
  access: z.enum(["read", "change"]).default("change").describe("Use read for a question that changes nothing; change requests the app's supported write access too."),
}).strict();
const ReadInputSchema = z.object({ prefixes: z.array(PrefixSchema).optional(), keys: z.array(KeySchema).max(100).optional() }).strict();
const RecordSchema = z.object({ key: z.string(), value: ObjectSchema, etag: z.string().min(1) }).strict();
const ReadRecordSchema = z.union([RecordSchema, z.object({ key: z.string(), outcome: z.enum(["NOT_FOUND", "MALFORMED"]) }).strict()]);
const AppSchema = z.object({ app: z.string(), title: z.string().optional(), copy: CopyStateSchema }).strict();
const ContextOutputSchema = z.object({
  rules: z.string(), now: z.string(), utc: z.string().describe("The same instant in UTC, e.g. 2026-11-03T12:30:00Z, for a catalog app's logged_at."), timezone: z.string().nullable(),
  apps: z.array(AppSchema),
}).strict();
const ReadOutputSchema = z.object({ lists: z.array(z.object({ prefix: z.string(), keys: z.array(z.string()) }).strict()), records: z.array(ReadRecordSchema) }).strict();
const OpOutcomeSchema = z.object({
  key: z.string(), outcome: z.enum(["ok", "EXISTS", "CHANGED", "CATALOG_CHANGE", "INVALID", "NOT_FOUND", "TIMEZONE_REQUIRED", ...OPERATION_ERROR_CODES]),
  etag: z.string().optional(), value: ObjectSchema.optional(), steps: z.array(z.enum(["written", "deleted"])).optional(), warnings: z.array(z.string()).optional(),
}).strict();
const WriteOutputSchema = z.object({ ops: z.array(OpOutcomeSchema) }).strict();
const CopyKindSchema = z.object({ app: z.string().regex(/^[a-z0-9-]+$/).refine((app) => app !== "catalog" && app !== "index-stale"), kind: z.string().regex(/^[a-z0-9-]+$/) }).strict();
const QueryInputSchema = z.object({
  kinds: z.array(CopyKindSchema).min(1), sql: z.string().min(1).max(64 * 1024).refine(isSingleReadQuery, "SQL must be one SELECT or WITH query."), params: SqlParamsSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.kinds.some((kind) => kind.app !== input.kinds[0]!.app)) context.addIssue({ code: "custom", path: ["kinds"], message: "One query covers one app; query each app separately." });
  if (!newApp(input.kinds[0]!.app)) context.addIssue({ code: "custom", path: ["kinds", 0, "app"], message: "That app name is reserved or invalid." });
  if (input.kinds.some((kind) => kind.kind === "catalog" || kind.kind === "index-stale")) context.addIssue({ code: "custom", path: ["kinds"], message: "catalog and index-stale are not kinds." });
});
const QueryOutputSchema = z.union([
  z.object({ kinds: z.array(CopyKindSchema.extend({ records: z.number().int().nonnegative() })), columns: z.array(z.string()), rows: z.array(z.array(SqlOutputValueSchema)), rowCount: z.number().int().nonnegative() }).strict(),
  z.object({ outcome: z.literal("COPY_PARTIAL"), remaining: z.array(CopyKindSchema) }).strict(),
]);
type QueryInput = z.infer<typeof QueryInputSchema>;
export type QueryOutput = z.infer<typeof QueryOutputSchema>;
type ContextInput = z.input<typeof ContextInputSchema>;
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

/** One entry per distinct scope. Discovery mutations are exact-key grants; writing one also reads the app's own catalog. */
function scopesFor(context: RuntimeOperationContext, targets: readonly string[], forWrite = false) {
  const entries = new Map<string, AppsPermission>();
  const add = (entry: AppsPermission) => entries.set(`${entry.space}|${entry.path}|${entry.service}`, entry);
  for (const target of targets) {
    const parts = parseKey(target);
    const prefix = parts === undefined ? parsePrefix(target) : undefined;
    if (parts?.area === "discovery") {
      add(forWrite ? appDiscoveryPermission(context, parts.app) : discoveryPermission(context));
      if (forWrite) add(appRecordsPermission(context, parts.app));
    }
    else if (prefix?.discovery) add(discoveryPermission(context));
    else if (parts !== undefined || prefix?.app !== undefined) add(appRecordsPermission(context, (parts?.app ?? prefix!.app)!));
  }
  const resolve = operationSpaceResolver(context.runtime!.node, context.summary.space);
  return [...entries.values()].map((entry) => {
    if (!forWrite) return entry;
    const actions = entry.actions.filter((action) => !evaluateOperationAuthority(context.runtime!.granted as unknown as readonly PermissionEntry[], [{ ...entry, actions: [action] }], resolve).satisfied);
    return actions.length > 0 ? { ...entry, actions } : entry;
  });
}
const contextAuthority = async (context: RuntimeOperationContext, input: ContextInput) => {
  if (input.app === undefined) return [discoveryPermission(context)];
  if (Object.prototype.hasOwnProperty.call(TC_APPS_CATALOG_PERMISSIONS, input.app)) {
    const catalog = TC_APPS_CATALOG_PERMISSIONS[input.app]!;
    return [discoveryPermission(context), {
      ...catalog, space: appsSpace(context),
      actions: catalog.actions.filter((action) => input.access !== "read" || action !== "tinycloud.sql/write"),
    }];
  }
  return [discoveryPermission(context),
    ...(input.access === "read" ? [] : [appDiscoveryPermission(context, input.app)]),
    appRecordsPermission(context, input.app, input.access === "read" ? TC_APPS_CATALOG_READ_ACTIONS : undefined)];
};
const readAuthority = async (context: RuntimeOperationContext, input: ReadInput) => scopesFor(context, [...(input.prefixes ?? []), ...(input.keys ?? [])]).map((entry) => {
  const read = { ...entry, actions: [...TC_APPS_CATALOG_READ_ACTIONS] };
  return evaluateOperationAuthority(context.runtime!.granted as unknown as readonly PermissionEntry[], [read], operationSpaceResolver(context.runtime!.node, context.summary.space)).satisfied ? read : entry;
});
const writeAuthority = async (context: RuntimeOperationContext, input: WriteInput) => scopesFor(
  context,
  input.ops.flatMap((op) => op.op === "move" ? [op.from, op.to] : [op.key]),
  true,
);
const queryAuthority = async (context: RuntimeOperationContext, input: QueryInput) => {
  const app = input.kinds[0]!.app;
  return [appRecordsPermission(context, app), copyPermission(context, app)];
};

const contextDefinition: OperationDefinition<ContextInput, ContextOutput> = {
  id: "tinycloud.apps.context", version: 1, title: "Personal apps context",
  description: "Read the connected user's list of personal apps, local time and record-handling rules. Call first when the user requests a personal-record task. Supplying an IANA timezone saves or replaces their timezone setting for later calls. Do not use personal records to store credentials, payment-card data, government identifiers or protected health information.",
  input: ContextInputSchema, output: ContextOutputSchema, effects: ["read", "local_write"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
  sensitivity: { input: ["/timezone"], output: ["/apps", "/timezone", "/now"] }, authority: contextAuthority, execute: executeContext,
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
  id: "tinycloud.apps.query", version: 1, title: "Query personal records", description: "Answer the user's question over one app's personal records using an optional searchable copy. Requires separate copy approval. Name the app and every kind covered; the server writes or replaces the app's derived SQL copy before running one SELECT or WITH query with bound params. It refreshes a derived copy; never changes records. COPY_PARTIAL means the answer is incomplete; continue with the remaining kinds before answering.",
  input: QueryInputSchema, output: QueryOutputSchema, effects: ["read", "write"], runtime: "authenticated", postures: POSTURES, exposure: EXPOSURE,
  sensitivity: { input: ["/kinds", "/sql", "/params"], output: ["/kinds", "/rows", "/remaining"] }, authority: queryAuthority, execute: executeQuery,
};

export const appsOperationDefinitions = [contextDefinition, readDefinition, writeDefinition, queryDefinition] as const;

async function executeContext(context: OperationContext, input: ContextInput): Promise<OperationExecutionOutcome<ContextOutput>> {
  const parsed = ContextInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Provide a valid app id, access mode and IANA timezone.") };
  try {
    const timezone = await appsTimezone(context.summary.profile, parsed.data.timezone);
    const discovered = await discoveredApps(appsKv(context));
    const listed = await Promise.all([...discovered].sort(([a], [b]) => a.localeCompare(b)).map(async ([app, title]) => ({
      app, ...(title === undefined ? {} : { title }), copy: await appsCopyState(context.summary.profile, app, appsSpace(context)),
    })));
    return { status: "ok", output: { rules: TC_APPS_RULES, now: appsNow(timezone), utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), timezone, apps: listed } };
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
    const kv = appsKv(context);
    const lists = [];
    for (const prefix of parsed.data.prefixes ?? []) lists.push({ prefix, keys: await listAppsKeys(kv, prefix) });
    const requested = parsed.data.keys ?? [];
    const found = new Map<string, ReadRecord>();
    for (const record of await readAppsRecords(kv, requested)) found.set(record.key, record);
    return { status: "ok", output: { lists, records: requested.map((key) => found.get(key)!) } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}

async function executeQuery(context: OperationContext, input: QueryInput): Promise<OperationExecutionOutcome<QueryOutput>> {
  const parsed = QueryInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Name one app and its kinds and supply one read-only SELECT or WITH query with bound parameters.") };
  try {
    const app = parsed.data.kinds[0]!.app;
    const db = appsDatabase(context, app);
    const unique = [...new Map(parsed.data.kinds.map((kind) => [`${kind.app}/${kind.kind}`, kind])).values()];
    const checked = await checkCopyKinds(appsKv(context), db, unique);
    if ("outcome" in checked) return { status: "ok", output: checked };
    const result = await queryCopy(db, parsed.data.sql, (parsed.data.params ?? []).map(decodeSqlInputValue));
    return { status: "ok", output: { ...checked, ...result, columns: [...result.columns], rows: result.rows.map((row) => [...row]) } };
  } catch (error) { return { status: "error", error: appsFailure(error) }; }
}

interface Touched { app: string; kind: string; owners: OpOutcome[] }
interface CopyBatch { app: string; rows: Map<string, CopyRow> }

async function executeWrite(context: OperationContext, input: WriteInput): Promise<OperationExecutionOutcome<WriteOutput>> {
  // Validate the entire batch before obtaining a handle or executing its first op.
  const parsed = WriteInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: operationError("INPUT_INVALID", "Every op must have a valid personal-record key and JSON record, catalog or discovery value.", { details: { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) } }) };
  const kv = appsKv(context);
  // Without read access to the app list the entry check is skipped rather than asking for another approval.
  const listReadable = hasDiscoveryAccess(context);
  let timezone: string | null;
  try { timezone = await appsTimezone(context.summary.profile); }
  catch (error) { return { status: "error", error: appsFailure(error) }; }
  const ops: OpOutcome[] = [];
  const touched = new Map<string, Touched>();
  const batches = new Map<string, CopyBatch>();
  const refresh: { app: string; key: string }[] = [];
  for (const op of parsed.data.ops) {
    const key = op.op === "move" ? op.to : op.key;
    const parts = keyParts(key);
    let outcome: OpOutcome;
    try { outcome = await writeOne(kv, op, timezone, listReadable); }
    catch (error) { outcome = { key, outcome: appsFailure(error).code }; }
    ops.push(outcome);
    if (parts.area === "discovery" || !(outcome.outcome === "ok" || outcome.steps?.includes("written"))) continue;
    const changedKeys = op.op === "move" ? [outcome.key, op.from] : [outcome.key];
    if (op.op === "move" && !outcome.steps?.includes("deleted")) refresh.push({ app: parts.app, key: op.from });
    for (const changed of changedKeys) {
      const changedParts = keyParts(changed);
      if (changedParts.area === "record") {
        const batch = batches.get(changedParts.app) ?? { app: changedParts.app, rows: new Map() };
        batch.rows.set(changed, { k: copyKey(changedParts.app, changed), ...(changed === outcome.key && op.op !== "delete" && outcome.value ? { r: outcome.value } : {}) });
        batches.set(changedParts.app, batch);
      }
      if (changedParts.area === "stale" || changedParts.area === "discovery" || changedParts.kind === undefined) continue;
      const marker = `${changedParts.app}/${changedParts.kind}`;
      const entry = touched.get(marker) ?? { app: changedParts.app, kind: changedParts.kind, owners: [] };
      if (!entry.owners.includes(outcome)) entry.owners.push(outcome);
      touched.set(marker, entry);
    }
  }
  // Upkeep must never erase committed outcomes or turn a refusal into an approval loop.
  const synced = new Set<string>();
  let upkeepWarning: string | undefined;
  try {
    for (const [app, batch] of batches) {
      if (!hasCopyAuthority(context, app)) continue;
      const sources = refresh.filter((entry) => entry.app === app).map((entry) => entry.key);
      for (const record of await readAppsRecords(kv, sources)) {
        const k = copyKey(app, record.key);
        if ("value" in record) batch.rows.set(record.key, { k, r: record.value });
        else if (record.outcome === "NOT_FOUND") batch.rows.set(record.key, { k });
        else throw new Error("A move source is malformed.");
      }
      await syncCopyRows(appsDatabase(context, app), [...batch.rows.values()]);
      synced.add(app);
    }
  } catch (error) {
    const failure = appsFailure(error);
    upkeepWarning = failure.details?.reason === "copy_unavailable"
      ? "The record changed, but the fast copy needs the node team. Answer from records; do not retry or ask for another approval."
      : `The record changed, but fast-copy upkeep failed (${failure.code}); its kind is marked stale.`;
  }
  for (const { app, kind, owners } of touched.values()) {
    if (upkeepWarning) for (const owner of owners) (owner.warnings ??= []).push(upkeepWarning);
    if (synced.has(app) && batches.get(app)!.rows.size > 0) continue;
    try { await markAppsKindStale(kv, app, kind, appsNow(timezone)); }
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
async function writeOne(kv: AppsKv, op: WriteOp, timezone: string | null, listReadable: boolean): Promise<OpOutcome> {
  const key = op.op === "move" ? op.to : op.key;
  const parts = keyParts(key);
  if (parts.area === "discovery") return writeDiscovery(kv, op, parts.app);
  const catalog = parts.area === "catalog" ? parts : undefined;
  if (!catalog && timezone === null) return { key, outcome: "TIMEZONE_REQUIRED" };
  if (parts.area === "record") {
    // Every change to a record (create, replace, move, delete) needs the app's own catalog record, so a folder that holds
    // another app's files can never be edited as a generic app.
    if (!("value" in (await readAppsRecords(kv, [catalogKey(parts.app)]))[0]!)) {
      return { key, outcome: "INVALID", warnings: ["Records can only be changed in an app that has a catalog record."] };
    }
    // An app is switched on by its discovery entry: a record written before it would be missing from the app list and from the CLI's view of the app.
    if (op.op === "put" && op.etag === undefined && listReadable && !("value" in (await readAppsRecords(kv, [discoveryKey(parts.app)]))[0]!)) {
      return { key, outcome: "INVALID", warnings: [`${parts.app} has no discovery entry yet: write its entry (after its first kind) before its first record.`] };
    }
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
      const app = (await readAppsRecords(kv, [catalogKey(parts.app)]))[0]!;
      if (!("value" in app)) return { key, outcome: "INVALID", warnings: ["A kind requires its app's catalog record."] };
    } else if (op.op === "put" && op.etag === undefined) {
      const manifest = (await readAppsRecords(kv, [`${appRoot(parts.app)}manifest.json`]))[0]!;
      if ("value" in manifest || manifest.outcome !== "NOT_FOUND") {
        return { key, outcome: "INVALID", warnings: [`${appRoot(parts.app)} already holds another app's own files (manifest.json). Use a different app name.`] };
      }
    }
    if (op.op === "put" && op.etag !== undefined) {
      const current = (await readAppsRecords(kv, [key]))[0]!;
      if (!("value" in current)) return { key, outcome: current.outcome === "NOT_FOUND" ? "NOT_FOUND" : "INVALID" };
      if (current.etag !== op.etag) return { ...current, outcome: "CHANGED" };
      if (!catalogChangeAllowed(current.value, value)) return { ...current, outcome: "CATALOG_CHANGE" };
    }
  } else {
    const record = recordParts(key);
    const records = await readAppsRecords(kv, [catalogKey(record.app), catalogKey(record.app, record.kind)]);
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
async function writeDiscovery(kv: AppsKv, op: WriteOp, app: string): Promise<OpOutcome> {
  const key = discoveryKey(app);
  if (op.op !== "put") return { key, outcome: "INVALID", warnings: ["A discovery entry is only created or replaced."] };
  const record = (await readAppsRecords(kv, [catalogKey(app)]))[0]!;
  if (!("value" in record)) return { key, outcome: "INVALID", warnings: ["Write the app's catalog record and a kind record before its discovery entry."] };
  if ((await listAppsKeys(kv, catalogPrefix(app))).length === 0) return { key, outcome: "INVALID", warnings: ["Write a kind record before the app's discovery entry."] };
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
