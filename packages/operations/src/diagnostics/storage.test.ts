import { afterEach, expect, test } from "bun:test";
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticStore, appendDiagnosticBatch, appendDiagnosticEvent, sweepDiagnosticRoot } from "./storage.js";
import { DIAGNOSTIC_LIMITS, repairDiagnosticLock, resolveDiagnosticTenant, withDiagnosticLock } from "./control.js";
import { withPrivateDirectory } from "./filesystem.js";
import { createDiagnosticRuntime } from "./runtime.js";
import { diagnosticId, encodeDiagnosticEvent, METADATA_RETENTION_MS } from "./model.js";
import type { DiagnosticEvent } from "./model.js";
import { exportDiagnosticBundle, importDiagnosticBundle, resolveDiagnosticEvidence, writeDiagnosticBundle } from "./bundles.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "tc-diagnostic-storage-")); homes.push(home);
  const root = join(home, "diagnostics");
  return { home, root, store: new DiagnosticStore(root) };
}
async function enabled() {
  const value = await fixture();
  const policy = await value.store.control("enable", { scope: "tc-apps" });
  const process = diagnosticId(); let sequence = 0;
  return { ...value, policy, event(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
    return { schema_version: 1, event_id: diagnosticId(), source_id: policy.source_id!, partition_id: policy.partition_id!,
      process_id: process, sequence: ++sequence, invocation_id: diagnosticId(), occurred_at: new Date().toISOString(), source: "cli", type: "invocation.start", ...overrides };
  } };
}

