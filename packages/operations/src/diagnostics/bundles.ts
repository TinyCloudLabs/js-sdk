import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { DIAGNOSTIC_GAPS, METADATA_RETENTION_MS, diagnosticConflictSelected, diagnosticEventSelected, diagnosticMetadataEqual, encodeDiagnosticEvent, validateDiagnosticDescriptor, validateDiagnosticEvent, validateDiagnosticSelection, type DiagnosticDescriptor, type DiagnosticGap, type DiagnosticSelection, type DiagnosticSnapshot } from "./model.js";
import { writeDiagnosticDirectory, type DiagnosticStore, type ManagedObjectMetadata } from "./storage.js";
import { DETAIL_LIMIT, DiagnosticInputError, assertDiagnosticInputPath, fail, ids, keys, object, oneOf, parseDiagnosticJson, unexpired, utc, uuid, validateSelectedDiagnosticCase, type SelectedDiagnosticCase } from "./selection.js";
import { REPRODUCTION_INSTRUCTIONS, REPRODUCTION_SCRIPT, validateDiagnosticFixture, type DiagnosticFixture } from "./reproduction.js";
import { DiagnosticError, privateRead, privateStat, withPrivateDirectory, type PrivateDirectory } from "./filesystem.js";

const BUNDLE_LIMIT = 32 * 1024 * 1024;
const EVENT_LIMIT = 4096;
const MANIFEST_LIMIT = 1024 * 1024;
const FILE_NAMES = ["manifest.json", "events.jsonl", "detail.json", "fixture.json", "reproduce.mjs", "instructions.txt"] as const;
type FileName = typeof FILE_NAMES[number];
export interface DiagnosticBundleManifest {
  format: "tinycloud-diagnostics";
  schema_version: 1;
  bundle_id: string;
  exported_at: string;
  expires_at: string;
  destination: "managed" | "external";
  trust: "source_observation" | "imported_assertion";
  integrity: "sha256-transfer-only-not-authenticity";
  content_tiers: ("metadata" | "selected_detail" | "synthetic_fixture")[];
  selection: DiagnosticSelection;
  source_ids: string[];
  partition_ids: string[];
  original_times: { first: string | null; last: string | null };
  descriptors: DiagnosticDescriptor[];
  gaps: DiagnosticGap[];
  conflicts: string[];
  files: Partial<Record<FileName, { bytes: number; sha256: string }>>;
}
export function diagnosticTransferChecksum(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function deduplicateDiagnosticSnapshot(snapshot: DiagnosticSnapshot): DiagnosticSnapshot {
  const seen = new Map<string, DiagnosticSnapshot["events"][number]>();
  const conflicts = new Set(snapshot.conflicts);
  for (const event of snapshot.events) {
    const key = `${event.source_id}/${event.event_id}`;
    if (!encodeDiagnosticEvent(event)) return fail();
    const previous = seen.get(key);
    if (previous && !diagnosticMetadataEqual(previous, event)) conflicts.add(key);
    else if (!previous) seen.set(key, event);
  }
  return { ...snapshot, events: [...seen.values()].filter((event) => !conflicts.has(`${event.source_id}/${event.event_id}`)), conflicts: [...conflicts], gaps: [...new Set<DiagnosticGap>([...snapshot.gaps, ...(conflicts.size ? ["conflict" as const] : [])])] };
}
function decodeEvents(bytes: Uint8Array, now: number): DiagnosticSnapshot["events"] {
  const events: DiagnosticSnapshot["events"] = [];
  let start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (end - start >= 4096) throw new DiagnosticInputError("input_limit");
    if (bytes[end] !== 10) continue;
    const event = validateDiagnosticEvent(parseDiagnosticJson(bytes.subarray(start, end)));
    if (!event || !encodeDiagnosticEvent(event)) return fail();
    const time = Date.parse(event.occurred_at);
    if (time > now || time + METADATA_RETENTION_MS <= now) throw new DiagnosticInputError("expired");
    events.push(event);
    if (events.length > EVENT_LIMIT) throw new DiagnosticInputError("input_limit");
    start = end + 1;
  }
  if (start !== bytes.length) return fail();
  return events;
}
/** Validate every file, not just a manifest checksum. Nothing in a bundle executes. */
export function decodeDiagnosticBundle(files: Readonly<Record<string, Uint8Array>>, now = Date.now()): { manifest: DiagnosticBundleManifest; snapshot: DiagnosticSnapshot; cases: SelectedDiagnosticCase[]; fixture?: DiagnosticFixture } {
  if (Object.keys(files).some((name) => !FILE_NAMES.includes(name as FileName)) || !files["manifest.json"] || !files["events.jsonl"]) return fail();
  if (Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0) > BUNDLE_LIMIT || files["manifest.json"].byteLength > MANIFEST_LIMIT) throw new DiagnosticInputError("input_limit");
  if (Object.entries(files).filter(([name]) => name !== "manifest.json" && name !== "events.jsonl").reduce((sum, [, bytes]) => sum + bytes.byteLength, 0) > DETAIL_LIMIT) throw new DiagnosticInputError("input_limit");
  const raw = object(parseDiagnosticJson(files["manifest.json"]));
  keys(raw, ["format", "schema_version", "bundle_id", "exported_at", "expires_at", "destination", "trust", "integrity", "content_tiers", "selection", "source_ids", "partition_ids", "original_times", "descriptors", "gaps", "conflicts", "files"]);
  if (raw.format !== "tinycloud-diagnostics" || raw.schema_version !== 1 || raw.integrity !== "sha256-transfer-only-not-authenticity") return fail();
  const exportedAt = utc(raw.exported_at), expiry = unexpired(raw.expires_at, now);
  if (Date.parse(exportedAt) > now || Date.parse(expiry) > Date.parse(exportedAt) + METADATA_RETENTION_MS) return fail();
  const selection = validateDiagnosticSelection(raw.selection);
  if (!selection || !Array.isArray(raw.descriptors) || raw.descriptors.length > 4096 || !Array.isArray(raw.gaps) || raw.gaps.length > DIAGNOSTIC_GAPS.length) return fail();
  const descriptors = raw.descriptors.map((value) => validateDiagnosticDescriptor(value) ?? fail());
  const gaps = raw.gaps.map((value) => oneOf(value, DIAGNOSTIC_GAPS));
  if (!Array.isArray(raw.content_tiers) || raw.content_tiers.length > 3) return fail();
  const tiers = raw.content_tiers.map((value) => oneOf(value, ["metadata", "selected_detail", "synthetic_fixture"] as const));
  if (!tiers.includes("metadata") || tiers.includes("selected_detail") !== Boolean(files["detail.json"]) || tiers.includes("synthetic_fixture") !== Boolean(files["fixture.json"])) return fail();
  const declarations = object(raw.files);
  keys(declarations, FILE_NAMES.filter((name) => name !== "manifest.json"));
  for (const name of FILE_NAMES.filter((name) => name !== "manifest.json")) {
    const bytes = files[name], declaration = declarations[name];
    if (!!bytes !== !!declaration) return fail();
    if (!bytes) continue;
    const entry = object(declaration); keys(entry, ["bytes", "sha256"]);
    if (entry.bytes !== bytes.byteLength || entry.sha256 !== diagnosticTransferChecksum(bytes)) throw new DiagnosticInputError("integrity_failure");
  }
  const events = decodeEvents(files["events.jsonl"], now);
  const sources = ids(raw.source_ids), partitions = ids(raw.partition_ids);
  if (!Array.isArray(raw.conflicts) || raw.conflicts.length > EVENT_LIMIT) return fail();
  const conflicts = raw.conflicts.map((value: unknown) => {
    if (typeof value !== "string") return fail();
    const parts = value.split("/");
    if (parts.length !== 2) return fail();
    const sourceId = uuid(parts[0]), eventId = uuid(parts[1]);
    if (!sources.includes(sourceId) || !diagnosticConflictSelected(value, { source_ids: selection.source_ids, event_ids: selection.event_ids })) return fail();
    return `${sourceId}/${eventId}`;
  });
  if (new Set(conflicts).size !== conflicts.length) return fail();
  const original = object(raw.original_times); keys(original, ["first", "last"]);
  const times = events.map((event) => event.occurred_at).sort();
  if (original.first !== (times[0] ?? null) || original.last !== (times.at(-1) ?? null)) return fail();
  if (events.some((event) => !sources.includes(event.source_id) || !partitions.includes(event.partition_id) || Date.parse(expiry) > Date.parse(event.occurred_at) + METADATA_RETENTION_MS || !diagnosticEventSelected(event, selection))) return fail();
  let cases: SelectedDiagnosticCase[] = [];
  if (files["detail.json"]) {
    if (files["detail.json"].byteLength > DETAIL_LIMIT) throw new DiagnosticInputError("input_limit");
    const detail = object(parseDiagnosticJson(files["detail.json"])); keys(detail, ["schema_version", "cases"]);
    if (detail.schema_version !== 1 || !Array.isArray(detail.cases) || detail.cases.length > 64 || selection.include_detail !== true) return fail();
    cases = detail.cases.map((value) => validateSelectedDiagnosticCase(value, now));
    if (cases.some((item) => Date.parse(expiry) > Date.parse(item.expires_at) || !selection.case_ids?.includes(item.case_id) || item.event_ids.some((id) => !events.some((event) => event.event_id === id && item.source_ids.includes(event.source_id))))) return fail();
  }
  let fixture: DiagnosticFixture | undefined;
  if (files["fixture.json"]) {
    if (files["fixture.json"].byteLength > DETAIL_LIMIT) throw new DiagnosticInputError("input_limit");
    fixture = validateDiagnosticFixture(parseDiagnosticJson(files["fixture.json"]));
    if (!cases.length || !files["reproduce.mjs"] || !files["instructions.txt"] || Buffer.from(files["reproduce.mjs"]).toString("utf8") !== REPRODUCTION_SCRIPT || Buffer.from(files["instructions.txt"]).toString("utf8") !== REPRODUCTION_INSTRUCTIONS) return fail();
  } else if (files["reproduce.mjs"] || files["instructions.txt"]) return fail();
  const manifest: DiagnosticBundleManifest = { format: "tinycloud-diagnostics", schema_version: 1, bundle_id: uuid(raw.bundle_id), exported_at: exportedAt, expires_at: expiry, destination: oneOf(raw.destination, ["managed", "external"]), trust: oneOf(raw.trust, ["source_observation", "imported_assertion"]), integrity: "sha256-transfer-only-not-authenticity", content_tiers: tiers, selection, source_ids: sources, partition_ids: partitions, original_times: { first: times[0] ?? null, last: times.at(-1) ?? null }, descriptors, gaps, conflicts, files: declarations as DiagnosticBundleManifest["files"] };
  return { manifest, snapshot: deduplicateDiagnosticSnapshot({ events, descriptors, gaps, conflicts: manifest.conflicts }), cases, fixture };
}

