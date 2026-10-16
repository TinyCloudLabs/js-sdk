import { lstat, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  diagnosticId, diagnosticDataObject, diagnosticConflictSelected, diagnosticEventSelected, diagnosticMetadataEqual, isDiagnosticId, isDiagnosticTime,
  validateDiagnosticDescriptor, validateDiagnosticEvent, validateDiagnosticSelection,
  encodeDiagnosticEvent, METADATA_RETENTION_MS, DETAIL_RETENTION_MS,
} from "./model.js";
import type { DiagnosticDescriptor, DiagnosticEvent, DiagnosticGap, DiagnosticSelection, DiagnosticSnapshot } from "./model.js";
import {
  DIAGNOSTIC_LIMITS, diagnosticRoot, initializeControl, newPolicy, readPolicy, savePolicy, withDiagnosticDirectory, withDiagnosticLock,
} from "./control.js";
import type { DiagnosticPolicy } from "./control.js";
import {
  absolutePath, atomicPrivateWrite, DiagnosticError, diagnosticFailure, diagnosticGuard, inside, isMissing,
  privateAppend, privateDirectoryExists, privateEntries, privateExists, privateJson, privateMkdir,
  privateRead, privateStat, removePrivateTree, replacePrivateDirectory, syncPrivateFile, withPrivateDirectory, writePrivateDirectory,
} from "./filesystem.js";
import type { DiagnosticFailure, PrivateDirectory } from "./filesystem.js";
import { decodeDiagnosticBundle, rewriteDiagnosticBundle } from "./bundles.js";
import { parseDiagnosticJson } from "./selection.js";

export interface DiagnosticStatus {
  enabled: boolean; paused: boolean; generation: number; source_id?: string; partition_id?: string;
  root: string; detail_allowed: boolean;
  health: { failure?: DiagnosticFailure; incomplete: number; malformed: number };
  limits: typeof DIAGNOSTIC_LIMITS;
}
export interface DiagnosticInspection extends DiagnosticStatus {
  scope: "tc-apps";
  policy: { capture: "metadata_only"; metadata_retention_ms: number; selected_detail_retention_ms: number; external_copies: "not_managed" };
  usage: { partition_bytes: number; detail_bytes: number; root_bytes?: number; controlled_copies_included: true; partition_limit_includes_detail: true };
  provenance: DiagnosticDescriptor[];
  provenance_scope: "local_source_descriptors";
  coverage: { complete_history: "not_guaranteed"; task_acceptance: "requires_selected_evidence"; gaps: DiagnosticGap[] };
  adapters: { baseline: readonly ["explicit_launcher", "owner_linkage"]; client_installations: "not_inspected" };
}
export interface ManagedObjectMetadata {
  expires_at: string; source_ids: readonly string[]; event_ids: readonly string[]; detail: boolean;
  case_ids?: readonly string[]; metadata_bytes?: number; detail_bytes?: number;
}
export interface DeletionReport {
  events: number; objects: number; descriptors: number; complete: boolean;
  paused: boolean; enabled: boolean; generation: number; limitations: string[];
}
export type ManagedKind = "imports" | "cases" | "exports";
const KINDS: readonly ManagedKind[] = ["imports", "cases", "exports"];
const FILES: Readonly<Record<string, true>> = {
  "manifest.json": true, "events.jsonl": true, "detail.json": true,
  "fixture.json": true, "reproduce.mjs": true, "instructions.txt": true,
};
const FILE_COUNT = Object.keys(FILES).length;
const UUID_FILE = /^[0-9a-f-]{36}\.json$/;
const SEGMENT_FILE = /^[0-9a-f-]{36}-[1-9][0-9]{0,15}-[0-9a-f-]{36}\.jsonl$/;
const TEMPORARY = /^\.[0-9a-f-]{36}\.tmp$/;
interface Usage { metadata: number; detail: number; root: number }
interface Segment { path: string; events: DiagnosticEvent[]; incomplete: number; malformed: number; bytes: number }
interface StoredObject { id: string; path: string; kind: ManagedKind; meta: ManagedObjectMetadata }
export class DiagnosticDeletionError extends DiagnosticError {
  readonly incomplete = true;
  constructor(failure: DiagnosticFailure) {
    super(failure);
    this.name = "DiagnosticDeletionError";
    this.message = "Diagnostic deletion incomplete; inspect capture status";
  }
}
const appendMaintenance = new Map<string, { generation: number; swept: number }>();

