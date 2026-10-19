import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import {
  DIAGNOSTIC_SOURCES, diagnosticId, encodeDiagnosticEvent, isDiagnosticId, projectDiagnosticObservation, validateDiagnosticDescriptor,
} from "./model.js";
import type { DiagnosticDescriptor, DiagnosticEvent, DiagnosticObservation, DiagnosticSource } from "./model.js";
import type { DiagnosticBinding, DiagnosticContext } from "./context.js";
import { addDiagnosticLoss, DIAGNOSTIC_LIMITS, diagnosticProtectedRoots, diagnosticRoot, recordDiagnosticRecovery, WORKER_COUNTER, WORKER_FAILURES } from "./control.js";
import type { DiagnosticDiscoveryRequest, DiagnosticDiscoveryResult, DiagnosticWorkerConfiguration, DiagnosticWorkerReply } from "./worker.js";
import type { DiagnosticFailure } from "./filesystem.js";
import type { DiagnosticWrite } from "./storage.js";

export interface DiagnosticHealth { accepted: number; acknowledged: number; dropped: number; pending: number; queue_bytes: number; maintenance_pending: number; ready: boolean; failure?: DiagnosticFailure }
interface Discovery {
  request: DiagnosticDiscoveryRequest;
  promise: Promise<DiagnosticDiscoveryResult | undefined>;
  resolve: (result: DiagnosticDiscoveryResult | undefined) => void;
  timer?: NodeJS.Timeout;
  worker?: Worker;
}
interface Channel {
  state: Int32Array; ready: Int32Array; worker?: Worker; failed: boolean; closed: boolean;
  active: boolean; retiring: boolean; retired: boolean; idle?: NodeJS.Timeout;
  terminalDeadline?: number; closing?: Promise<void>;
  partitions: Map<string, number>; discoveries: Map<string, Discovery>;
  recovery: Map<string, DiagnosticWrite>;
}
interface RuntimeRegistry { channels: Map<string, Channel>; runtimes: Map<string, DiagnosticRuntime>; processId: string; sequence: number; worker?: Worker; uncertainChild?: boolean }
const RUNTIME_KEY = Symbol.for("@tinycloud/operations/diagnostics/runtime/v2");
const globals = globalThis as typeof globalThis & { [RUNTIME_KEY]?: RuntimeRegistry };
const registry: RuntimeRegistry = globals[RUNTIME_KEY] ??= { channels: new Map(), runtimes: new Map(), processId: diagnosticId(), sequence: 0 };
export interface DiagnosticRuntimeConfig {
  root?: string; source: DiagnosticSource; hosted?: boolean; descriptor?: DiagnosticDescriptor;
  /** Physical separation from hosted credential state is checked only in the isolated helper. */
  separateFrom?: string;
}

