import { lstat, mkdir, readFile, readlink, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { diagnosticId, isDiagnosticId, diagnosticDataObject } from "./model.js";
import type { DiagnosticEvent } from "./model.js";
import type { DiagnosticWrite } from "./storage.js";
import type { DiagnosticFailure } from "./filesystem.js";
import { absolutePath, assertSeparateDirectories, atomicPrivateWrite, DiagnosticError, diagnosticGuard, inside, isMissing, privateDirectoryExists, privateEntries, privateJson, privateMkdir, removePrivateTree, withPrivateDirectory } from "./filesystem.js";
import type { PrivateDirectory } from "./filesystem.js";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  event_bytes: 4096, segment_bytes: 5 * 1024 * 1024, metadata_bytes: 100 * 1024 * 1024,
  detail_object_bytes: 1024 * 1024, detail_bytes: 10 * 1024 * 1024, root_bytes: 1024 * 1024 * 1024,
  control_reserve_bytes: 2 * 1024 * 1024,
  // Full-copy bursts and eight-process wrapper contention exceed the original
  // 64-event/100-ms/150-ms bounds. Byte capacity and failure isolation stay fixed.
  queue_events: 128, queue_bytes: 256 * 1024, batch_events: 8, drain_ms: 300, lock_ms: 200,
  recovery_entries: 64,
  // Provisional cold bridge + child + discovery bound, separate from lock/drain budgets.
  discovery_ms: 1000, probe_idle_ms: 100, partitions: 1024, objects: 8192, sweep_ms: 60_000,
});
export const WORKER_COUNTER = Object.freeze({ accepted: 0, acknowledged: 1, dropped: 2, bytes: 3, pending: 4, signal: 5, failure: 6, closed: 7, maintenance: 8 });
export const WORKER_FAILURES = [undefined, "invalid", "unsafe_path", "permission", "missing", "locked", "quota", "expired", "disabled", "generation", "io", "worker", "queue", "timeout"] as const;
export function addDiagnosticLoss(state: Int32Array, count = 1): void {
  let previous = Atomics.load(state, WORKER_COUNTER.dropped);
  for (;;) {
    const next = Math.min(0x7fffffff, previous + count);
    const actual = Atomics.compareExchange(state, WORKER_COUNTER.dropped, previous, next);
    if (actual === previous) return;
    previous = actual;
  }
}

const RECOVERY_FAILURES: Record<DiagnosticFailure, NonNullable<DiagnosticEvent["failure"]>> = {
  invalid: "invalid_event", unsafe_path: "unsafe_path", permission: "permission", missing: "write_failed",
  locked: "lock_contention", quota: "quota", expired: "write_failed", disabled: "disabled",
  generation: "generation_changed", io: "write_failed", worker: "worker_dead", queue: "queue_full", timeout: "drain_timeout",
};
/**
 * Closed, bounded loss summaries only; never retain the dropped observation.
 * Capacity overflow and a permanently failed/terminal sink remain unknown.
 * Each summary keeps its original generation and invocation, even when another
 * invocation supplies the later opportunity to persist it.
 */