async function readBundleDirectory(directory: string): Promise<Record<string, Uint8Array>> {
  const full = assertDiagnosticInputPath(directory);
  try {
    return await withPrivateDirectory(full, false, async (held) => {
      const files = await readPinnedBundleDirectory(held);
      await held.assertStable();
      return files;
    });
  } catch (error) {
    if (error instanceof DiagnosticInputError) throw error;
    throw new DiagnosticInputError(error instanceof DiagnosticError && error.code === "quota" ? "input_limit" : "unsafe_path");
  }
}
async function readPinnedBundleDirectory(directory: PrivateDirectory): Promise<Record<string, Uint8Array>> {
  const full = directory.path;
  const entries: Dirent[] = [];
  const directoryHandle = await opendir(full).catch(() => { throw new DiagnosticInputError("unsafe_path"); });
  for await (const entry of directoryHandle) {
    if (entries.length >= FILE_NAMES.length || !entry.isFile() || !FILE_NAMES.includes(entry.name as FileName)) throw new DiagnosticInputError("unsafe_path");
    entries.push(entry);
  }
  let total = 0;
  for (const entry of entries) {
    const file = await privateStat(join(full, entry.name));
    total += file.size;
    if (!file.isFile() || file.nlink !== 1 || total > BUNDLE_LIMIT) throw new DiagnosticInputError("input_limit");
  }
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (entry.name !== "events.jsonl") {
      files[entry.name] = await privateRead(join(full, entry.name), entry.name === "manifest.json" ? MANIFEST_LIMIT : DETAIL_LIMIT);
      continue;
    }
    // Stream before acceptance: a growing input or a single enormous line cannot allocate beyond the bound.
    const before = await privateStat(join(full, entry.name));
    const handle = await open(join(full, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new DiagnosticInputError("unsafe_path"); });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > BUNDLE_LIMIT || info.ino !== before.ino || info.dev !== before.dev || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new DiagnosticInputError("unsafe_path");
      const chunks: Buffer[] = [];
      let count = 0, line = 0, events = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(16384);
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        count += bytesRead;
        if (count > BUNDLE_LIMIT) throw new DiagnosticInputError("input_limit");
        for (const byte of chunk.subarray(0, bytesRead)) {
          if (++line > 4096) throw new DiagnosticInputError("input_limit");
          if (byte === 10) { line = 0; if (++events > EVENT_LIMIT) throw new DiagnosticInputError("input_limit"); }
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (line) return fail();
      const after = await privateStat(join(full, entry.name));
      if (after.ino !== info.ino || after.dev !== info.dev || after.size !== count || after.mtimeMs !== info.mtimeMs) throw new DiagnosticInputError("unsafe_path");
      files[entry.name] = Buffer.concat(chunks, count);
    } finally { await handle.close(); }
  }
  return files;
}
export async function importDiagnosticBundle(store: DiagnosticStore, directory: string): Promise<{ import_id: string; events: number; conflicts: string[]; expires_at: string; trust: "imported_assertion"; limitations: string[] }> {
  const policy = await store.status();
  const files = await readBundleDirectory(directory);
  const decoded = decodeDiagnosticBundle(files);
  if (decoded.cases.length && !policy.detail_allowed) throw new DiagnosticInputError("detail_policy_required");
  const existing = await store.listManaged("imports");
  // Bundle IDs are attribution, not local filenames or authority. Identical transfers are idempotent.
  const checksum = diagnosticTransferChecksum(files["manifest.json"]!);
  for (const item of existing) {
    const stored = await store.readManaged("imports", item.id);
    if (stored.files["manifest.json"] && diagnosticTransferChecksum(stored.files["manifest.json"]) === checksum && Object.keys(files).every((name) => stored.files[name] && diagnosticTransferChecksum(stored.files[name]!) === diagnosticTransferChecksum(files[name]!))) {
      const merged = decoded.manifest.source_ids.length ? await store.snapshot({ source_ids: decoded.manifest.source_ids }) : { conflicts: decoded.snapshot.conflicts };
      return { import_id: item.id, events: decoded.snapshot.events.filter((event) => !merged.conflicts.includes(`${event.source_id}/${event.event_id}`)).length, conflicts: merged.conflicts, expires_at: decoded.manifest.expires_at, trust: "imported_assertion", limitations: ["transfer_checksums_are_not_authenticity", "external_transfer_copy_not_deleted"] };
    }
  }
  const id = randomUUID();
  await store.putManaged("imports", id, files, { expires_at: decoded.manifest.expires_at, source_ids: decoded.manifest.source_ids, event_ids: [...new Set([...decoded.snapshot.events.map((event) => event.event_id), ...decoded.snapshot.conflicts.map((key) => key.split("/")[1]!)])], case_ids: decoded.cases.map((item) => item.case_id), detail: decoded.cases.length > 0 }, { generation: policy.generation });
  const merged = decoded.manifest.source_ids.length ? await store.snapshot({ source_ids: decoded.manifest.source_ids }) : { conflicts: decoded.snapshot.conflicts };
  return { import_id: id, events: decoded.snapshot.events.filter((event) => !merged.conflicts.includes(`${event.source_id}/${event.event_id}`)).length, conflicts: merged.conflicts, expires_at: decoded.manifest.expires_at, trust: "imported_assertion", limitations: ["transfer_checksums_are_not_authenticity", "external_transfer_copy_not_deleted"] };
}