export class DiagnosticRuntime {
  readonly root: string;
  private readonly channel: Channel;
  private readonly descriptor?: DiagnosticDescriptor;
  private readonly configFailure?: DiagnosticFailure;
  private readonly protectedRoots: readonly [string, string] = ["", ""];
  get closed(): boolean { return this.channel.closed; }
  constructor(private readonly config: DiagnosticRuntimeConfig) {
    let root = ""; let failure: DiagnosticFailure | undefined;
    try {
      if ((config.hosted && config.root === undefined) || !DIAGNOSTIC_SOURCES.includes(config.source)) throw new Error();
      root = diagnosticRoot(config.root);
      this.protectedRoots = diagnosticProtectedRoots();
      if (config.descriptor) {
        this.descriptor = validateDiagnosticDescriptor(config.descriptor);
        if (!this.descriptor) throw new Error();
      }
    } catch { failure = "invalid"; }
    this.root = root; this.configFailure = failure;
    const key = JSON.stringify([config.hosted === true, root, config.separateFrom, this.protectedRoots]);
    let channel = registry.channels.get(key);
    if (!channel || channel.closed) {
      if (registry.channels.size >= 64) {
        for (const [oldKey, old] of registry.channels) {
          if (!old.worker || old.worker.threadId === -1) { registry.channels.delete(oldKey); break; }
        }
      }
      channel = { state: new Int32Array(new SharedArrayBuffer(9 * Int32Array.BYTES_PER_ELEMENT)), ready: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
        failed: false, closed: false, active: false, retiring: false, retired: false, partitions: new Map(), discoveries: new Map(), recovery: new Map() };
      registry.channels.set(key, channel);
    }
    this.channel = channel;
  }
  /** Explicit hosted housekeeping authorization; never implies activity scope or tenant capture enablement. */
  async startMaintenance(): Promise<void> {
    if (this.config.hosted) await this.discover({ type: "discover", key: "maintenance", kind: "maintenance" });
  }
  async binding(partitionId?: string): Promise<DiagnosticBinding | undefined> {
    if ((partitionId !== undefined && !isDiagnosticId(partitionId)) || (this.config.hosted && partitionId === undefined)) return undefined;
    const result = await this.discover({ type: "discover", key: `policy:${partitionId ?? "local"}`, kind: "policy", partitionId });
    return this.bind(result);
  }
  /** Only an already verified tenant HMAC (or the fixed service label) may select an existing mapping. */
  async bindingForTenant(verifiedTenantId: string): Promise<DiagnosticBinding | undefined> {
    if (!this.config.hosted || (verifiedTenantId !== "service" && !/^[a-f0-9]{64}$/.test(verifiedTenantId))) return undefined;
    const result = await this.discover({ type: "discover", key: `tenant:${verifiedTenantId}`, kind: "tenant", verifiedTenantId });
    return this.bind(result);
  }
  private bind(result: DiagnosticDiscoveryResult | undefined): DiagnosticBinding | undefined {
    const policy = result?.policy;
    if (this.channel.closed || this.channel.failed || !policy?.enabled || policy.paused || !this.channel.worker
      || this.channel.partitions.get(policy.partition_id) !== policy.generation || Atomics.load(this.channel.state, WORKER_COUNTER.closed) !== 0) return undefined;
    return Object.freeze({ runtime: this, source_id: policy.source_id, partition_id: policy.partition_id,
      generation: policy.generation, descriptor_id: this.descriptor?.descriptor_id });
  }
  private discover(request: DiagnosticDiscoveryRequest): Promise<DiagnosticDiscoveryResult | undefined> {
    const channel = this.channel;
    if (this.configFailure || channel.failed || channel.closed) return Promise.resolve(undefined);
    const existing = channel.discoveries.get(request.key);
    if (existing) return existing.promise;
    if (channel.discoveries.size >= 64) { this.fail("quota"); return Promise.resolve(undefined); }
    clearTimeout(channel.idle);
    let resolve!: Discovery["resolve"];
    const promise = new Promise<DiagnosticDiscoveryResult | undefined>((complete) => { resolve = complete; });
    const discovery: Discovery = { request, promise, resolve };
    channel.discoveries.set(request.key, discovery);
    // Includes cold bridge/child/module startup. A timeout resolves admission, not
    // native I/O: entries remain single-flight until the helper actually dies.
    discovery.timer = setTimeout(() => {
      channel.failed = true; this.fail("timeout");
      for (const pending of channel.discoveries.values()) { clearTimeout(pending.timer); pending.resolve(undefined); }
      try { channel.worker?.postMessage({ type: "abort" }); } catch { this.fail("worker"); }
    }, DIAGNOSTIC_LIMITS.discovery_ms);
    if (!this.start()) {
      clearTimeout(discovery.timer); channel.discoveries.delete(request.key); resolve(undefined);
    } else this.dispatchDiscoveries();
    return promise;
  }
  private dispatchDiscoveries(): void {
    const channel = this.channel;
    if (!channel.worker || channel.retiring || channel.closed || channel.failed) return;
    for (const discovery of channel.discoveries.values()) {
      if (discovery.worker) continue;
      discovery.worker = channel.worker;
      try { channel.worker.postMessage(discovery.request); }
      catch {
        channel.failed = true; this.fail("worker");
        for (const pending of channel.discoveries.values()) { clearTimeout(pending.timer); pending.resolve(undefined); }
        try { channel.worker.postMessage({ type: "abort" }); } catch { /* bridge exit owns settlement */ }
        break;
      }
    }
  }
  private fail(failure: DiagnosticFailure): void {
    Atomics.store(this.channel.state, WORKER_COUNTER.failure, WORKER_FAILURES.indexOf(failure));
  }
  private start(): boolean {
    if (this.channel.closed || this.channel.failed || this.configFailure || Atomics.load(this.channel.state, WORKER_COUNTER.closed) !== 0) return false;
    if (this.channel.worker) return !this.channel.failed;
    if (registry.uncertainChild) { this.fail("worker"); return false; }
    if (registry.worker) { this.fail("invalid"); return false; }
    try {
      // Package self/dependency resolution survives CLI/MCP bundling; never load the operations root.
      const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
      const path = require.resolve("@tinycloud/operations/diagnostics-worker");
      const workerData: DiagnosticWorkerConfiguration = {
        root: this.root, hosted: this.config.hosted === true, separateFrom: this.config.separateFrom, entry: path,
        protectedRoots: this.protectedRoots,
        state: this.channel.state.buffer as SharedArrayBuffer, ready: this.channel.ready.buffer as SharedArrayBuffer,
        counters: WORKER_COUNTER, failures: WORKER_FAILURES,
        limits: { batch_events: DIAGNOSTIC_LIMITS.batch_events, sweep_ms: DIAGNOSTIC_LIMITS.sweep_ms },
      };
      const worker = new Worker(path, { workerData, execArgv: [], env: {}, stdout: true, stderr: true });
      this.channel.worker = worker;
      registry.worker = worker;
      this.channel.retired = false;
      const failed = () => {
        Atomics.store(this.channel.ready, 0, 0);
        if (this.channel.closed && Atomics.load(this.channel.state, WORKER_COUNTER.closed) === 1) return;
        this.channel.failed = true; this.fail("worker");
        for (const pending of this.channel.discoveries.values()) { clearTimeout(pending.timer); pending.resolve(undefined); }
        // A failed bridge does not prove its child stopped or its writes failed.
        // Keep reservations unresolved until the child reports settlement/death.
        Atomics.add(this.channel.state, WORKER_COUNTER.signal, 1); Atomics.notify(this.channel.state, WORKER_COUNTER.signal);
      };
      worker.on("error", failed);
      worker.on("message", (message: DiagnosticWorkerReply) => {
        if (message.type === "retired" || message.type === "closed") {
          if (message.type === "retired") this.channel.retired = true;
          // Both replies follow the native child's close event. Some hosts keep
          // an otherwise finished bridge alive after port.close(); it is safe
          // to terminate only now, never merely because a deadline elapsed.
          void worker.terminate().catch(failed);
          return;
        }
        const discovery = this.channel.discoveries.get(message.key);
        if (!discovery || discovery.worker !== worker) return;
        clearTimeout(discovery.timer);
        this.channel.discoveries.delete(message.key);
        if (this.channel.closed || this.channel.failed) { discovery.resolve(undefined); return; }
        if (message.failure) this.fail(message.failure);
        const policy = message.policy;
        if (policy) {
          for (const [key, report] of this.channel.recovery) {
            if (report.event.partition_id === policy.partition_id
              && (!policy.enabled || policy.paused || report.generation !== policy.generation)) this.channel.recovery.delete(key);
          }
        }
        if (policy?.enabled && !policy.paused) {
          if (this.channel.partitions.size >= 64 && !this.channel.partitions.has(policy.partition_id)) {
            this.channel.partitions.delete(this.channel.partitions.keys().next().value!);
          }
          this.channel.partitions.set(policy.partition_id, policy.generation);
          this.channel.active = true;
        } else if (policy) this.channel.partitions.delete(policy.partition_id);
        if (message.retained) this.channel.active = true;
        discovery.resolve(message);
        if (!this.channel.active && this.channel.discoveries.size === 0) {
          this.channel.idle = setTimeout(() => {
            if (this.channel.closed || this.channel.failed || this.channel.active || this.channel.discoveries.size || this.channel.worker !== worker) return;
            this.channel.retiring = true;
            try { worker.postMessage({ type: "retire" }); } catch { failed(); }
          }, DIAGNOSTIC_LIMITS.probe_idle_ms);
          this.channel.idle.unref();
        }
      });
      worker.on("exit", () => {
        // Never open a replacement if bridge death left child liveness unknown.
        // Only its observed child close (including clean idle retirement) releases
        // the process-wide writer reservation; a timeout is not that evidence.
        if (!this.channel.retired && Atomics.load(this.channel.state, WORKER_COUNTER.closed) !== 1) registry.uncertainChild = true;
        if (registry.worker === worker) registry.worker = undefined;
        if (this.channel.worker !== worker) return;
        this.channel.worker = undefined;
        Atomics.store(this.channel.ready, 0, 0);
        if (this.channel.retiring && this.channel.retired && !this.channel.closed && !this.channel.failed) {
          this.channel.retiring = false; this.channel.retired = false;
          // A call arriving during retirement waits for actual child death before
          // opening a replacement; at most one writer exists across both bundles.
          if (this.channel.discoveries.size && this.start()) this.dispatchDiscoveries();
        } else {
          failed();
          for (const pending of this.channel.discoveries.values()) { clearTimeout(pending.timer); pending.resolve(undefined); }
          this.channel.discoveries.clear();
        }
      });
      // Keep bridge stdio private and unread. Reading refs Node's internal
      // stdio port, which Worker.unref() does not release. The writer child
      // uses ignored stdio; unexpected bridge output cannot reach business streams.
      worker.unref();
      return true;
    } catch { this.channel.failed = true; this.fail("worker"); return false; }
  }
  private lose(event: DiagnosticEvent, generation: number, failure: DiagnosticFailure): false {
    addDiagnosticLoss(this.channel.state); this.fail(failure);
    recordDiagnosticRecovery(this.channel.recovery, { event, generation }, failure, registry.processId, () => ++registry.sequence);
    return false;
  }
  emit(observation: DiagnosticObservation, context: DiagnosticContext): boolean {
    try {
      if (context.binding.runtime !== this || this.channel.closed || this.channel.failed || !this.channel.worker
        || this.channel.partitions.get(context.binding.partition_id) !== context.binding.generation || Atomics.load(this.channel.state, WORKER_COUNTER.closed) !== 0) return false;
      const projected = projectDiagnosticObservation(observation);
      if (!projected || registry.sequence >= Number.MAX_SAFE_INTEGER) { addDiagnosticLoss(this.channel.state); this.fail("invalid"); return false; }
      const state = this.channel.state;
      const event: DiagnosticEvent = {
        ...projected, schema_version: 1, event_id: diagnosticId(), source_id: context.binding.source_id,
        partition_id: context.binding.partition_id, process_id: registry.processId, sequence: ++registry.sequence,
        occurred_at: new Date().toISOString(), source: context.source, invocation_id: context.invocation_id,
        ...(context.parent_id && !projected.parent_id ? { parent_id: context.parent_id } : {}), ...(context.run_id ? { run_id: context.run_id } : {}),
        ...(context.turn_id ? { turn_id: context.turn_id } : {}), ...(context.task_id ? { task_id: context.task_id } : {}),
        ...(context.workflow_id ? { workflow_id: context.workflow_id } : {}),
        ...(context.operation_id && !projected.operation_id ? { operation_id: context.operation_id } : {}),
        ...(context.binding.descriptor_id ? { descriptor_id: context.binding.descriptor_id } : {}),
        ...(context.role && !projected.role ? { role: context.role, role_provenance: context.role_provenance ?? "client_reported" } : {}),
      };
      if (Atomics.load(state, WORKER_COUNTER.pending) >= DIAGNOSTIC_LIMITS.queue_events) return this.lose(event, context.binding.generation, "queue");
      const line = encodeDiagnosticEvent(event);
      if (!line) return this.lose(event, context.binding.generation, "invalid");
      const recovery = this.channel.recovery.entries().next().value;
      const recoveryLine = recovery ? encodeDiagnosticEvent(recovery[1].event) : undefined;
      const bytes = Buffer.byteLength(line) + 1 + (recoveryLine ? Buffer.byteLength(recoveryLine) + 1 : 0);
      if (Atomics.load(state, WORKER_COUNTER.bytes) + bytes > DIAGNOSTIC_LIMITS.queue_bytes || Atomics.load(state, WORKER_COUNTER.accepted) >= 0x7ffffffe) {
        return this.lose(event, context.binding.generation, "queue");
      }
      Atomics.add(state, WORKER_COUNTER.pending, 1); Atomics.add(state, WORKER_COUNTER.bytes, bytes); Atomics.add(state, WORKER_COUNTER.accepted, 1);
      try {
        this.channel.worker.postMessage({ event, generation: context.binding.generation, descriptor: this.descriptor, bytes,
          ...(recoveryLine && recovery ? { recovery: recovery[1] } : {}) });
        if (recovery) this.channel.recovery.delete(recovery[0]);
      }
      catch {
        Atomics.sub(state, WORKER_COUNTER.pending, 1); Atomics.sub(state, WORKER_COUNTER.bytes, bytes);
        return this.lose(event, context.binding.generation, "worker");
      }
      return true;
    } catch { addDiagnosticLoss(this.channel.state); this.fail("invalid"); return false; }
  }
  /** Terminal: stops admission and waits only on shared state, never main-loop callbacks. */
  drainSync(timeoutMs = DIAGNOSTIC_LIMITS.drain_ms): { acknowledged: number; dropped: number; pending: number } {
    const state = this.channel.state;
    this.channel.closed = true;
    this.channel.recovery.clear();
    clearTimeout(this.channel.idle);
    for (const discovery of this.channel.discoveries.values()) { clearTimeout(discovery.timer); discovery.resolve(undefined); }
    // Shared across ESM/CJS callers: repeated terminal hooks cannot renew the budget.
    const deadline = this.channel.terminalDeadline ??= performance.now() + Math.min(DIAGNOSTIC_LIMITS.drain_ms, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0));
    if (Atomics.compareExchange(state, WORKER_COUNTER.closed, 0, 2) === 0) {
      if (this.channel.worker) {
        try { this.channel.worker.postMessage({ type: "close" }); }
        catch { this.fail("worker"); }
      } else Atomics.store(state, WORKER_COUNTER.closed, 1);
    }
    // Only the bridge's observed child exit proves shutdown. Queue-empty alone
    // proves neither cold readiness nor completion of scheduled housekeeping.
    while (Atomics.load(state, WORKER_COUNTER.closed) !== 1 && this.channel.worker?.threadId !== -1) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) { this.fail("timeout"); break; }
      const signal = Atomics.load(state, WORKER_COUNTER.signal);
      if (Atomics.load(state, WORKER_COUNTER.closed) === 1) break;
      Atomics.wait(state, WORKER_COUNTER.signal, signal, remaining);
    }
    return { acknowledged: Atomics.load(state, WORKER_COUNTER.acknowledged), dropped: Atomics.load(state, WORKER_COUNTER.dropped), pending: Atomics.load(state, WORKER_COUNTER.pending) + Atomics.load(state, WORKER_COUNTER.maintenance) };
  }
  health(): DiagnosticHealth {
    const state = this.channel.state;
    return { accepted: Atomics.load(state, WORKER_COUNTER.accepted), acknowledged: Atomics.load(state, WORKER_COUNTER.acknowledged), dropped: Atomics.load(state, WORKER_COUNTER.dropped),
      pending: Atomics.load(state, WORKER_COUNTER.pending), queue_bytes: Atomics.load(state, WORKER_COUNTER.bytes), maintenance_pending: Atomics.load(state, WORKER_COUNTER.maintenance), ready: Atomics.load(this.channel.ready, 0) === 1, failure: this.configFailure ?? WORKER_FAILURES[Atomics.load(state, WORKER_COUNTER.failure)] };
  }
  async close(): Promise<void> {
    if (this.channel.closing) return this.channel.closing;
    if (!this.channel.closed) this.drainSync();
    const worker = this.channel.worker;
    if (!worker || worker.threadId === -1) return;
    this.channel.closing = new Promise<void>((resolve) => {
      const complete = () => { clearTimeout(timer); worker.off("exit", complete); resolve(); };
      const timer = setTimeout(() => {
        this.fail("timeout");
        // Bound the caller's wait, not the child-death observer's lifetime.
        // The unreferenced bridge owns the child watchdog and must remain alive
        // to settle reservations. Its exit handler alone releases writer ownership.
        complete();
      }, 2000);
      worker.once("exit", complete);
    });
    return this.channel.closing;
  }
}
export function createDiagnosticRuntime(config: DiagnosticRuntimeConfig): DiagnosticRuntime {
  let root: string;
  try {
    if ((config.hosted && config.root === undefined) || (config.descriptor && !validateDiagnosticDescriptor(config.descriptor))) return new DiagnosticRuntime(config);
    root = diagnosticRoot(config.root);
  } catch { return new DiagnosticRuntime(config); }
  const key = JSON.stringify([config.hosted === true, root, config.separateFrom, diagnosticProtectedRoots(), config.source, config.descriptor?.descriptor_id ?? "unknown"]);
  let runtime = registry.runtimes.get(key);
  if (!runtime || runtime.closed) {
    runtime = new DiagnosticRuntime(config); registry.runtimes.set(key, runtime);
    if (registry.runtimes.size > 64) registry.runtimes.delete(registry.runtimes.keys().next().value!);
  }
  return runtime;
}
