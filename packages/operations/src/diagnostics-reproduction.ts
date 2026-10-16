import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationDefinition, RuntimeOperationContext } from "./contract.js";
import { appsOperationDefinitions, type ReadOutput, type WriteOutput } from "./operations/apps.js";
import { withTinyCloudStateRoot } from "./state.js";
import { TC_APPS_ROOT } from "./tc-apps.js";
import type { AppsKv, KvResult, KvValue } from "./tc-apps/kv.js";
import { appsTimezone } from "./tc-apps/state.js";
import { withDiagnosticContext } from "./diagnostics/context.js";
import { validateDiagnosticFixture } from "./diagnostics/reproduction.js";
import { DiagnosticInputError } from "./diagnostics/selection.js";

/** Separate heavy entry: normal diagnostics never load product operations or profile machinery. */
export interface DiagnosticReproductionResult {
  recipe: "tc_apps_write_independent_read";
  fixture_id: string;
  expected: { value: number; unit: "U1" };
  observed: { value: number; unit: string };
  write_outcome: "ok";
  read_outcome: "ok";
  independent_read_back: true;
  semantic_match: boolean;
  finding: "wrong_units" | "none";
  kv_reads: number;
  kv_writes: number;
  production_replay: false;
  limitation: "reviewed_input_reproduction_not_autonomous_client_behavior";
}

/** A disposable storage service fixture, not a fake operation result. Product code encodes and reads the bytes. */
class IsolatedDiagnosticKv implements AppsKv {
  private readonly entries = new Map<string, { path: string; etag: string }>();
  private serial = 0;
  reads = 0;
  writes = 0;
  constructor(private readonly root: string) {}
  async list(options: { prefix: string; limit: number; cursor?: string }) {
    const all = [...this.entries.keys()].filter((key) => key.startsWith(options.prefix));
    const offset = Number(options.cursor ?? 0);
    const keys = all.slice(offset, offset + options.limit);
    const more = offset + keys.length < all.length;
    return { ok: true as const, data: { keys, truncated: more, ...(more ? { nextCursor: String(offset + keys.length) } : {}) } };
  }
  async batchGet(keys: string[]) {
    if (keys.length > 100) throw new DiagnosticInputError("input_limit");
    this.reads++;
    const results: { key: string; result: KvResult<KvValue> }[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      results.push({ key, result: entry ? { ok: true, data: { data: await readFile(entry.path, "utf8"), headers: { etag: entry.etag } } } : { ok: false, error: { code: "KV_NOT_FOUND" } } });
    }
    return { ok: true as const, data: { results } };
  }
  async put(key: string, bytes: Uint8Array, options: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<KvResult<KvValue>> {
    if (bytes.byteLength > 65536 || this.entries.size >= 16) throw new DiagnosticInputError("input_limit");
    const previous = this.entries.get(key);
    if ((options.ifNoneMatch && previous) || (options.ifMatch && previous?.etag !== options.ifMatch)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
    const serial = ++this.serial;
    const path = previous?.path ?? join(this.root, `fixture-record-${serial}.json`);
    await writeFile(path, bytes, { mode: 0o600, flag: previous ? "w" : "wx" });
    // Synthetic concurrency tokens match the product's required token grammar, not content fingerprints.
    const etag = `"blake3-${serial.toString(16).padStart(64, "0")}"`;
    this.entries.set(key, { path, etag });
    this.writes++;
    return { ok: true, data: { data: undefined, headers: { etag } } };
  }
  async delete(key: string, options: { ifMatch?: string }): Promise<KvResult<KvValue>> {
    const entry = this.entries.get(key);
    if (!entry) return { ok: false, error: { code: "KV_NOT_FOUND" } };
    if (options.ifMatch && entry.etag !== options.ifMatch) return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
    await rm(entry.path);
    this.entries.delete(key);
    return { ok: true, data: { data: undefined, headers: {} } };
  }
}

export async function reproduceDiagnosticFixture(input: unknown): Promise<DiagnosticReproductionResult> {
  const fixture = validateDiagnosticFixture(input);
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostics-product-reproduction-"));
  try {
    return await withDiagnosticContext(undefined, () => withTinyCloudStateRoot(root, async () => {
      const kv = new IsolatedDiagnosticKv(root);
      const space = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
      const context: RuntimeOperationContext = { summary: { profile: "diagnostic-synthetic", host: "http://127.0.0.1", posture: "delegate-session", space }, runtime: { granted: [], node: { kvForSpace: (selected: string) => { if (selected !== space) throw new DiagnosticInputError(); return kv; } } } };
      await appsTimezone("diagnostic-synthetic", "UTC");
      const write = appsOperationDefinitions.find((definition) => definition.id === "tinycloud.apps.write") as OperationDefinition<unknown, WriteOutput> | undefined;
      const read = appsOperationDefinitions.find((definition) => definition.id === "tinycloud.apps.read") as OperationDefinition<unknown, ReadOutput> | undefined;
      if (!write || !read) throw new DiagnosticInputError();
      const key = `${TC_APPS_ROOT}synthetic/measurement/open/example`;
      const setup = await write.execute(context, { ops: [
        { op: "put", key: `${TC_APPS_ROOT}catalog/synthetic`, value: { app: "synthetic", title: "Synthetic diagnostic fixture", about: "Reviewed synthetic units", created: "2026-01-01" } },
        { op: "put", key: `${TC_APPS_ROOT}catalog/synthetic/measurement`, value: { app: "synthetic", kind: "measurement", about: "Reviewed synthetic units", shape: "item", states: ["open"], v: 1, fields: { value: "number", unit: "synthetic unit" }, created: "2026-01-01" } },
      ] });
      if (setup.status !== "ok" || setup.output.ops.some((op) => op.outcome !== "ok")) throw new DiagnosticInputError();
      const written = await write.execute(context, { ops: [{ op: "put", key, value: { v: 1, at: "2026-01-01", data: { value: fixture.observed.value, unit: fixture.observed.unit } } }] });
      if (written.status !== "ok" || written.output.ops[0]?.outcome !== "ok") throw new DiagnosticInputError();
      const readBack = await read.execute(context, { keys: [key] });
      if (readBack.status !== "ok") throw new DiagnosticInputError();
      const record = readBack.output.records[0];
      if (!record || !("value" in record) || !record.value.data || typeof record.value.data !== "object" || Array.isArray(record.value.data)) throw new DiagnosticInputError();
      const data = record.value.data;
      if (typeof data.value !== "number" || typeof data.unit !== "string") throw new DiagnosticInputError();
      const matched = data.value === fixture.expected.value && data.unit === fixture.expected.unit;
      return { recipe: "tc_apps_write_independent_read", fixture_id: fixture.fixture_id, expected: fixture.expected, observed: { value: data.value, unit: data.unit }, write_outcome: "ok", read_outcome: "ok", independent_read_back: true, semantic_match: matched, finding: data.unit !== fixture.expected.unit ? "wrong_units" : "none", kv_reads: kv.reads, kv_writes: kv.writes, production_replay: false, limitation: "reviewed_input_reproduction_not_autonomous_client_behavior" };
    }));
  } catch { throw new DiagnosticInputError(); }
  finally { await rm(root, { recursive: true, force: true }); }
}