async function prepareAppendMaintenance(directory: PrivateDirectory, partition: string, generation: number, force = false): Promise<boolean> {
  const key = `${directory.logical}/${partition}`;
  const now = Date.now();
  const cached = appendMaintenance.get(key);
  if (!force && cached?.generation === generation && now >= cached.swept && now - cached.swept < DIAGNOSTIC_LIMITS.sweep_ms) return false;
  let swept = 0;
  let changed = false;
  if (!force && await privateDirectoryExists(join(directory.path, "control", "maintenance"))) {
    try {
      const record = await privateJson<{ version: number; swept_at: string }>(join(directory.path, "control", "maintenance", `${partition}.json`));
      if (record.version !== 1 || Object.keys(record).length !== 2 || !isDiagnosticTime(record.swept_at)) throw new DiagnosticError("invalid");
      swept = Date.parse(record.swept_at);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  if (force || swept > now || now - swept >= DIAGNOSTIC_LIMITS.sweep_ms) {
    await maintainPartition(directory, partition, now); swept = now; changed = true;
  }
  if (appendMaintenance.size >= 64 && !appendMaintenance.has(key)) appendMaintenance.delete(appendMaintenance.keys().next().value!);
  appendMaintenance.set(key, { generation, swept });
  return changed;
}

async function availableSegment(base: string, names: readonly string[], sizes: Map<string, number>, prefix: string, bytes: number): Promise<string | undefined> {
  for (let index = names.length - 1; index >= 0; index--) {
    const name = names[index];
    if (!name.startsWith(prefix) || !SEGMENT_FILE.test(name)) continue;
    let size = sizes.get(name);
    if (size === undefined) { size = (await privateStat(join(base, name))).size; sizes.set(name, size); }
    if (size + bytes <= DIAGNOSTIC_LIMITS.segment_bytes) return name;
  }
  return undefined;
}

function validSelection(selection: DiagnosticSelection): DiagnosticSelection {
  const valid = validateDiagnosticSelection(selection);
  if (!valid) throw new DiagnosticError("invalid");
  return valid;
}
function validKind(kind: ManagedKind): void { if (!KINDS.includes(kind)) throw new DiagnosticError("invalid"); }
function validId(id: string): void { if (!isDiagnosticId(id)) throw new DiagnosticError("invalid"); }
function objectMetadata(value: unknown, now = Date.now(), allowExpired = false): ManagedObjectMetadata {
  const data = diagnosticDataObject(value, 7);
  if (!data || Object.keys(data).some((key) => !["expires_at", "source_ids", "event_ids", "detail", "case_ids", "metadata_bytes", "detail_bytes"].includes(key))
    || !isDiagnosticTime(data.expires_at) || typeof data.detail !== "boolean") throw new DiagnosticError("invalid");
  for (const key of ["source_ids", "event_ids", "case_ids"] as const) {
    const ids = data[key];
    if (key === "case_ids" && ids === undefined) continue;
    if (!Array.isArray(ids) || ids.length > 8192 || ids.some((id) => !isDiagnosticId(id)) || new Set(ids).size !== ids.length) throw new DiagnosticError("invalid");
  }
  for (const key of ["metadata_bytes", "detail_bytes"] as const) {
    if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || Number(data[key]) < 0)) throw new DiagnosticError("invalid");
  }
  if (!allowExpired && Date.parse(data.expires_at) <= now) throw new DiagnosticError("expired");
  if (Date.parse(data.expires_at) > now + (data.detail ? DETAIL_RETENTION_MS : METADATA_RETENTION_MS)) throw new DiagnosticError("invalid");
  return data as unknown as ManagedObjectMetadata;
}
function prepareFiles(files: Readonly<Record<string, string | Uint8Array>>, meta: ManagedObjectMetadata): { files: Record<string, string | Uint8Array>; meta: ManagedObjectMetadata } {
  const values = diagnosticDataObject(files, FILE_COUNT);
  if (!values || Object.keys(values).length === 0) throw new DiagnosticError("invalid");
  let metadata = 0; let detail = 0;
  const output: Record<string, string | Uint8Array> = Object.create(null);
  for (const [name, data] of Object.entries(values)) {
    if (!Object.prototype.hasOwnProperty.call(FILES, name) || (typeof data !== "string" && !(data instanceof Uint8Array))) throw new DiagnosticError("invalid");
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    // Detail-bearing bundle attachments count in both total source storage and the detail subquota.
    const detailed = !["events.jsonl", "manifest.json"].includes(name);
    if (detailed && !meta.detail) throw new DiagnosticError("invalid");
    if (detailed) detail += bytes; else metadata += bytes;
    if (detail > DIAGNOSTIC_LIMITS.detail_object_bytes || metadata > DIAGNOSTIC_LIMITS.metadata_bytes) throw new DiagnosticError("quota");
    output[name] = data;
    if (name === "events.jsonl") {
      const text = typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
      if (text && !text.endsWith("\n")) throw new DiagnosticError("invalid");
      const sources = new Set(meta.source_ids); const events = new Set(meta.event_ids);
      for (const line of text.split("\n").filter(Boolean)) {
        if (Buffer.byteLength(line) > DIAGNOSTIC_LIMITS.event_bytes) throw new DiagnosticError("invalid");
        let event: DiagnosticEvent | undefined;
        try { event = validateDiagnosticEvent(parseDiagnosticJson(Buffer.from(line))); } catch { throw new DiagnosticError("invalid"); }
        if (!event) throw new DiagnosticError("invalid");
        if (Date.parse(meta.expires_at) > Date.parse(event.occurred_at) + METADATA_RETENTION_MS) throw new DiagnosticError("expired");
        sources.add(event.source_id); events.add(event.event_id);
      }
      meta = { ...meta, source_ids: [...sources], event_ids: [...events] };
    }
  }
  // Copy declared IDs only after validation; the metadata byte counters are never accepted from input.
  const computed = { ...meta, metadata_bytes: metadata, detail_bytes: detail };
  return { files: output, meta: computed };
}
function partitionDirectory(directory: PrivateDirectory, id: string): string { return join(directory.path, "partitions", id); }
function managedDirectory(directory: PrivateDirectory, kind: ManagedKind, id: string): string { return join(directory.path, kind, id); }
async function objects(directory: PrivateDirectory, partition: string, kind?: ManagedKind): Promise<StoredObject[]> {
  const result: StoredObject[] = [];
  for (const type of kind ? [kind] : KINDS) {
    if (!await privateDirectoryExists(join(directory.path, type))) continue;
    const base = managedDirectory(directory, type, partition);
    if (!await privateDirectoryExists(base)) continue;
    for (const id of await privateEntries(base, DIAGNOSTIC_LIMITS.objects)) {
      if (TEMPORARY.test(id)) continue;
      validId(id);
      const path = join(base, id);
      if (!await privateDirectoryExists(path)) continue;
      const meta = objectMetadata(await privateJson(join(path, "metadata.json"), 1024 * 1024), Date.now(), true);
      result.push({ id, path, kind: type, meta });
    }
  }
  return result;
}
async function readObject(object: StoredObject): Promise<{ files: Record<string, Uint8Array>; meta: ManagedObjectMetadata }> {
  const files: Record<string, Uint8Array> = Object.create(null);
  const container = await privateEntries(object.path, 2);
  if (container.length !== 2 || !container.includes("metadata.json") || !container.includes("bundle")) throw new DiagnosticError("unsafe_path");
  const payload = join(object.path, "bundle");
  for (const name of await privateEntries(payload, FILE_COUNT)) {
    if (!Object.prototype.hasOwnProperty.call(FILES, name)) throw new DiagnosticError("unsafe_path");
    files[name] = await privateRead(join(payload, name), name === "events.jsonl" || name === "manifest.json" ? DIAGNOSTIC_LIMITS.metadata_bytes : DIAGNOSTIC_LIMITS.detail_object_bytes);
  }
  const prepared = prepareFiles(files, object.meta);
  if (prepared.meta.metadata_bytes !== object.meta.metadata_bytes || prepared.meta.detail_bytes !== object.meta.detail_bytes) throw new DiagnosticError("invalid");
  return { files, meta: prepared.meta };
}
async function segments(directory: PrivateDirectory, partition: string): Promise<Segment[]> {
  if (!await privateDirectoryExists(join(directory.path, "partitions")) || !await privateDirectoryExists(partitionDirectory(directory, partition))) return [];
  const base = join(partitionDirectory(directory, partition), "segments");
  if (!await privateDirectoryExists(base)) return [];
  const result: Segment[] = [];
  for (const name of await privateEntries(base)) {
    if (TEMPORARY.test(name)) continue;
    if (!SEGMENT_FILE.test(name)) throw new DiagnosticError("unsafe_path");
    const path = join(base, name);
    const bytes = await privateRead(path, DIAGNOSTIC_LIMITS.segment_bytes);
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const tail = lines.pop();
    const events: DiagnosticEvent[] = [];
    let malformed = 0;
    for (const line of lines) {
      if (Buffer.byteLength(line) > DIAGNOSTIC_LIMITS.event_bytes) { malformed++; continue; }
      let event: DiagnosticEvent | undefined;
      try { event = validateDiagnosticEvent(JSON.parse(line)); } catch { /* raw invalid lines are not retained */ }
      if (event && event.partition_id === partition) events.push(event); else malformed++;
    }
    result.push({ path, events, incomplete: tail ? 1 : 0, malformed, bytes: bytes.byteLength });
  }
  return result;
}
async function measurePartitions(directory: PrivateDirectory, partitions: ReadonlySet<string>): Promise<Map<string, Usage>> {
  const usages = new Map<string, Usage>();
  for (const partition of partitions) usages.set(partition, { metadata: 0, detail: 0, root: 0 });
  const selected = new Set<string>();
  let entries = 0; let root = 0;
  async function visit(path: string, depth: number, detailed: boolean): Promise<void> {
    if (depth > 6 || ++entries > DIAGNOSTIC_LIMITS.objects * 4) throw new DiagnosticError("quota");
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      if (!await privateDirectoryExists(path)) throw new DiagnosticError("unsafe_path");
      for (const name of await privateEntries(path)) {
        if (depth === 0 && [".writer-lock", ".repair-lock"].includes(name)) continue;
        const added = usages.has(name) && !selected.has(name);
        if (added) selected.add(name);
        await visit(join(path, name), depth + 1, detailed || name === "detail.json" || name === "fixture.json" || name === "reproduce.mjs" || name === "instructions.txt");
        if (added) selected.delete(name);
      }
    } else {
      const file = await privateStat(path);
      root += file.size;
      for (const partition of selected) {
        const usage = usages.get(partition)!;
        usage.metadata += file.size; if (detailed) usage.detail += file.size;
      }
    }
  }
  await visit(directory.path, 0, false);
  for (const usage of usages.values()) usage.root = root;
  return usages;
}
async function measure(directory: PrivateDirectory, partition: string): Promise<Usage> {
  return (await measurePartitions(directory, new Set([partition]))).get(partition)!;
}
function reserve(usage: Usage, metadata: number, detail = 0): void {
  if (usage.root + metadata + detail > DIAGNOSTIC_LIMITS.root_bytes - DIAGNOSTIC_LIMITS.control_reserve_bytes || usage.metadata + metadata + detail > DIAGNOSTIC_LIMITS.metadata_bytes
    || usage.detail + detail > DIAGNOSTIC_LIMITS.detail_bytes) throw new DiagnosticError("quota");
}
async function rewrite(directory: PrivateDirectory, partition: string, segment: Segment, kept: DiagnosticEvent[]): Promise<void> {
  if (!kept.length) { await unlink(segment.path); return; }
  const text = kept.map((event) => encodeDiagnosticEvent(event)! + "\n").join("");
  reserve(await measure(directory, partition), Buffer.byteLength(text));
  await atomicPrivateWrite(segment.path, text);
}
async function maintainPartition(directory: PrivateDirectory, partition: string, now: number): Promise<{ incomplete: number; malformed: number }> {
  const health = { incomplete: 0, malformed: 0 };
  for (const kind of KINDS) {
    if (!await privateDirectoryExists(join(directory.path, kind))) continue;
    const base = managedDirectory(directory, kind, partition);
    if (!await privateDirectoryExists(base)) continue;
    for (const name of await privateEntries(base)) {
      const previous = /^\.([0-9a-f-]{36})\.old$/.exec(name);
      if (!previous || !isDiagnosticId(previous[1])) continue;
      const destination = join(base, previous[1]);
      if (await privateDirectoryExists(destination)) await removePrivateTree(join(base, name));
      else await rename(join(base, name), destination);
    }
  }
  for (const segment of await segments(directory, partition)) {
    health.incomplete += segment.incomplete; health.malformed += segment.malformed;
    const kept = segment.events.filter((event) => Date.parse(event.occurred_at) + METADATA_RETENTION_MS > now);
    if (kept.length !== segment.events.length || segment.incomplete || segment.malformed) await rewrite(directory, partition, segment, kept);
  }
  const descriptorBase = join(partitionDirectory(directory, partition), "descriptors");
  if (await privateDirectoryExists(join(directory.path, "partitions")) && await privateDirectoryExists(partitionDirectory(directory, partition)) && await privateDirectoryExists(descriptorBase)) {
    const references = new Set((await segments(directory, partition)).flatMap((segment) => segment.events.map((event) => event.descriptor_id)));
    for (const name of await privateEntries(descriptorBase)) {
      if (TEMPORARY.test(name) || (UUID_FILE.test(name) && !references.has(name.slice(0, -5)))) await removePrivateTree(join(descriptorBase, name));
    }
  }
  for (const object of await objects(directory, partition)) {
    if (Date.parse(object.meta.expires_at) <= now) await removePrivateTree(object.path);
  }
  // Temporary writes are never referenced before their atomic rename. The root lock excludes live staging.
  for (const base of [partitionDirectory(directory, partition), join(partitionDirectory(directory, partition), "segments"), ...KINDS.map((kind) => managedDirectory(directory, kind, partition))]) {
    if (!await privateDirectoryExists(base)) continue;
    for (const name of await privateEntries(base)) if (TEMPORARY.test(name)) await removePrivateTree(join(base, name));
  }
  if (health.incomplete || health.malformed) {
    const base = partitionDirectory(directory, partition);
    await privateMkdir(base);
    const path = join(base, "health.json");
    let previous = { incomplete: 0, malformed: 0 };
    if (await privateExists(path)) previous = await privateJson(path);
    await atomicPrivateWrite(path, JSON.stringify({ incomplete: Math.min(0x7fffffff, (previous.incomplete || 0) + health.incomplete), malformed: Math.min(0x7fffffff, (previous.malformed || 0) + health.malformed) }));
  }
  await privateMkdir(join(directory.path, "control", "maintenance"));
  await atomicPrivateWrite(join(directory.path, "control", "maintenance", `${partition}.json`), JSON.stringify({ version: 1, swept_at: new Date(now).toISOString() }));
  return health;
}
async function statusIn(directory: PrivateDirectory, policy: DiagnosticPolicy | undefined, root: string): Promise<DiagnosticStatus> {
  let health = { incomplete: 0, malformed: 0 };
  if (policy && await privateDirectoryExists(join(directory.path, "partitions")) && await privateDirectoryExists(partitionDirectory(directory, policy.partition_id))) {
    const path = join(partitionDirectory(directory, policy.partition_id), "health.json");
    if (await privateExists(path)) {
      const data = await privateJson<typeof health>(path);
      if (Object.keys(data).length !== 2 || !Number.isSafeInteger(data.incomplete) || !Number.isSafeInteger(data.malformed)
        || data.incomplete < 0 || data.malformed < 0 || data.incomplete > 0x7fffffff || data.malformed > 0x7fffffff) throw new DiagnosticError("invalid");
      health = { incomplete: data.incomplete, malformed: data.malformed };
    }
  }
  return { enabled: policy?.enabled ?? false, paused: policy?.paused ?? false, generation: policy?.generation ?? 0,
    source_id: policy?.source_id, partition_id: policy?.partition_id, root, detail_allowed: policy?.detail_allowed ?? false, health, limits: DIAGNOSTIC_LIMITS };
}

