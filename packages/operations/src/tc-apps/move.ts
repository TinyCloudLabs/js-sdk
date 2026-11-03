import { createHash } from "node:crypto";
import { z } from "zod";
import { appsFailure, jsonBytes, listAppsKeys, readAppsRecords, type AppsKv, type ReadRecord } from "./kv.js";
import { appRoot, catalogKey, discoveryKey, moveKey, newApp, parseKey, staleKey, TC_APPS_LEGACY_ROOT } from "./layout.js";
import type { Json, JsonObject } from "./records.js";

export const MoveInputSchema = z.object({
  app: z.string().regex(/^[a-z0-9-]+$/).max(64),
  dryRun: z.boolean().describe("true prints the plan and writes nothing; false copies the app into its new folder."),
}).strict();
export const MoveOutputSchema = z.object({
  app: z.string(),
  status: z.enum(["dry_run", "moved", "already_moved", "nothing_to_move", "MOVE_PARTIAL", "CONFLICT", "NOT_SWITCHED"]),
  total: z.number().int().nonnegative(), catalog: z.number().int().nonnegative(),
  kinds: z.array(z.object({ kind: z.string(), count: z.number().int().nonnegative() }).strict()),
  copied: z.number().int().nonnegative().optional(), remaining: z.number().int().nonnegative().optional(),
  problems: z.array(z.string()).optional(),
  drift: z.array(z.string()).optional(),
  conflicts: z.array(z.object({ from: z.string(), to: z.string(), fromEtag: z.string(), toEtag: z.string() }).strict()).optional(),
  message: z.string(),
}).strict();
export type MoveInput = z.infer<typeof MoveInputSchema>;
export type MoveOutput = z.infer<typeof MoveOutputSchema>;

export interface MoveEnv {
  /** Only ever read: a move never writes or deletes in the older layout. */
  readonly legacy: AppsKv;
  readonly next: AppsKv;
  readonly clock: () => number;
  readonly budgetMs: number;
}
const CHUNK = 100;
/** One call verifies and compares every record, so a move has a ceiling. */
const MAX_KEYS = 5000;
const LIST_LIMIT = 50;

interface Mapping { from: string; to: string; catalog: boolean; kind?: string }

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: JsonObject): string => createHash("sha256").update(canonical(value)).digest("hex");
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, index) => items.slice(index * CHUNK, (index + 1) * CHUNK));
const sample = (items: readonly string[]) => items.slice(0, LIST_LIMIT);
const recordDigest = (record: ReadRecord): string | undefined => "value" in record ? digest(record.value) : undefined;