export async function loadSelectedDiagnosticCases(store: DiagnosticStore, selection: DiagnosticSelection): Promise<SelectedDiagnosticCase[]> {
  const selected = selection.case_ids ?? [];
  if (!selected.length) return [];
  if (selection.include_detail !== true) throw new DiagnosticInputError("detail_policy_required");
  const cases = new Map<string, SelectedDiagnosticCase>();
  const conflicts = new Set<string>();
  const local = await store.listManaged("cases");
  for (const item of local) {
    if (!selected.includes(item.id)) continue;
    const stored = await store.readManaged("cases", item.id);
    const value = validateSelectedDiagnosticCase(parseDiagnosticJson(stored.files["detail.json"]!));
    cases.set(value.case_id, value);
  }
  for (const item of await store.listManaged("imports")) {
    if (!item.meta.detail || !item.meta.case_ids?.some((id) => selected.includes(id))) continue;
    const stored = await store.readManaged("imports", item.id);
    const decoded = decodeDiagnosticBundle(stored.files);
    for (const value of decoded.cases) {
      if (!selected.includes(value.case_id)) continue;
      const previous = cases.get(value.case_id);
      if (previous && JSON.stringify({ ...previous, trust: "imported_assertion" }) !== JSON.stringify({ ...value, trust: "imported_assertion" })) conflicts.add(value.case_id);
      else cases.set(value.case_id, { ...value, trust: "imported_assertion" });
    }
  }
  if (selected.some((id) => !cases.has(id) || conflicts.has(id))) throw new DiagnosticInputError("missing_evidence");
  return [...cases.values()];
}
export interface ResolvedDiagnosticEvidence {
  selection: DiagnosticSelection;
  snapshot: DiagnosticSnapshot;
  cases: SelectedDiagnosticCase[];
  expires_at: string;
  generation: number;
  partition_id?: string;
  root: string;
}
export async function resolveDiagnosticEvidence(store: DiagnosticStore, input: DiagnosticSelection): Promise<ResolvedDiagnosticEvidence> {
  const valid = validateDiagnosticSelection(input);
  if (!valid) return fail();
  const policy = await store.status();
  const cases = await loadSelectedDiagnosticCases(store, valid);
  const selection: DiagnosticSelection = cases.length ? { ...valid, event_ids: [...new Set([...(valid.event_ids ?? []), ...cases.flatMap((item) => item.event_ids)])] } : valid;
  let snapshot = deduplicateDiagnosticSnapshot(await store.snapshot(selection));
  if (cases.length) {
    // Event UUIDs are not globally unique across independent sources. Keep each
    // case's source/event association, rather than forming a union cross-product.
    const explicitEvents = valid.event_ids === undefined ? undefined : new Set(valid.event_ids);
    const links = cases.map((item) => ({ sources: new Set(item.source_ids), events: new Set(item.event_ids) }));
    const events = snapshot.events.filter((event) => explicitEvents?.has(event.event_id)
      || links.some((link) => link.sources.has(event.source_id) && link.events.has(event.event_id)));
    const conflicts = snapshot.conflicts.filter((key) => {
      const [source, event] = key.split("/");
      return explicitEvents?.has(event!) || links.some((link) => link.sources.has(source!) && link.events.has(event!));
    });
    const sources = new Set([...events.map((event) => event.source_id), ...conflicts.map((key) => key.split("/")[0]!)]);
    const descriptors = new Set(events.map((event) => event.descriptor_id));
    snapshot = {
      ...snapshot, events, conflicts,
      descriptors: snapshot.descriptors.filter((descriptor) => descriptors.has(descriptor.descriptor_id)),
      assertions: snapshot.assertions?.map((assertion) => ({
        ...assertion, source_ids: assertion.source_ids.filter((source) => sources.has(source)),
      })).filter((assertion) => assertion.source_ids.length > 0),
    };
  }
  if (snapshot.events.length > EVENT_LIMIT) throw new DiagnosticInputError("input_limit");
  const expiry = Math.min(Date.now() + METADATA_RETENTION_MS, ...snapshot.events.map((event) => Date.parse(event.occurred_at) + METADATA_RETENTION_MS), ...cases.map((item) => Date.parse(item.expires_at)), ...(snapshot.assertions ?? []).map((assertion) => Date.parse(assertion.expires_at)));
  return { selection, snapshot, cases, expires_at: new Date(expiry).toISOString(), generation: policy.generation, partition_id: policy.partition_id, root: policy.root };
}
export interface DiagnosticExportOptions { selection: DiagnosticSelection; out: string; expires_at: string; external?: boolean }
export async function exportDiagnosticBundle(store: DiagnosticStore, options: DiagnosticExportOptions): Promise<{ path: string; managed: boolean; limitations: string[]; manifest: DiagnosticBundleManifest }> {
  const evidence = await resolveDiagnosticEvidence(store, options.selection);
  return writeDiagnosticBundle(options, evidence);
}
export async function writeDiagnosticBundle(options: DiagnosticExportOptions, evidence: ResolvedDiagnosticEvidence, fixture?: DiagnosticFixture): Promise<{ path: string; managed: boolean; limitations: string[]; manifest: DiagnosticBundleManifest }> {
  const now = Date.now();
  const expiry = unexpired(options.expires_at, now);
  if (Date.parse(expiry) > Date.parse(evidence.expires_at)) return fail();
  const files: Record<string, string> = { "events.jsonl": evidence.snapshot.events.map((event) => encodeDiagnosticEvent(event) ?? fail()).map((line) => `${line}\n`).join("") };
  if (evidence.cases.length) files["detail.json"] = JSON.stringify({ schema_version: 1, cases: evidence.cases });
  if (fixture) { files["fixture.json"] = JSON.stringify(fixture); files["reproduce.mjs"] = REPRODUCTION_SCRIPT; files["instructions.txt"] = REPRODUCTION_INSTRUCTIONS; }
  const declarations: DiagnosticBundleManifest["files"] = {};
  for (const [name, text] of Object.entries(files)) declarations[name as FileName] = { bytes: Buffer.byteLength(text), sha256: diagnosticTransferChecksum(text) };
  const times = evidence.snapshot.events.map((event) => event.occurred_at).sort();
  const manifest: DiagnosticBundleManifest = { format: "tinycloud-diagnostics", schema_version: 1, bundle_id: randomUUID(), exported_at: new Date(now).toISOString(), expires_at: expiry, destination: options.external ? "external" : "managed", trust: evidence.snapshot.gaps.includes("import_untrusted") ? "imported_assertion" : "source_observation", integrity: "sha256-transfer-only-not-authenticity", content_tiers: ["metadata", ...(evidence.cases.length ? ["selected_detail" as const] : []), ...(fixture ? ["synthetic_fixture" as const] : [])], selection: evidence.selection, source_ids: [...new Set([...evidence.snapshot.events.map((event) => event.source_id), ...evidence.snapshot.conflicts.map((key) => key.split("/")[0]!), ...(evidence.snapshot.assertions ?? []).flatMap((assertion) => assertion.source_ids)])], partition_ids: [...new Set(evidence.snapshot.events.map((event) => event.partition_id))], original_times: { first: times[0] ?? null, last: times.at(-1) ?? null }, descriptors: evidence.snapshot.descriptors, gaps: evidence.snapshot.gaps, conflicts: evidence.snapshot.conflicts, files: declarations };
  files["manifest.json"] = JSON.stringify(manifest);
  decodeDiagnosticBundle(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value)])), now);
  const result = await writeDiagnosticDirectory(evidence.root, options.out, files, { external: options.external === true, expires_at: expiry, selection: evidence.selection, detail: evidence.cases.length > 0, partition_id: evidence.partition_id, generation: evidence.generation });
  return { ...result, manifest };
}