export class DiagnosticStore {
  readonly root: string;
  constructor(root?: string, readonly partitionId?: string) {
    this.root = diagnosticRoot(root);
    if (partitionId !== undefined) validId(partitionId);
  }
  async status(): Promise<DiagnosticStatus> {
    return diagnosticGuard(async () => {
      try { return await withDiagnosticDirectory(this.root, false, async (directory) => statusIn(directory, await readPolicy(directory, this.partitionId), this.root)); }
      catch (error) {
        if (!isMissing(error)) throw error;
        return { enabled: false, paused: false, generation: 0, root: this.root, detail_allowed: false, health: { incomplete: 0, malformed: 0 }, limits: DIAGNOSTIC_LIMITS };
      }
    });
  }
  /** Explicit control inspection; producer admission uses the lightweight status() above. */
  async inspect(): Promise<DiagnosticInspection> {
    const inspection: DiagnosticInspection = {
      ...await this.status(), scope: "tc-apps",
      policy: { capture: "metadata_only", metadata_retention_ms: METADATA_RETENTION_MS, selected_detail_retention_ms: DETAIL_RETENTION_MS, external_copies: "not_managed" },
      usage: { partition_bytes: 0, detail_bytes: 0, controlled_copies_included: true, partition_limit_includes_detail: true },
      provenance: [], provenance_scope: "local_source_descriptors",
      coverage: { complete_history: "not_guaranteed", task_acceptance: "requires_selected_evidence", gaps: ["coverage_unknown"] },
      adapters: { baseline: ["explicit_launcher", "owner_linkage"], client_installations: "not_inspected" },
    };
    if (!inspection.partition_id) return inspection;
    return diagnosticGuard(() => withDiagnosticDirectory(this.root, false, (directory) => withDiagnosticLock(directory, async () => {
      const policy = await readPolicy(directory, this.partitionId);
      if (!policy) throw new DiagnosticError("generation");
      await maintainPartition(directory, policy.partition_id, Date.now());
      const status = await statusIn(directory, policy, this.root);
      const usage = await measure(directory, policy.partition_id);
      const provenance: DiagnosticDescriptor[] = [];
      const gaps: DiagnosticGap[] = [];
      const base = join(partitionDirectory(directory, policy.partition_id), "descriptors");
      if (await privateDirectoryExists(base)) for (const file of await privateEntries(base)) {
        if (TEMPORARY.test(file)) continue;
        if (!UUID_FILE.test(file)) throw new DiagnosticError("unsafe_path");
        const descriptor = validateDiagnosticDescriptor(await privateJson(join(base, file), DIAGNOSTIC_LIMITS.event_bytes));
        if (descriptor && `${descriptor.descriptor_id}.json` === file) provenance.push(descriptor);
        else if (!gaps.includes("descriptor_missing")) gaps.push("descriptor_missing");
      }
      if (status.health.incomplete) gaps.push("incomplete_tail");
      if (status.health.malformed) gaps.push("dropped_events");
      return { ...inspection, ...status, provenance,
        usage: { ...inspection.usage, partition_bytes: usage.metadata, detail_bytes: usage.detail, root_bytes: usage.root },
        coverage: { ...inspection.coverage, gaps },
      };
    })));
  }
  async control(action: "enable" | "pause" | "resume" | "disable", options: { scope?: "tc-apps"; detail_policy?: "encrypted-excluded-backups" } = {}): Promise<DiagnosticStatus> {
    return diagnosticGuard(async () => {
      if (!["enable", "pause", "resume", "disable"].includes(action) || (action === "enable" && options.scope !== "tc-apps")
        || (options.detail_policy !== undefined && options.detail_policy !== "encrypted-excluded-backups")) throw new DiagnosticError("invalid");
      if (action !== "enable" && !(await this.status()).partition_id) return this.status();
      return withDiagnosticDirectory(this.root, action === "enable", (directory) => withDiagnosticLock(directory, async () => {
        await initializeControl(directory);
        let policy = await readPolicy(directory, this.partitionId);
        if (!policy) {
          if (this.partitionId || action !== "enable") throw new DiagnosticError("missing");
          policy = await newPolicy(directory, true);
        }
        if (policy.generation === Number.MAX_SAFE_INTEGER) throw new DiagnosticError("quota");
        policy.generation++;
        if (action === "enable") { policy.enabled = true; policy.paused = false; }
        if (action === "pause") policy.paused = true;
        if (action === "resume") { if (!policy.enabled) throw new DiagnosticError("disabled"); policy.paused = false; }
        if (action === "disable") { policy.enabled = false; policy.paused = false; }
        if (options.detail_policy) policy.detail_allowed = true;
        // Publish cutoff before maintenance; a cleanup error must not undo pause/disable.
        await savePolicy(directory, policy);
        await maintainPartition(directory, policy.partition_id, Date.now());
        return statusIn(directory, policy, this.root);
      }));
    });
  }
  async snapshot(selection: DiagnosticSelection): Promise<DiagnosticSnapshot> {
    return diagnosticGuard(async () => {
      selection = validSelection(selection);
      try {
        return await withDiagnosticDirectory<DiagnosticSnapshot>(this.root, false, (directory) => withDiagnosticLock(directory, async () => {
          const policy = await readPolicy(directory, this.partitionId);
          if (!policy) return { events: [], descriptors: [], gaps: ["coverage_unknown"], conflicts: [] };
          await maintainPartition(directory, policy.partition_id, Date.now());
          const events = new Map<string, DiagnosticEvent>(); const conflicts = new Set<string>();
          const descriptors = new Map<string, DiagnosticDescriptor>(); const gaps = new Set<DiagnosticGap>();
          const assertions: { source_ids: readonly string[]; expires_at: string }[] = [];
          const descriptorConflicts = new Set<string>();
          function mergeDescriptor(descriptor: DiagnosticDescriptor): void {
            const id = descriptor.descriptor_id;
            if (descriptorConflicts.has(id)) return;
            const previous = descriptors.get(id);
            if (previous && !diagnosticMetadataEqual(previous, descriptor)) {
              descriptorConflicts.add(id); descriptors.delete(id); gaps.add("descriptor_missing"); gaps.add("conflict");
            } else descriptors.set(id, descriptor);
          }
          function merge(event: DiagnosticEvent): void {
            if (!diagnosticEventSelected(event, selection) || Date.parse(event.occurred_at) + METADATA_RETENTION_MS <= Date.now()) return;
            const key = `${event.source_id}/${event.event_id}`;
            const previous = events.get(key);
            if (previous && !diagnosticMetadataEqual(previous, event)) { conflicts.add(key); events.delete(key); }
            else if (!conflicts.has(key)) events.set(key, event);
          }
          for (const segment of await segments(directory, policy.partition_id)) for (const event of segment.events) merge(event);
          const descriptorPath = join(partitionDirectory(directory, policy.partition_id), "descriptors");
          if (await privateDirectoryExists(descriptorPath)) for (const file of await privateEntries(descriptorPath)) {
            if (!UUID_FILE.test(file)) { if (TEMPORARY.test(file)) continue; throw new DiagnosticError("unsafe_path"); }
            const descriptor = validateDiagnosticDescriptor(await privateJson(join(descriptorPath, file)));
            if (descriptor) mergeDescriptor(descriptor); else gaps.add("descriptor_missing");
          }
          const imported = await objects(directory, policy.partition_id, "imports");
          for (const object of imported) {
            const decoded = decodeDiagnosticBundle((await readObject(object)).files);
            const selectedEvents = decoded.snapshot.events.filter((event) => diagnosticEventSelected(event, selection));
            const selectedConflicts = decoded.snapshot.conflicts.filter((key) => diagnosticConflictSelected(key, selection));
            const sources = decoded.manifest.source_ids.filter((id) => !selection.source_ids || selection.source_ids.includes(id));
            const sourceAssertionSelected = !selection.event_ids && !selection.invocation_ids && !selection.from && !selection.until
              && (!selection.case_ids || selection.all || selection.source_ids)
              && (sources.length > 0 || (!decoded.manifest.source_ids.length && !selection.source_ids && selection.all === true));
            if (!selectedEvents.length && !selectedConflicts.length && !sourceAssertionSelected) continue;
            assertions.push({ source_ids: sourceAssertionSelected ? sources : [...new Set([...selectedEvents.map((event) => event.source_id), ...selectedConflicts.map((key) => key.split("/")[0]!)])], expires_at: decoded.manifest.expires_at });
            gaps.add("import_untrusted");
            for (const key of selectedConflicts) conflicts.add(key);
            for (const gap of decoded.snapshot.gaps) {
              if (gap !== "conflict" || selectedConflicts.length || !decoded.snapshot.conflicts.length) gaps.add(gap);
            }
            for (const descriptor of decoded.snapshot.descriptors) mergeDescriptor(descriptor);
            for (const event of selectedEvents) merge(event);
          }
          for (const key of events.keys()) if (conflicts.has(key)) events.delete(key);
          const selected = [...events.values()];
          const required = new Set(selected.map((event) => event.descriptor_id).filter(Boolean));
          for (const id of required) if (!descriptors.has(id!)) gaps.add("descriptor_missing");
          if (conflicts.size) gaps.add("conflict");
          const health = (await statusIn(directory, policy, this.root)).health;
          if (health.incomplete) gaps.add("incomplete_tail");
          if (health.malformed) gaps.add("dropped_events");
          return { events: selected, descriptors: [...descriptors.values()].filter((descriptor) => required.has(descriptor.descriptor_id)), gaps: [...gaps], conflicts: [...conflicts], assertions };
        }));
      } catch (error) { if (isMissing(error)) return { events: [], descriptors: [], gaps: ["coverage_unknown"], conflicts: [] }; throw error; }
    });
  }
  async delete(selection: DiagnosticSelection, options: { pause_after?: boolean } = {}): Promise<DeletionReport> {
    let cutoff = false;
    return diagnosticGuard(async () => {
      selection = validSelection(selection);
      if (selection.all && typeof options.pause_after !== "boolean") throw new DiagnosticError("invalid");
      const wholePartition = selection.all === true && !selection.source_ids && !selection.event_ids && !selection.invocation_ids && !selection.from && !selection.until;
      const empty = { events: 0, objects: 0, descriptors: 0, complete: true, paused: false, enabled: false, generation: 0, limitations: ["external_copies_not_recalled", "backups_not_erased"] };
      if (!(await this.status()).partition_id) return empty;
      return withDiagnosticDirectory(this.root, false, (directory) => withDiagnosticLock(directory, async () => {
        const policy = await readPolicy(directory, this.partitionId);
        if (!policy) return empty;
        const wasPaused = policy.paused;
        if (policy.generation >= Number.MAX_SAFE_INTEGER - 1) throw new DiagnosticError("quota");
        policy.generation++; policy.paused = true;
        cutoff = true;
        await savePolicy(directory, policy);
        await maintainPartition(directory, policy.partition_id, Date.now());
        const report: DeletionReport = { ...empty, paused: true, enabled: policy.enabled, generation: policy.generation };
        const deletedKeys = new Set<string>();
        for (const segment of await segments(directory, policy.partition_id)) {
          const kept = segment.events.filter((event) => {
            if (!diagnosticEventSelected(event, selection)) return true;
            deletedKeys.add(`${event.source_id}/${event.event_id}`); return false;
          });
          if (kept.length !== segment.events.length || segment.incomplete || segment.malformed) await rewrite(directory, policy.partition_id, segment, kept);
        }
        const managed = await objects(directory, policy.partition_id);
        const matchingObjects = new Set<string>();
        for (const object of managed) {
          if (object.kind === "cases") continue;
          const data = (await readObject(object)).files["events.jsonl"];
          if (!data) continue;
          for (const line of Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8").split("\n")) {
            if (!line) continue;
            let event: DiagnosticEvent | undefined;
            try { event = validateDiagnosticEvent(JSON.parse(line)); } catch { throw new DiagnosticError("invalid"); }
            if (!event) throw new DiagnosticError("invalid");
            if (diagnosticEventSelected(event, selection)) {
              matchingObjects.add(`${object.kind}/${object.id}`);
              deletedKeys.add(`${event.source_id}/${event.event_id}`);
            }
          }
        }
        report.events = deletedKeys.size;
        for (const object of managed) {
          const sourceSelected = !selection.source_ids || object.meta.source_ids.some((id) => selection.source_ids!.includes(id));
          const unqualifiedIds = !selection.from && !selection.until && !selection.invocation_ids;
          const applies = wholePartition || selection.case_ids?.includes(object.id) === true
            || object.meta.case_ids?.some((id) => selection.case_ids?.includes(id)) === true
            || matchingObjects.has(`${object.kind}/${object.id}`)
            || (sourceSelected && object.meta.event_ids.some((id) => object.meta.source_ids.some((source) => deletedKeys.has(`${source}/${id}`)) || (unqualifiedIds && selection.event_ids?.includes(id))))
            || (sourceSelected && selection.source_ids !== undefined && unqualifiedIds && !selection.event_ids);
          if (applies) {
            const rewritten = object.kind === "cases" || wholePartition ? undefined : rewriteDiagnosticBundle((await readObject(object)).files, selection, [...deletedKeys]);
            if (rewritten) {
              const prepared = prepareFiles(rewritten.files, rewritten.meta);
              const metadata = JSON.stringify(prepared.meta);
              reserve(await measure(directory, policy.partition_id), prepared.meta.metadata_bytes! + Buffer.byteLength(metadata), prepared.meta.detail_bytes!);
              await replacePrivateDirectory(object.path, prepared.files, metadata, Date.parse(prepared.meta.expires_at));
            } else await removePrivateTree(object.path);
            report.objects++;
          }
        }
        if (wholePartition) {
          const descriptors = join(partitionDirectory(directory, policy.partition_id), "descriptors");
          if (await privateDirectoryExists(descriptors)) { report.descriptors = (await privateEntries(descriptors)).length; await removePrivateTree(descriptors); }
        }
        await maintainPartition(directory, policy.partition_id, Date.now());
        policy.paused = options.pause_after ?? wasPaused;
        await savePolicy(directory, policy);
        report.paused = policy.paused;
        return report;
      }));
    }).catch((error) => {
      if (cutoff) throw new DiagnosticDeletionError(diagnosticFailure(error));
      throw error;
    });
  }
  async putManaged(kind: ManagedKind, id: string, files: Readonly<Record<string, string | Uint8Array>>, meta: ManagedObjectMetadata, options: { generation?: number } = {}): Promise<string> {
    return diagnosticGuard(async () => {
      validKind(kind); validId(id); meta = objectMetadata(meta);
      const prepared = prepareFiles(files, meta);
      const before = await this.status();
      const expected = options.generation ?? before.generation;
      if (!Number.isSafeInteger(expected) || expected < 0) throw new DiagnosticError("invalid");
      if (kind !== "cases") {
        const bytes = Object.fromEntries(Object.entries(prepared.files).map(([name, value]) => [name, typeof value === "string" ? Buffer.from(value) : value]));
        decodeDiagnosticBundle(bytes);
      }
      return withDiagnosticDirectory(this.root, true, (directory) => withDiagnosticLock(directory, async () => {
        await initializeControl(directory);
        let policy = await readPolicy(directory, this.partitionId);
        if ((policy?.generation ?? 0) !== expected) throw new DiagnosticError("generation");
        if (!policy && !this.partitionId) policy = await newPolicy(directory, true);
        if (!policy) throw new DiagnosticError("missing");
        if (meta.detail && !policy.detail_allowed) throw new DiagnosticError("permission");
        await maintainPartition(directory, policy.partition_id, Date.now());
        await privateMkdir(join(directory.path, kind));
        const base = managedDirectory(directory, kind, policy.partition_id);
        await privateMkdir(base);
        if ((await privateEntries(base)).length >= DIAGNOSTIC_LIMITS.objects) throw new DiagnosticError("quota");
        const metadata = JSON.stringify(prepared.meta);
        reserve(await measure(directory, policy.partition_id), prepared.meta.metadata_bytes! + Buffer.byteLength(metadata), prepared.meta.detail_bytes!);
        await writePrivateDirectory(join(base, id), prepared.files, metadata, Date.parse(prepared.meta.expires_at));
        return join(this.root, kind, policy.partition_id, id, "bundle");
      }));
    });
  }
  async readManaged(kind: ManagedKind, id: string): Promise<{ files: Record<string, Uint8Array>; meta: ManagedObjectMetadata }> {
    return diagnosticGuard(async () => {
      validKind(kind); validId(id);
      return withDiagnosticDirectory(this.root, false, (directory) => withDiagnosticLock(directory, async () => {
        const policy = await readPolicy(directory, this.partitionId);
        if (!policy) throw new DiagnosticError("missing");
        await maintainPartition(directory, policy.partition_id, Date.now());
        const object = (await objects(directory, policy.partition_id, kind)).find((object) => object.id === id);
        if (!object) throw new DiagnosticError("missing");
        return readObject(object);
      }));
    });
  }
  async listManaged(kind: ManagedKind): Promise<readonly { id: string; meta: ManagedObjectMetadata }[]> {
    return diagnosticGuard(async () => {
      validKind(kind);
      try { return await withDiagnosticDirectory(this.root, false, (directory) => withDiagnosticLock(directory, async () => {
        const policy = await readPolicy(directory, this.partitionId);
        if (!policy) return [];
        await maintainPartition(directory, policy.partition_id, Date.now());
        return (await objects(directory, policy.partition_id, kind)).map(({ id, meta }) => ({ id, meta }));
      })); } catch (error) { if (isMissing(error)) return []; throw error; }
    });
  }
  async removeManaged(kind: ManagedKind, id: string): Promise<void> {
    await diagnosticGuard(async () => {
      validKind(kind); validId(id);
      await withDiagnosticDirectory(this.root, false, (directory) => withDiagnosticLock(directory, async () => {
        const policy = await readPolicy(directory, this.partitionId);
        if (!policy) return;
        await maintainPartition(directory, policy.partition_id, Date.now());
        const path = join(managedDirectory(directory, kind, policy.partition_id), id);
        if (await privateDirectoryExists(path)) await removePrivateTree(path);
      }));
    });
  }
}