/** Every key of the app in the older layout: its catalog records, then its data. Complete listings only. */
async function inventory(legacy: AppsKv, app: string): Promise<string[]> {
  const catalog = catalogKey("legacy", app);
  const own = (await listAppsKeys(legacy, catalog)).filter((key) => key === catalog || key.startsWith(`${catalog}/`));
  const data = await listAppsKeys(legacy, `${TC_APPS_LEGACY_ROOT}${app}/`);
  return [...own, ...data].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function plan(app: string, keys: readonly string[]): { map: Mapping[]; problems: string[] } {
  const problems: string[] = [];
  const map: Mapping[] = [];
  for (const from of keys) {
    const parts = parseKey(from);
    const to = parts === undefined ? undefined : moveKey(app, from);
    const target = to === undefined ? undefined : parseKey(to);
    if (!parts || parts.layout !== "legacy" || parts.app !== app || (parts.area !== "catalog" && parts.area !== "record") || !target || target.layout !== "new") {
      problems.push(`${from}: not a key the new layout can hold (a kind named catalog or index-stale, or an unexpected key).`);
      continue;
    }
    map.push({ from, to: to!, catalog: parts.area === "catalog", ...(parts.area === "record" ? { kind: parts.kind } : {}) });
  }
  // Catalog records go first, so an interrupted copy never leaves records without their catalog.
  map.sort((a, b) => Number(b.catalog) - Number(a.catalog) || (a.from < b.from ? -1 : 1));
  return { map, problems };
}

function summary(app: string, map: readonly Mapping[]): Pick<MoveOutput, "app" | "total" | "catalog" | "kinds"> {
  const counts = new Map<string, number>();
  for (const { kind } of map) if (kind !== undefined) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return {
    app, total: map.length, catalog: map.filter((entry) => entry.catalog).length,
    kinds: [...counts].sort(([a], [b]) => a < b ? -1 : 1).map(([kind, count]) => ({ kind, count })),
  };
}

function stop(base: Pick<MoveOutput, "app" | "total" | "catalog" | "kinds">, status: MoveOutput["status"], message: string, extra: Partial<MoveOutput> = {}): MoveOutput {
  return { ...base, status, ...extra, message };
}

/**
 * Copy one app from the older layout into its own folder in the new one. Create-only, verified, and the discovery entry
 * (the switch other clients read) is written last. The older records are never changed or deleted. Rerunning is safe.
 * Only keys that are not yet in the new folder are copied inside the time budget, so every run makes progress; the
 * comparison of everything that is there (keys copied earlier, by this tool or another) runs once the copy is complete.
 */
export async function moveApp(env: MoveEnv, app: string, dryRun: boolean): Promise<MoveOutput> {
  const empty = { app, total: 0, catalog: 0, kinds: [] };
  if (!newApp(app)) {
    return stop(empty, "NOT_SWITCHED", `${app} is a reserved name in the new layout, so it stays in the older layout (xyz.tinycloud.agent-data/). Nothing was changed.`);
  }
  const entryKey = discoveryKey(app);
  const keys = await inventory(env.legacy, app);
  const { map, problems } = plan(app, keys);
  const base = summary(app, map);
  if (!dryRun) {
    const [entry] = await readAppsRecords(env.next, [entryKey]);
    if (entry && "value" in entry) {
      const present = new Set(await listAppsKeys(env.next, appRoot(app)));
      const stranded = map.filter((item) => !present.has(item.to)).map((item) => item.from);
      return stranded.length === 0
        ? stop(empty, "already_moved", `${app} already lives in ${appRoot(app)}. Nothing was changed.`)
        : stop(base, "already_moved", `${app} already lives in ${appRoot(app)}, but ${stranded.length} older records are not in it: they were written to the older place after the move, or deleted from the new folder since. Nothing was copied or changed; never copy them back without telling the owner which of the two it is.`, { drift: sample(stranded) });
    }
  }
  if (!keys.includes(catalogKey("legacy", app))) {
    return stop(empty, "nothing_to_move", `The older layout has no catalog record for ${app}, so by the layout rule it is not an older app. Nothing was written.`);
  }
  if (problems.length > 0) return stop({ ...base, total: keys.length }, "NOT_SWITCHED", "Some older keys cannot be held by the new layout. Nothing was copied.", { problems: sample(problems) });
  if (map.length > MAX_KEYS) return stop(base, "NOT_SWITCHED", `${app} has ${map.length} records; one move handles at most ${MAX_KEYS}. Nothing was copied this run and the app stays in the older layout; a partial copy left by an earlier run is not in use.`);
  if (dryRun) return stop(base, "dry_run", `Would copy ${base.total} records (${base.catalog} catalog) from xyz.tinycloud.agent-data/ into ${appRoot(app)} and then add ${entryKey}. The older records stay as they are.`);

  const expected = new Set(map.map((item) => item.to));
  const existing = new Set(await listAppsKeys(env.next, appRoot(app)));
  const extras = [...existing].filter((key) => !expected.has(key) && !key.startsWith(`${appRoot(app)}index-stale/`));
  if (extras.length > 0) {
    return stop(base, "NOT_SWITCHED", `${appRoot(app)} already holds keys the older ${app} does not have. Nothing was written.`, { problems: sample(extras) });
  }

  // 1. Copy what is not there yet, within the budget. The first group always runs, so a rerun always moves forward.
  const missing = map.filter((item) => !existing.has(item.to));
  const created = new Set<string>();
  const bad: string[] = [];
  const started = env.clock();
  let done = 0;
  for (const group of chunks(missing)) {
    if (done > 0 && env.clock() - started >= env.budgetMs) {
      return stop(base, "MOVE_PARTIAL", `Copied ${created.size} this run; ${missing.length - done} records remain. Run the move again to continue; nothing has switched.`, { copied: created.size, remaining: missing.length - done });
    }
    const source = await readAppsRecords(env.legacy, group.map((item) => item.from));
    for (const [index, item] of group.entries()) {
      const old = source[index]!;
      if (!("value" in old)) { bad.push(`${item.from}: ${old.outcome === "MALFORMED" ? "is not a JSON object" : "disappeared while copying"}`); continue; }
      const put = await env.next.put(item.to, jsonBytes(old.value), { ifNoneMatch: "*" });
      if (put.ok) created.add(item.to);
      else if (put.error.code !== "KV_PRECONDITION_FAILED") throw appsFailure(put.error);
    }
    done += group.length;
  }

  // 2. Compare every key, the ones copied now and the ones already there: same content under each.
  const sums = new Map<string, string>();
  const conflicts: NonNullable<MoveOutput["conflicts"]> = [];
  let title: unknown;
  for (const group of chunks(map)) {
    const old = await readAppsRecords(env.legacy, group.map((item) => item.from));
    const there = await readAppsRecords(env.next, group.map((item) => item.to));
    for (const [index, item] of group.entries()) {
      const from = old[index]!;
      const to = there[index]!;
      if (!("value" in from)) { bad.push(`${item.from}: ${from.outcome === "MALFORMED" ? "is not a JSON object" : "disappeared while copying"}`); continue; }
      const sum = digest(from.value);
      sums.set(item.from, sum);
      if (item.from === catalogKey("legacy", app)) title = from.value.title;
      if (!("value" in to)) bad.push(`${item.to}: missing or unreadable after copying`);
      else if (digest(to.value) !== sum) {
        if (created.has(item.to)) bad.push(`${item.to}: reads back different from the older record`);
        else conflicts.push({ from: item.from, to: item.to, fromEtag: from.etag, toEtag: to.etag });
      }
    }
  }
  if (conflicts.length > 0) {
    return stop(base, "CONFLICT", "Some keys already hold different content in the new folder. Nothing was overwritten and the app did not switch; ask the owner which version is right.", { conflicts: conflicts.slice(0, LIST_LIMIT), ...(bad.length > 0 ? { problems: sample(bad) } : {}) });
  }
  if (bad.length > 0) return stop(base, "NOT_SWITCHED", "Some records could not be copied as they are. Nothing switched and nothing was deleted.", { problems: sample(bad) });

  // 3. The same key set in the new folder, then the older place once more for edits made while copying.
  const after = (await listAppsKeys(env.next, appRoot(app))).filter((key) => !key.startsWith(`${appRoot(app)}index-stale/`)).sort();
  const want = [...expected].sort();
  if (after.length !== want.length || after.some((key, index) => key !== want[index])) {
    return stop(base, "NOT_SWITCHED", "The new folder and the older app do not hold the same keys. Nothing switched.", { problems: sample(after.filter((key) => !expected.has(key)).concat(want.filter((key) => !after.includes(key)))) });
  }
  const again = await inventory(env.legacy, app);
  if (again.length !== keys.length || again.some((key, index) => key !== keys[index])) {
    return stop(base, "NOT_SWITCHED", "The older place gained or lost records while copying. Pause every device that writes this app, then run the move again. Nothing switched.");
  }
  for (const group of chunks(map)) {
    const read = await readAppsRecords(env.legacy, group.map((item) => item.from));
    const changed = group.filter((item, index) => recordDigest(read[index]!) !== sums.get(item.from));
    if (changed.length > 0) return stop(base, "NOT_SWITCHED", "An older record changed while copying. Pause every device that writes this app, then run the move again. Nothing switched.", { problems: sample(changed.map((item) => item.from)) });
  }

  // 4. Mark each kind's fast copy stale (a copy from an earlier life of this app must be rebuilt), then switch.
  const since = new Date(env.clock()).toISOString().slice(0, 10);
  for (const { kind } of base.kinds) {
    const marked = await env.next.put(staleKey("new", app, kind), jsonBytes({ since, by: "tinycloud-mcp" }), {});
    if (!marked.ok) throw appsFailure(marked.error);
  }
  const entry: JsonObject = { v: 1, app, id: `xyz.tinycloud.tinyapps.${app}`, title: typeof title === "string" && title.length > 0 ? title : app };
  const put = await env.next.put(entryKey, jsonBytes(entry), { ifNoneMatch: "*" });
  if (!put.ok) {
    if (put.error.code !== "KV_PRECONDITION_FAILED") throw appsFailure(put.error);
    const [existingEntry] = await readAppsRecords(env.next, [entryKey]);
    if (!existingEntry || !("value" in existingEntry) || digest(existingEntry.value) !== digest(entry)) {
      return stop(base, "NOT_SWITCHED", `${entryKey} already exists with different content. Nothing was overwritten.`);
    }
  }
  // A write to the older place can land between the last check and the switch: report it rather than strand it silently.
  const latest = new Set(await inventory(env.legacy, app));
  const drift = [...latest].filter((key) => !keys.includes(key));
  const moved = `Moved ${base.total} records (${base.catalog} catalog) into ${appRoot(app)} and read them back the same. The older records in xyz.tinycloud.agent-data/ were left as they are; nothing was deleted.`;
  return stop(base, "moved", drift.length === 0 ? moved : `${moved} ${drift.length} records were written to the older place while it switched and are not in the new folder; ask the owner what to do with them.`, { copied: created.size, ...(drift.length > 0 ? { drift: sample(drift) } : {}) });
}