/** Retain unrelated evidence during an authorized exact deletion of a mixed managed copy. */
export function rewriteDiagnosticBundle(files: Readonly<Record<string, Uint8Array>>, selection: DiagnosticSelection, removedEventKeys: readonly string[] = []): { files: Record<string, Uint8Array>; meta: ManagedObjectMetadata } | undefined {
  const decoded = decodeDiagnosticBundle(files);
  const originalEvents = decodeEvents(files["events.jsonl"]!, Date.now());
  const removed = new Set([...removedEventKeys, ...originalEvents.filter((event) => diagnosticEventSelected(event, selection)).map((event) => `${event.source_id}/${event.event_id}`)]);
  const retained = originalEvents.filter((event) => !removed.has(`${event.source_id}/${event.event_id}`));
  const cases = decoded.cases.filter((item) => !selection.case_ids?.includes(item.case_id)
    && !item.event_ids.some((id) => item.source_ids.some((source) => removed.has(`${source}/${id}`))));
  const conflicts = decoded.snapshot.conflicts.filter((key) => !removed.has(key) && !diagnosticConflictSelected(key, selection));
  const assertedSources = decoded.manifest.source_ids.filter((id) =>
    !originalEvents.some((event) => event.source_id === id)
    && !decoded.snapshot.conflicts.some((key) => key.split("/")[0] === id)
    && !((!selection.source_ids || selection.source_ids.includes(id)) && (selection.all || selection.source_ids) && !selection.event_ids && !selection.invocation_ids && !selection.from && !selection.until));
  if (!retained.length && !cases.length && !conflicts.length && !assertedSources.length) return undefined;
  const output: Record<string, Uint8Array> = { "events.jsonl": Buffer.from(retained.map((event) => `${encodeDiagnosticEvent(event) ?? fail()}\n`).join("")) };
  if (cases.length) output["detail.json"] = Buffer.from(JSON.stringify({ schema_version: 1, cases }));
  const keepFixture = decoded.fixture && cases.some((item) => item.equivalence?.fixture_id === decoded.fixture!.fixture_id);
  if (keepFixture) for (const name of ["fixture.json", "reproduce.mjs", "instructions.txt"]) output[name] = files[name]!;
  const declarations: DiagnosticBundleManifest["files"] = {};
  for (const [name, bytes] of Object.entries(output)) declarations[name as FileName] = { bytes: bytes.byteLength, sha256: diagnosticTransferChecksum(bytes) };
  const times = retained.map((event) => event.occurred_at).sort();
  const sourceIds = [...new Set([...retained.map((event) => event.source_id), ...conflicts.map((key) => key.split("/")[0]!), ...assertedSources])];
  const retainedIds = [...new Set([...retained.map((event) => event.event_id), ...conflicts.map((key) => key.split("/")[1]!)])];
  const retainedSelection: DiagnosticSelection = {
    ...(sourceIds.length ? { source_ids: sourceIds } : { all: true }),
    ...(retainedIds.length && retainedIds.length <= 4096 && !assertedSources.length ? { event_ids: retainedIds } : {}),
    include_detail: cases.length > 0,
  };
  const manifest: DiagnosticBundleManifest = {
    ...decoded.manifest,
    source_ids: sourceIds,
    partition_ids: [...new Set(retained.map((event) => event.partition_id))],
    original_times: { first: times[0] ?? null, last: times.at(-1) ?? null },
    selection: { ...retainedSelection, ...(cases.length ? { case_ids: cases.map((item) => item.case_id) } : {}) },
    descriptors: decoded.manifest.descriptors.filter((descriptor) => retained.some((event) => event.descriptor_id === descriptor.descriptor_id)),
    conflicts,
    content_tiers: ["metadata", ...(cases.length ? ["selected_detail" as const] : []), ...(keepFixture ? ["synthetic_fixture" as const] : [])],
    files: declarations,
  };
  output["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  decodeDiagnosticBundle(output);
  return { files: output, meta: { expires_at: manifest.expires_at, source_ids: sourceIds, event_ids: retainedIds, case_ids: cases.map((item) => item.case_id), detail: cases.length > 0 } };
}