export function recordDiagnosticRecovery(
  pending: Map<string, DiagnosticWrite>, origin: DiagnosticWrite, failure: DiagnosticFailure,
  processId: string, nextSequence: () => number,
): void {
  if (origin.event.type === "capture.health" || failure === "generation" || failure === "disabled") return;
  const event = origin.event;
  const key = JSON.stringify([event.partition_id, origin.generation, event.source_id, event.source, event.invocation_id, processId, failure]);
  const previous = pending.get(key);
  if (previous) {
    if (previous.event.dropped! < 0x7fffffff) {
      previous.event = { ...previous.event, dropped: previous.event.dropped! + 1 };
    }
    return;
  }
  if (pending.size >= DIAGNOSTIC_LIMITS.recovery_entries) return;
  const sequence = nextSequence();
  if (!Number.isSafeInteger(sequence) || sequence < 1) return;
  pending.set(key, { generation: origin.generation, event: {
    schema_version: 1, type: "capture.health", event_id: diagnosticId(), source_id: event.source_id,
    partition_id: event.partition_id, invocation_id: event.invocation_id, source: event.source,
    process_id: processId, sequence, occurred_at: new Date().toISOString(),
    outcome: "dropped", dropped: 1, failure: RECOVERY_FAILURES[failure],
  } });
}
interface LockOwner { version: 1; token: string; pid: number; boot?: string; namespace?: string; start?: string }
let origin: Promise<Pick<LockOwner, "boot" | "namespace" | "start">> | undefined;
function processOrigin(): Promise<Pick<LockOwner, "boot" | "namespace" | "start">> {
  return origin ??= (async () => {
    if (process.platform !== "linux") return {};
    try {
      const [boot, namespace, stat, numberedNamespace, numberedStat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink("/proc/self/ns/pid"), readFile("/proc/self/stat", "utf8"),
        readlink(`/proc/${process.pid}/ns/pid`), readFile(`/proc/${process.pid}/stat`, "utf8"),
      ]);
      const start = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
      if (!isDiagnosticId(boot.trim()) || !/^pid:\[\d+\]$/.test(namespace) || !/^\d+$/.test(start)) return {};
      const numberedStart = numberedStat.slice(numberedStat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
      if (numberedNamespace !== namespace || numberedStart !== start) return {};
      return { boot: boot.trim(), namespace, start };
    } catch { return {}; }
  })();
}
export interface DiagnosticPolicy {
  version: 1;
  source_id: string;
  partition_id: string;
  enabled: boolean;
  paused: boolean;
  generation: number;
  detail_allowed: boolean;
}
export function diagnosticProtectedRoots(): readonly [string, string] {
  return [
    absolutePath(join(process.env.TC_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".tinycloud")),
    absolutePath(process.env.TC_APPS_STATE ?? join(process.env.HOME ?? homedir(), ".local", "state", "tc-apps")),
  ];
}
export function diagnosticRoot(root?: string): string {
  const selected = absolutePath(root ?? process.env.TC_DIAGNOSTICS_HOME ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? homedir(), ".local", "state"), "tinycloud", "diagnostics"));
  // Pure path checks only; physical checks belong to controls and the isolated writer.
  if (diagnosticProtectedRoots().some((path) => inside(path, selected) || inside(selected, path))) throw new DiagnosticError("unsafe_path");
  return selected;
}
export async function validateDiagnosticRoot(root: string, separateFrom?: string): Promise<string> {
  const selected = diagnosticRoot(root);
  const protectedRoots = diagnosticProtectedRoots();
  await assertSeparateDirectories(selected, separateFrom === undefined ? protectedRoots : [...protectedRoots, separateFrom]);
  return selected;
}
/** Validate before any creation without relaxing descriptor-pinned ancestor checks. */
export async function withDiagnosticDirectory<T>(root: string, create: boolean, action: (directory: PrivateDirectory) => Promise<T>): Promise<T> {
  return withPrivateDirectory(await validateDiagnosticRoot(root), create, action);
}
export function parsePolicy(value: unknown): DiagnosticPolicy {
  const data = diagnosticDataObject(value, 8);
  if (!data || Object.keys(data).length !== 7 || data.version !== 1 || !isDiagnosticId(data.source_id) || !isDiagnosticId(data.partition_id)
    || typeof data.enabled !== "boolean" || typeof data.paused !== "boolean" || typeof data.detail_allowed !== "boolean"
    || !Number.isSafeInteger(data.generation) || Number(data.generation) < 1) throw new DiagnosticError("invalid");
  return data as unknown as DiagnosticPolicy;
}
export async function readPolicy(directory: PrivateDirectory, partitionId?: string): Promise<DiagnosticPolicy | undefined> {
  let id = partitionId;
  if (id !== undefined && !isDiagnosticId(id)) throw new DiagnosticError("invalid");
  try {
    if (!await privateDirectoryExists(join(directory.path, "control")) || !await privateDirectoryExists(join(directory.path, "control", "partitions"))) return undefined;
    if (!id) {
      const local = await privateJson<{ partition_id: string }>(join(directory.path, "control", "local.json"));
      if (!isDiagnosticId(local.partition_id) || Object.keys(local).length !== 1) throw new DiagnosticError("invalid");
      id = local.partition_id;
    }
    const policy = parsePolicy(await privateJson(join(directory.path, "control", "partitions", `${id}.json`)));
    if (policy.partition_id !== id) throw new DiagnosticError("invalid");
    return policy;
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
export async function savePolicy(directory: PrivateDirectory, policy: DiagnosticPolicy): Promise<void> {
  parsePolicy(policy);
  await atomicPrivateWrite(join(directory.path, "control", "partitions", `${policy.partition_id}.json`), JSON.stringify(policy));
}
export async function initializeControl(directory: PrivateDirectory): Promise<void> {
  await privateMkdir(join(directory.path, "control"));
  await privateMkdir(join(directory.path, "control", "partitions"));
  await privateMkdir(join(directory.path, "control", "tenants"));
  await privateMkdir(join(directory.path, "control", "maintenance"));
  for (const path of [join(directory.path, "control"), ...["partitions", "tenants", "maintenance"].map((name) => join(directory.path, "control", name))]) {
    for (const name of await privateEntries(path)) if (/^\.[0-9a-f-]{36}\.tmp$/.test(name)) await removePrivateTree(join(path, name));
  }
}
export async function newPolicy(directory: PrivateDirectory, local: boolean): Promise<DiagnosticPolicy> {
  if ((await privateEntries(join(directory.path, "control", "partitions"), DIAGNOSTIC_LIMITS.partitions)).length >= DIAGNOSTIC_LIMITS.partitions) throw new DiagnosticError("quota");
  const policy: DiagnosticPolicy = { version: 1, source_id: diagnosticId(), partition_id: diagnosticId(), enabled: false, paused: false, generation: 1, detail_allowed: false };
  await savePolicy(directory, policy);
  if (local) await atomicPrivateWrite(join(directory.path, "control", "local.json"), JSON.stringify({ partition_id: policy.partition_id }));
  return policy;
}
/** No timestamp/PID heuristics: an abandoned lock remains closed pending protected stopped-writer repair. */
export async function withDiagnosticLock<T>(directory: PrivateDirectory, action: () => Promise<T>, timeoutMs = DIAGNOSTIC_LIMITS.lock_ms): Promise<T> {
  const lock = join(directory.path, ".writer-lock");
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      if (await privateDirectoryExists(join(directory.path, ".repair-lock"))) throw Object.assign(new Error(), { code: "EEXIST" });
      await mkdir(lock, { mode: 0o700 }); break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!await privateDirectoryExists(lock) && !await privateDirectoryExists(join(directory.path, ".repair-lock"))) continue;
      if (performance.now() >= deadline) throw new DiagnosticError("locked");
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2, Math.max(1, deadline - performance.now()))));
    }
  }
  const token = diagnosticId();
  try {
    const owner: LockOwner = { version: 1, token, pid: process.pid, ...await processOrigin() };
    await atomicPrivateWrite(join(lock, "owner.json"), JSON.stringify(owner));
    await directory.assertStable();
    return await action();
  } finally {
    // Release only this acquisition. A replaced/invalid record is never erased.
    try {
      const owner = await privateJson<{ token: string }>(join(lock, "owner.json"));
      if (owner.token !== token) throw new DiagnosticError("locked");
      await unlink(join(lock, "owner.json")); await rmdir(lock);
    } catch { throw new DiagnosticError("locked"); }
  }
}
/** Protected repair requires caller stop confirmation AND same-kernel process-origin proof of death. */
export async function repairDiagnosticLock(root: string, options: { writers_stopped: true }): Promise<{ repaired: boolean }> {
  return diagnosticGuard(async () => {
    if (options?.writers_stopped !== true) throw new DiagnosticError("permission");
    return withDiagnosticDirectory(root, false, async (directory) => {
      const lock = join(directory.path, ".writer-lock");
      if (!await privateDirectoryExists(lock)) return { repaired: false };
      const repair = join(directory.path, ".repair-lock");
      try { await mkdir(repair, { mode: 0o700 }); } catch { throw new DiagnosticError("locked"); }
      try {
        const before = await lstat(lock);
        const owner = await privateJson<LockOwner>(join(lock, "owner.json"));
        const current = await processOrigin();
        if (owner.version !== 1 || !isDiagnosticId(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
          || !current.boot || owner.boot !== current.boot || owner.namespace !== current.namespace || !/^\d+$/.test(owner.start ?? "")) throw new DiagnosticError("locked");
        let dead = false;
        try {
          const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8");
          const start = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
          dead = /^\d+$/.test(start) && start !== owner.start;
        } catch (error) { if (isMissing(error)) dead = true; }
        if (!dead) throw new DiagnosticError("locked");
        const after = await lstat(lock);
        const again = await privateJson<LockOwner>(join(lock, "owner.json"));
        if (before.dev !== after.dev || before.ino !== after.ino || JSON.stringify(owner) !== JSON.stringify(again)) throw new DiagnosticError("locked");
        const names = await privateEntries(lock);
        if (names.length !== 1 || names[0] !== "owner.json") throw new DiagnosticError("locked");
        await unlink(join(lock, "owner.json")); await rmdir(lock);
        return { repaired: true };
      } finally { await rmdir(repair); }
    });
  });
}
export async function resolveDiagnosticTenant(root: string, verifiedTenantId: string, options: { create?: boolean } = {}): Promise<string | undefined> {
  return diagnosticGuard(async () => {
    root = diagnosticRoot(root);
    if (!/^[a-f0-9]{64}$/.test(verifiedTenantId) && verifiedTenantId !== "service") throw new DiagnosticError("invalid");
    try {
      return await withDiagnosticDirectory(root, options.create === true, async (directory) => {
        const lookup = async () => {
          try {
            if (!await privateDirectoryExists(join(directory.path, "control")) || !await privateDirectoryExists(join(directory.path, "control", "tenants"))) return undefined;
            const map = await privateJson<{ partition_id: string }>(join(directory.path, "control", "tenants", `${verifiedTenantId}.json`));
            if (!isDiagnosticId(map.partition_id) || Object.keys(map).length !== 1 || !await readPolicy(directory, map.partition_id)) throw new DiagnosticError("invalid");
            return map.partition_id;
          } catch (error) { if (isMissing(error)) return undefined; throw error; }
        };
        if (!options.create) return lookup();
        return withDiagnosticLock(directory, async () => {
          await initializeControl(directory);
          const existing = await lookup();
          if (existing) return existing;
          if ((await privateEntries(join(directory.path, "control", "tenants"), DIAGNOSTIC_LIMITS.partitions)).length >= DIAGNOSTIC_LIMITS.partitions) throw new DiagnosticError("quota");
          const policy = await newPolicy(directory, false);
          await atomicPrivateWrite(join(directory.path, "control", "tenants", `${verifiedTenantId}.json`), JSON.stringify({ partition_id: policy.partition_id }));
          return policy.partition_id;
        });
      });
    } catch (error) { if (isMissing(error) && !options.create) return undefined; throw error; }
  });
}