test("unconfigured status, unscoped construction and disabled binding create no root", async () => {
  const { root, store } = await fixture();
  expect(await store.status()).toMatchObject({ enabled: false, paused: false, generation: 0 });
  expect((await store.inspect()).enabled).toBe(false);
  const runtime = createDiagnosticRuntime({ root, source: "cli" });
  expect(await runtime.binding()).toBeUndefined();
  expect(runtime.health()).toMatchObject({ accepted: 0, pending: 0 });
  await runtime.close();
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

test("protected roots include default app state independently of XDG_STATE_HOME", async () => {
  const { home } = await fixture();
  const previous = { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME, TC_APPS_STATE: process.env.TC_APPS_STATE, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  try {
    process.env.HOME = home; process.env.TC_HOME = join(home, "profiles");
    process.env.XDG_STATE_HOME = join(home, "xdg");
    delete process.env.TC_APPS_STATE;
    const state = join(home, ".local", "state", "tc-apps");
    for (const root of [state, join(state, "diagnostics"), join(home, ".local", "state")]) {
      await expect((async () => new DiagnosticStore(root).control("enable", { scope: "tc-apps" }))()).rejects.toMatchObject({ code: "unsafe_path" });
      await expect(resolveDiagnosticTenant(root, "a".repeat(64), { create: true })).rejects.toMatchObject({ code: "unsafe_path" });
    }
    await expect(lstat(join(home, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    const safe = new DiagnosticStore(join(home, "xdg", "tinycloud", "diagnostics"));
    expect(await safe.control("enable", { scope: "tc-apps" })).toMatchObject({ enabled: true });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test.each(["TC_HOME", "TC_APPS_STATE"] as const)("protected roots reject physical overlap through %s aliases before creating files", async (variable) => {
  const { home } = await fixture();
  const previous = { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME, TC_APPS_STATE: process.env.TC_APPS_STATE };
  try {
    process.env.HOME = home; process.env.TC_HOME = join(home, "profiles"); process.env.TC_APPS_STATE = join(home, "apps");
    const target = join(home, "physical");
    const alias = join(home, "alias");
    await mkdir(target, { mode: 0o700 }); await symlink(target, alias);
    // The protected leaf is deliberately absent: canonicalizing only the full path misses this overlap.
    process.env[variable] = variable === "TC_HOME" ? alias : join(alias, "missing", "apps");
    const protectedPath = variable === "TC_HOME" ? join(target, ".tinycloud") : join(target, "missing", "apps");
    for (const root of [target, protectedPath, join(protectedPath, "diagnostics")]) {
      const store = new DiagnosticStore(root);
      await expect(store.status()).rejects.toMatchObject({ code: "unsafe_path" });
      await expect(store.control("enable", { scope: "tc-apps" })).rejects.toMatchObject({ code: "unsafe_path" });
      await expect(resolveDiagnosticTenant(root, "a".repeat(64), { create: true })).rejects.toMatchObject({ code: "unsafe_path" });
      await expect(repairDiagnosticLock(root, { writers_stopped: true })).rejects.toMatchObject({ code: "unsafe_path" });
      expect(await readdir(target)).toEqual([]);
    }
    await mkdir(protectedPath, { recursive: true, mode: 0o700 });
    await writeFile(join(protectedPath, "operator-state"), "synthetic-unchanged", { mode: 0o600 });
    await expect(new DiagnosticStore(join(protectedPath, "diagnostics")).control("enable", { scope: "tc-apps" })).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readdir(protectedPath)).toEqual(["operator-state"]);
    expect(await readFile(join(protectedPath, "operator-state"), "utf8")).toBe("synthetic-unchanged");
    const safe = new DiagnosticStore(`${protectedPath}-diagnostics`);
    expect(await safe.control("enable", { scope: "tc-apps" })).toMatchObject({ enabled: true });
    expect(await safe.control("disable")).toMatchObject({ enabled: false });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("protected roots reject dangling aliases without creating either target", async () => {
  const { home, root, store } = await fixture();
  const previous = process.env.TC_APPS_STATE;
  try {
    const absent = join(home, "absent");
    const alias = join(home, "alias");
    await symlink(absent, alias); process.env.TC_APPS_STATE = join(alias, "apps");
    await expect(store.control("enable", { scope: "tc-apps" })).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.TC_APPS_STATE; else process.env.TC_APPS_STATE = previous;
  }
});

test("protected roots are rechecked before append and maintenance on an existing store", async () => {
  const f = await enabled();
  const previous = process.env.TC_APPS_STATE;
  try {
    const alias = join(f.home, "apps-alias");
    await symlink(f.root, alias); process.env.TC_APPS_STATE = alias;
    const event = f.event();
    await expect(appendDiagnosticEvent(f.root, event, f.policy.generation)).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(appendDiagnosticBatch(f.root, [{ event, generation: f.policy.generation }])).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(sweepDiagnosticRoot(f.root)).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(f.store.control("disable")).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(lstat(join(f.root, "partitions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(f.root, ".writer-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.TC_APPS_STATE; else process.env.TC_APPS_STATE = previous;
  }
  expect(await f.store.status()).toMatchObject({ enabled: true, generation: f.policy.generation });
});

test("control inspection counts controlled detail without exposing it or substituting provenance", async () => {
  const f = await enabled();
  const descriptor = { descriptor_id: diagnosticId(), source: "cli" as const, package: "@tinycloud/cli" as const, version: "1.0.0" };
  const event = f.event({ descriptor_id: descriptor.descriptor_id });
  await appendDiagnosticEvent(f.root, event, f.policy.generation, descriptor);
  await f.store.control("enable", { scope: "tc-apps", detail_policy: "encrypted-excluded-backups" });
  const id = diagnosticId(), detail = '{"text":"selected-only-synthetic-canary"}';
  await f.store.putManaged("cases", id, { "detail.json": detail }, {
    expires_at: new Date(Date.now() + 60_000).toISOString(), source_ids: [f.policy.source_id!], event_ids: [event.event_id], detail: true,
  });
  async function bytes(path: string): Promise<number> {
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path)) total += await bytes(join(path, name));
    return total;
  }
  const inspection = await f.store.inspect();
  expect(inspection.usage.detail_bytes).toBe(Buffer.byteLength(detail));
  expect(inspection.usage.partition_bytes).toBe(
    await bytes(join(f.root, "partitions", f.policy.partition_id!)) + await bytes(join(f.root, "cases", f.policy.partition_id!)),
  );
  expect(inspection.usage.root_bytes).toBe(await bytes(f.root));
  expect(inspection.provenance).toEqual([descriptor]);
  expect(JSON.stringify(inspection)).not.toContain("selected-only-synthetic-canary");
  await f.store.removeManaged("cases", id);
  expect((await f.store.inspect()).usage.detail_bytes).toBe(0);
});

test("pause and deletion fence already-bound events without deleting unrelated complete lines", async () => {
  const f = await enabled();
  const first = f.event(); const second = f.event();
  await appendDiagnosticEvent(f.root, first, f.policy.generation);
  await appendDiagnosticEvent(f.root, second, f.policy.generation);
  const paused = await f.store.control("pause");
  expect(paused.generation).toBeGreaterThan(f.policy.generation);
  await expect(appendDiagnosticEvent(f.root, f.event(), f.policy.generation)).rejects.toMatchObject({ code: "disabled" });
  const resumed = await f.store.control("resume");
  await expect(appendDiagnosticEvent(f.root, f.event(), f.policy.generation)).rejects.toMatchObject({ code: "generation" });
  const report = await f.store.delete({ event_ids: [first.event_id] });
  expect(report).toMatchObject({ events: 1, complete: true, paused: false, enabled: true });
  expect((await f.store.snapshot({ all: true })).events.map((event) => event.event_id)).toEqual([second.event_id]);
  await expect(appendDiagnosticEvent(f.root, first, resumed.generation)).rejects.toMatchObject({ code: "generation" });
  await expect(f.store.delete({ all: true })).rejects.toMatchObject({ code: "invalid" });
  expect((await f.store.snapshot({ all: true })).events.map((event) => event.event_id)).toEqual([second.event_id]);
});

test("crash tail recovery retains complete evidence and records incomplete coverage", async () => {
  const f = await enabled(); const event = f.event();
  await appendDiagnosticEvent(f.root, event, f.policy.generation);
  const directory = join(f.root, "partitions", f.policy.partition_id!, "segments");
  const path = join(directory, (await readdir(directory))[0]);
  await appendFile(path, '{"event_id":"unfinished');
  const next = f.event(); const following = f.event();
  expect(await appendDiagnosticBatch(f.root, [next, following].map((event) => ({ event, generation: f.policy.generation })))).toEqual([undefined, undefined]);
  const snapshot = await f.store.snapshot({ all: true });
  expect(snapshot.events.map((item) => item.event_id)).toEqual([event.event_id, next.event_id, following.event_id]);
  expect(snapshot.gaps).toContain("incomplete_tail");
  const recovered = await readFile(path, "utf8");
  expect(recovered.endsWith("\n")).toBe(true);
  expect(recovered.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([event, next, following]);
});

test("expiry removes only expired lines even when an idle tenant never writes again", async () => {
  const f = await enabled(); const kept = f.event();
  await appendDiagnosticEvent(f.root, kept, f.policy.generation);
  const directory = join(f.root, "partitions", f.policy.partition_id!, "segments");
  const expired = f.event({ occurred_at: new Date(Date.now() - METADATA_RETENTION_MS - 1).toISOString() });
  const path = join(directory, (await readdir(directory))[0]);
  await appendFile(path, JSON.stringify(expired) + "\n");
  await sweepDiagnosticRoot(f.root);
  expect((await f.store.snapshot({ all: true })).events.map((item) => item.event_id)).toEqual([kept.event_id]);
  expect((await readFile(path, "utf8")).includes(expired.event_id)).toBe(false);
});

test("tenant selection is existing-map-only and never copies verified identifiers into events", async () => {
  const { root } = await fixture();
  const firstId = "1".repeat(64); const secondId = "2".repeat(64);
  expect(await resolveDiagnosticTenant(root, firstId)).toBeUndefined();
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  const first = await resolveDiagnosticTenant(root, firstId, { create: true });
  const second = await resolveDiagnosticTenant(root, secondId, { create: true });
  expect(first).not.toBe(second);
  expect(await resolveDiagnosticTenant(root, firstId)).toBe(first);
  await expect(resolveDiagnosticTenant(root, "../../outside", { create: true })).rejects.toMatchObject({ code: "invalid" });
  const firstStore = new DiagnosticStore(root, first);
  expect(await firstStore.status()).toMatchObject({ enabled: false });
  await firstStore.control("enable", { scope: "tc-apps" });
  expect(await new DiagnosticStore(root, second).status()).toMatchObject({ enabled: false });
  expect(JSON.stringify(await firstStore.status()).includes(firstId)).toBe(false);
});

test("unowned lock records cannot be stolen by age or a stopped-writer assertion", async () => {
  const { root, store } = await enabled();
  const lock = join(root, ".writer-lock");
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ version: 1, token: diagnosticId(), pid: 99999999, created_at: "1970-01-01T00:00:00.000Z" }), { mode: 0o600 });
  await expect(store.control("pause")).rejects.toMatchObject({ code: "locked" });
  await expect(repairDiagnosticLock(root, { writers_stopped: true })).rejects.toMatchObject({ code: "locked" });
  expect((await readdir(lock))).toEqual(["owner.json"]);
});

test("live process-origin ownership defeats a false repair assertion", async () => {
  const { root } = await enabled();
  await withPrivateDirectory(root, false, (directory) => withDiagnosticLock(directory, async () => {
    await expect(repairDiagnosticLock(root, { writers_stopped: true })).rejects.toMatchObject({ code: "locked" });
  }));
  await expect(lstat(join(root, ".writer-lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("symlinked control directories, hard-linked policies and public roots are refused", async () => {
  const f = await enabled();
  const external = join(f.home, "external"); await mkdir(external, { mode: 0o700 });
  await rm(join(f.root, "control"), { recursive: true }); await symlink(external, join(f.root, "control"));
  await expect(f.store.status()).rejects.toMatchObject({ code: "unsafe_path" });
  expect(await readdir(external)).toEqual([]);
  const g = await enabled();
  await link(join(g.root, "control", "local.json"), join(g.home, "alias.json"));
  await expect(g.store.status()).rejects.toMatchObject({ code: "unsafe_path" });
  const h = await enabled(); await chmod(h.root, 0o755);
  await expect(h.store.status()).rejects.toMatchObject({ code: "unsafe_path" });
});

test("managed detail enforces explicit policy, closed filenames and aggregate detail quota", async () => {
  const f = await enabled();
  const meta = { expires_at: new Date(Date.now() + 60_000).toISOString(), source_ids: [f.policy.source_id!], event_ids: [], detail: true };
  await expect(f.store.putManaged("cases", diagnosticId(), { "detail.json": "{}" }, meta)).rejects.toMatchObject({ code: "permission" });
  await f.store.control("enable", { scope: "tc-apps", detail_policy: "encrypted-excluded-backups" });
  await expect(f.store.putManaged("cases", diagnosticId(), { "../escaped": "{}" }, meta)).rejects.toMatchObject({ code: "invalid" });
  const detail = "x".repeat(DIAGNOSTIC_LIMITS.detail_object_bytes);
  const first = diagnosticId();
  await f.store.putManaged("cases", first, { "detail.json": detail }, { ...meta, detail_bytes: 0 });
  expect((await f.store.readManaged("cases", first)).meta.detail_bytes).toBe(DIAGNOSTIC_LIMITS.detail_object_bytes);
  for (let index = 1; index < DIAGNOSTIC_LIMITS.detail_bytes / DIAGNOSTIC_LIMITS.detail_object_bytes; index++) await f.store.putManaged("cases", diagnosticId(), { "detail.json": detail }, meta);
  await expect(f.store.putManaged("cases", diagnosticId(), { "detail.json": "x" }, meta)).rejects.toMatchObject({ code: "quota" });
  await f.store.removeManaged("cases", first);
  const replacement = diagnosticId(); await f.store.putManaged("cases", replacement, { "detail.json": "x" }, meta);
  expect((await f.store.readManaged("cases", replacement)).meta.detail_bytes).toBe(1);
});

test("case-only deletion removes exact selected detail without authorizing metadata deletion", async () => {
  const f = await enabled(); const event = f.event();
  await appendDiagnosticEvent(f.root, event, f.policy.generation);
  await f.store.control("enable", { scope: "tc-apps", detail_policy: "encrypted-excluded-backups" });
  const first = diagnosticId(); const second = diagnosticId();
  const meta = { expires_at: new Date(Date.now() + 60_000).toISOString(), source_ids: [f.policy.source_id!], event_ids: [event.event_id], detail: true };
  await f.store.putManaged("cases", first, { "detail.json": "{}" }, { ...meta, case_ids: [first] });
  await f.store.putManaged("cases", second, { "detail.json": "{}" }, { ...meta, case_ids: [second] });
  await f.store.delete({ case_ids: [first] });
  expect((await f.store.listManaged("cases")).map((item) => item.id)).toEqual([second]);
  expect((await f.store.snapshot({ all: true })).events.map((item) => item.event_id)).toEqual([event.event_id]);
});

test("portable managed exports import once and exact deletion preserves unrelated imported events", async () => {
  const source = await enabled(); const first = source.event(); const second = source.event();
  await appendDiagnosticEvent(source.root, first, source.policy.generation);
  await appendDiagnosticEvent(source.root, second, source.policy.generation);
  const exported = await exportDiagnosticBundle(source.store, { selection: { all: true }, out: join(source.root, "exports", diagnosticId()), expires_at: new Date(Date.now() + 60_000).toISOString() });
  expect((await readdir(exported.path)).sort()).toEqual(["events.jsonl", "manifest.json"]);
  const target = await fixture();
  await importDiagnosticBundle(target.store, exported.path);
  await importDiagnosticBundle(target.store, exported.path);
  expect((await target.store.snapshot({ all: true })).events.map((event) => event.event_id).sort()).toEqual([first.event_id, second.event_id].sort());
  const report = await target.store.delete({ event_ids: [first.event_id] });
  expect(report).toMatchObject({ events: 1, complete: true });
  expect((await target.store.snapshot({ all: true })).events.map((event) => event.event_id)).toEqual([second.event_id]);
  expect((await source.store.snapshot({ all: true })).events.map((event) => event.event_id).sort()).toEqual([first.event_id, second.event_id].sort());
});

test("a generation cutoff refuses export of evidence selected before deletion", async () => {
  const source = await enabled(); const event = source.event();
  await appendDiagnosticEvent(source.root, event, source.policy.generation);
  const evidence = await resolveDiagnosticEvidence(source.store, { all: true });
  await source.store.delete({ event_ids: [event.event_id] });
  await expect(writeDiagnosticBundle({ selection: { all: true }, out: join(source.root, "exports", diagnosticId()), expires_at: new Date(Date.now() + 60_000).toISOString() }, evidence)).rejects.toMatchObject({ code: "generation" });
  expect(await source.store.listManaged("exports")).toEqual([]);
});

test("rotation respects the segment cap without losing complete evidence", async () => {
  const source = await enabled(); const first = source.event();
  await appendDiagnosticEvent(source.root, first, source.policy.generation);
  const directory = join(source.root, "partitions", source.policy.partition_id!, "segments");
  const original = join(directory, (await readdir(directory))[0]);
  const line = await readFile(original, "utf8");
  await writeFile(original, line.repeat(Math.floor(DIAGNOSTIC_LIMITS.segment_bytes / Buffer.byteLength(line))));
  const second = source.event();
  await appendDiagnosticEvent(source.root, second, source.policy.generation);
  const names = await readdir(directory);
  expect(names).toHaveLength(2);
  for (const name of names) expect((await lstat(join(directory, name))).size).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.segment_bytes);
  expect((await source.store.snapshot({ all: true })).events.map((event) => event.event_id).sort()).toEqual([first.event_id, second.event_id].sort());
});

test("aggregate root accounting rejects growth even when the selected partition has room", async () => {
  const source = await enabled();
  const occupied = await open(join(source.root, "reserved-space"), "wx", 0o600);
  try { await occupied.truncate(DIAGNOSTIC_LIMITS.root_bytes); } finally { await occupied.close(); }
  await expect(appendDiagnosticEvent(source.root, source.event(), source.policy.generation)).rejects.toMatchObject({ code: "quota" });
  expect((await source.store.snapshot({ all: true })).events).toEqual([]);
});

test("mixed-partition batches charge descriptors and prior lines against the shared root limit", async () => {
  const source = await enabled();
  const otherId = await resolveDiagnosticTenant(source.root, "3".repeat(64), { create: true });
  const other = new DiagnosticStore(source.root, otherId);
  const otherPolicy = await other.control("enable", { scope: "tc-apps" });
  const firstWarm = source.event();
  const otherWarm = source.event({ partition_id: otherId!, source_id: otherPolicy.source_id! });
  await appendDiagnosticEvent(source.root, firstWarm, source.policy.generation);
  await appendDiagnosticEvent(source.root, otherWarm, otherPolicy.generation);
  const descriptor = { descriptor_id: diagnosticId(), source: "cli" as const };
  const accepted = source.event({ descriptor_id: descriptor.descriptor_id });
  const rejected = source.event({ partition_id: otherId!, source_id: otherPolicy.source_id! });
  async function bytesUnder(path: string): Promise<number> {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return stats.size;
    let bytes = 0;
    for (const name of await readdir(path)) bytes += await bytesUnder(join(path, name));
    return bytes;
  }
  const allowance = Buffer.byteLength(encodeDiagnosticEvent(accepted)! + "\n") + Buffer.byteLength(JSON.stringify(descriptor));
  const occupied = await open(join(source.root, "reserved-space"), "wx", 0o600);
  try { await occupied.truncate(DIAGNOSTIC_LIMITS.root_bytes - DIAGNOSTIC_LIMITS.control_reserve_bytes - await bytesUnder(source.root) - allowance); }
  finally { await occupied.close(); }
  expect(await appendDiagnosticBatch(source.root, [
    { event: accepted, generation: source.policy.generation, descriptor },
    { event: rejected, generation: otherPolicy.generation },
    { event: source.event(), generation: source.policy.generation + 1 },
    { event: source.event(), generation: source.policy.generation },
  ])).toEqual([undefined, "quota", "generation", "quota"]);
  expect((await source.store.snapshot({ all: true })).events.map((event) => event.event_id)).toEqual([firstWarm.event_id, accepted.event_id]);
  expect((await other.snapshot({ all: true })).events.map((event) => event.event_id)).toEqual([otherWarm.event_id]);
  expect(await lstat(join(source.root, ".writer-lock")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
});

test("failed mixed deletion remains visibly incomplete and leaves the generation paused", async () => {
  const source = await enabled(); const first = source.event(); const second = source.event();
  await appendDiagnosticEvent(source.root, first, source.policy.generation);
  await appendDiagnosticEvent(source.root, second, source.policy.generation);
  const occupied = await open(join(source.root, "reserved-space"), "wx", 0o600);
  try { await occupied.truncate(DIAGNOSTIC_LIMITS.root_bytes); } finally { await occupied.close(); }
  await expect(source.store.delete({ event_ids: [first.event_id] })).rejects.toMatchObject({ name: "DiagnosticDeletionError", code: "quota", incomplete: true });
  expect(await source.store.status()).toMatchObject({ enabled: true, paused: true });
  expect((await source.store.snapshot({ all: true })).events.map((event) => event.event_id).sort()).toEqual([first.event_id, second.event_id].sort());
});

test("closing during policy discovery refuses the late capture binding", async () => {
  const source = await enabled();
  const runtime = createDiagnosticRuntime({ root: source.root, source: "cli" });
  const pending = runtime.binding();
  await runtime.close();
  expect(await pending).toBeUndefined();
});