interface AppendPartition {
  base: string;
  ready: boolean;
  names?: string[];
  sizes: Map<string, number>;
  descriptors: Set<string>;
  descriptorDirectory: boolean;
}
interface AppendBatchState {
  partitionIds: Set<string>;
  policies: Map<string, DiagnosticPolicy | undefined>;
  partitions: Map<string, AppendPartition>;
  usage?: Map<string, Usage>;
  partitionsReady?: boolean;
}
function invalidateAppend(state: AppendBatchState, partition: AppendPartition): void {
  // Maintenance and failed writes can change more than the selected segment, including control bytes.
  state.usage = undefined;
  partition.names = undefined;
  partition.sizes.clear();
  partition.descriptors.clear();
}
async function prepareBatchMaintenance(directory: PrivateDirectory, state: AppendBatchState, partition: AppendPartition, id: string, generation: number, force = false): Promise<void> {
  try {
    if (await prepareAppendMaintenance(directory, id, generation, force)) invalidateAppend(state, partition);
  } catch (error) { invalidateAppend(state, partition); throw error; }
}
async function reserveAppend(directory: PrivateDirectory, state: AppendBatchState, partition: string, bytes: number): Promise<void> {
  state.usage ??= await measurePartitions(directory, state.partitionIds);
  const usage = state.usage.get(partition)!;
  reserve(usage, bytes);
  // Charge before I/O. On any failure the next admission remeasures partial or complete writes.
  usage.metadata += bytes;
  for (const measured of state.usage.values()) measured.root += bytes;
}
async function appendLocked(directory: PrivateDirectory, state: AppendBatchState, event: DiagnosticEvent, generation: number, encoded: string, descriptor?: DiagnosticDescriptor): Promise<void> {
  if (!state.policies.has(event.partition_id)) state.policies.set(event.partition_id, await readPolicy(directory, event.partition_id));
  const policy = state.policies.get(event.partition_id);
  if (!policy?.enabled || policy.paused) throw new DiagnosticError("disabled");
  if (policy.generation !== generation || policy.source_id !== event.source_id) throw new DiagnosticError("generation");
  if (Date.parse(event.occurred_at) + METADATA_RETENTION_MS <= Date.now()) throw new DiagnosticError("expired");
  const partition: AppendPartition = state.partitions.get(event.partition_id) ?? {
    base: partitionDirectory(directory, event.partition_id), ready: false, sizes: new Map(), descriptors: new Set(), descriptorDirectory: false,
  };
  state.partitions.set(event.partition_id, partition);
  try {
    if (!partition.ready) {
      await prepareBatchMaintenance(directory, state, partition, event.partition_id, generation);
      if (!state.partitionsReady) { await privateMkdir(join(directory.path, "partitions")); state.partitionsReady = true; }
      await privateMkdir(partition.base); await privateMkdir(join(partition.base, "segments"));
      partition.ready = true;
    }
    const base = join(partition.base, "segments");
    const line = encoded + "\n";
    const lineBytes = Buffer.byteLength(line);
    let list = partition.names ??= await privateEntries(base);
    const prefix = `${event.process_id}-${generation}-`;
    let name = await availableSegment(base, list, partition.sizes, prefix, lineBytes);
    if (!name && list.some((candidate) => candidate.startsWith(prefix))) {
      // Rotation is a maintenance boundary; ordinary appends never parse historical event content.
      await prepareBatchMaintenance(directory, state, partition, event.partition_id, generation, true);
      list = partition.names ??= await privateEntries(base);
      name = await availableSegment(base, list, partition.sizes, prefix, lineBytes);
    }
    if (!name) {
      if (list.length >= DIAGNOSTIC_LIMITS.objects) throw new DiagnosticError("quota");
      for (const previous of list) if (previous.startsWith(prefix) && SEGMENT_FILE.test(previous)) await syncPrivateFile(join(base, previous));
      name = `${prefix}${diagnosticId()}.jsonl`;
    }
    const persistDescriptor = async () => {
      if (!descriptor) return;
      const valid = validateDiagnosticDescriptor(descriptor);
      if (!valid || event.descriptor_id !== valid.descriptor_id) throw new DiagnosticError("invalid");
      if (partition.descriptors.has(valid.descriptor_id)) return;
      if (!partition.descriptorDirectory) { await privateMkdir(join(partition.base, "descriptors")); partition.descriptorDirectory = true; }
      const path = join(partition.base, "descriptors", `${valid.descriptor_id}.json`);
      if (!await privateExists(path)) {
        const bytes = JSON.stringify(valid);
        await reserveAppend(directory, state, event.partition_id, Buffer.byteLength(bytes));
        await atomicPrivateWrite(path, bytes);
      }
      partition.descriptors.add(valid.descriptor_id);
    };
    await persistDescriptor();
    await reserveAppend(directory, state, event.partition_id, lineBytes);
    const path = join(base, name);
    try { await privateAppend(path, line); }
    catch (error) {
      if (!(error instanceof DiagnosticError) || error.code !== "invalid") throw error;
      // A prior failed append can leave a partial line. Repair before reusing that producer's segment.
      await prepareBatchMaintenance(directory, state, partition, event.partition_id, generation, true);
      list = partition.names ??= await privateEntries(base);
      if (list.includes(name)) partition.sizes.set(name, (await privateStat(path)).size);
      await persistDescriptor();
      await reserveAppend(directory, state, event.partition_id, lineBytes);
      await privateAppend(path, line);
    }
    partition.sizes.set(name, (partition.sizes.get(name) ?? 0) + lineBytes);
    if (!list.includes(name)) { list.push(name); list.sort(); }
  } catch (error) {
    // Never reuse a quota or segment estimate after an uncertain partial write.
    invalidateAppend(state, partition);
    throw error;
  }
}
/** Single-write control/test boundary; returns only after the root lock has been released. */
export async function appendDiagnosticEvent(root: string, event: DiagnosticEvent, generation: number, descriptor?: DiagnosticDescriptor): Promise<void> {
  const encoded = encodeDiagnosticEvent(event);
  if (!encoded) throw new DiagnosticError("invalid");
  await withDiagnosticDirectory(root, false, (directory) => withDiagnosticLock(directory, () => appendLocked(directory,
    { partitionIds: new Set([event.partition_id]), policies: new Map(), partitions: new Map() }, event, generation, encoded, descriptor)));
}
export interface DiagnosticWrite { event: DiagnosticEvent; generation: number; descriptor?: DiagnosticDescriptor }
/** One bounded worker batch, one root lock. Per-line results are published only after its release. */
export async function appendDiagnosticBatch(root: string, batch: readonly DiagnosticWrite[]): Promise<readonly (DiagnosticFailure | undefined)[]> {
  if (batch.length > DIAGNOSTIC_LIMITS.queue_events) throw new DiagnosticError("quota");
  const encoded: (string | undefined)[] = [];
  const partitionIds = new Set<string>();
  let bytes = 0;
  for (const item of batch) {
    const line = encodeDiagnosticEvent(item.event);
    encoded.push(line);
    if (line) { bytes += Buffer.byteLength(line) + 1; partitionIds.add(item.event.partition_id); }
  }
  if (bytes > DIAGNOSTIC_LIMITS.queue_bytes) throw new DiagnosticError("quota");
  return withDiagnosticDirectory(root, false, (directory) => withDiagnosticLock(directory, async () => {
    const results: (DiagnosticFailure | undefined)[] = [];
    const state: AppendBatchState = { partitionIds, policies: new Map(), partitions: new Map() };
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index]; const line = encoded[index];
      if (!line) { results.push("invalid"); continue; }
      try { await appendLocked(directory, state, item.event, item.generation, line, item.descriptor); results.push(undefined); }
      catch (error) { results.push(diagnosticFailure(error)); }
    }
    return results;
  }));
}
/** Bounded idle-tenant sweep; worker cycles a fixed number of partitions per tick. */
export async function sweepDiagnosticRoot(root: string, cursor = 0, count = 8): Promise<{ cursor: number; failure?: DiagnosticFailure }> {
  return withDiagnosticDirectory(root, false, (directory) => withDiagnosticLock(directory, async () => {
    const base = join(directory.path, "control", "partitions");
    if (!await privateDirectoryExists(join(directory.path, "control")) || !await privateDirectoryExists(base)) return { cursor: 0 };
    const files = (await privateEntries(base, DIAGNOSTIC_LIMITS.partitions)).filter((file) => UUID_FILE.test(file));
    let failure: DiagnosticFailure | undefined;
    for (let index = cursor; index < Math.min(files.length, cursor + count); index++) {
      try { await maintainPartition(directory, files[index].slice(0, -5), Date.now()); }
      catch (error) { failure = diagnosticFailure(error); }
    }
    return { cursor: cursor + count >= files.length ? 0 : cursor + count, failure };
  }));
}
export async function writeDiagnosticDirectory(root: string, destination: string, files: Readonly<Record<string, string | Uint8Array>>, options: {
  external: boolean; expires_at: string; selection: DiagnosticSelection; detail: boolean; partition_id?: string; generation?: number;
}): Promise<{ path: string; managed: boolean; limitations: string[] }> {
  return diagnosticGuard(async () => {
    root = diagnosticRoot(root); destination = absolutePath(destination);
    const selection = validSelection(options.selection);
    const store = new DiagnosticStore(root, options.partition_id);
    const status = await store.status();
    if (!status.partition_id) throw new DiagnosticError("missing");
    const expected = options.generation ?? status.generation;
    if (!Number.isSafeInteger(expected) || expected < 0 || status.generation !== expected) throw new DiagnosticError("generation");
    const meta = objectMetadata({ expires_at: options.expires_at, source_ids: [...(selection.source_ids ?? [])], event_ids: [...(selection.event_ids ?? [])],
      case_ids: [...(selection.case_ids ?? [])], detail: options.detail });
    const prepared = prepareFiles(files, meta);
    const decoded = decodeDiagnosticBundle(Object.fromEntries(Object.entries(prepared.files).map(([name, value]) => [name, typeof value === "string" ? Buffer.from(value) : value])));
    if (decoded.manifest.expires_at !== options.expires_at || decoded.snapshot.events.some((event) => !diagnosticEventSelected(event, selection))
      || (!options.detail && decoded.cases.length !== 0)) throw new DiagnosticError("invalid");
    // Selection IDs are predicates, not attribution. Keep every retained assertion
    // indexed even when deduplication leaves only conflicts or gaps in the bundle.
    prepared.meta = objectMetadata({ ...prepared.meta, source_ids: decoded.manifest.source_ids,
      event_ids: [...new Set([...decoded.snapshot.events.map((event) => event.event_id), ...decoded.snapshot.conflicts.map((key) => key.split("/")[1]!)])] });
    if (!options.external) {
      const id = basename(destination); validId(id);
      if (dirname(destination) !== join(root, "exports") && dirname(destination) !== join(root, "exports", status.partition_id)) throw new DiagnosticError("unsafe_path");
      return { path: await store.putManaged("exports", id, prepared.files, prepared.meta, { generation: expected }), managed: true, limitations: [] };
    }
    if (inside(root, destination) || inside(destination, root)) throw new DiagnosticError("unsafe_path");
    if (options.detail && !status.detail_allowed) throw new DiagnosticError("permission");
    // Hold generation lock through external handoff. The external copy is deliberately not charged or recalled.
    await withDiagnosticDirectory(root, false, (directory) => withDiagnosticLock(directory, async () => {
      const policy = await readPolicy(directory, status.partition_id);
      if (!policy || policy.generation !== expected) throw new DiagnosticError("generation");
      await maintainPartition(directory, policy.partition_id, Date.now());
      await withPrivateDirectory(dirname(destination), false, async (parent) => {
        await writePrivateDirectory(join(parent.path, basename(destination)), prepared.files, undefined, Date.parse(prepared.meta.expires_at));
        await parent.assertStable();
      });
    }));
    return { path: destination, managed: false, limitations: ["external_quota_not_enforced", "external_expiry_not_enforced", "external_copies_not_recalled"] };
  });
}
