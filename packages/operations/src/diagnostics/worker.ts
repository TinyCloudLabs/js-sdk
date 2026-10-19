import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type * as DiagnosticFilesystem from "./filesystem.js";
import type * as DiagnosticControl from "./control.js";
import { diagnosticId, isDiagnosticId } from "./model.js";
import type { DiagnosticWrite } from "./storage.js";
import type * as DiagnosticStorage from "./storage.js";
import type { DiagnosticPolicy, WORKER_COUNTER } from "./control.js";
import type { DiagnosticFailure } from "./filesystem.js";

export interface DiagnosticWorkerConfiguration {
  root: string;
  hosted: boolean;
  separateFrom?: string;
  protectedRoots: readonly [string, string];
  entry: string;
  state: SharedArrayBuffer;
  ready: SharedArrayBuffer;
  counters: typeof WORKER_COUNTER;
  failures: readonly (DiagnosticFailure | undefined)[];
  limits: { batch_events: number; sweep_ms: number };
}
interface PendingEvent extends DiagnosticWrite { bytes: number; recovery?: DiagnosticWrite }
export interface DiagnosticDiscoveryRequest {
  type: "discover"; key: string; kind: "policy" | "tenant" | "maintenance";
  partitionId?: string; verifiedTenantId?: string;
}
export interface DiagnosticDiscoveryResult {
  type: "discovered"; key: string; policy?: DiagnosticPolicy; retained?: boolean; failure?: DiagnosticFailure;
}
export type DiagnosticWorkerReply = DiagnosticDiscoveryResult | { type: "retired" } | { type: "closed" };
interface WriterConfiguration {
  type: "configure"; root: string; hosted: boolean; separateFrom?: string;
  terminal: boolean; batchEvents: number; sweepMs: number;
}
type ProducerMessage = PendingEvent | DiagnosticDiscoveryRequest | { type: "close" } | { type: "retire" } | { type: "abort" };
type WriterReply =
  | DiagnosticDiscoveryResult
  | { type: "ready" }
  | { type: "settled"; count: number; bytes: number; acknowledged: number; failure?: DiagnosticFailure }
  | { type: "maintenance"; active: boolean; failure?: DiagnosticFailure }
  | { type: "failed"; failure: DiagnosticFailure };
// Diagnostic-only cleanup never extends the producer's bounded terminal wait.
const CLOSE_GRACE_MS = 2000;

/** The SAB bridge performs no filesystem work and never initializes storage helpers. */
function bridge(configuration: DiagnosticWorkerConfiguration): void {
  const port = parentPort!;
  const state = new Int32Array(configuration.state);
  const ready = new Int32Array(configuration.ready);
  const counter = configuration.counters;
  const notify = () => { Atomics.add(state, counter.signal, 1); Atomics.notify(state, counter.signal); };
  const fail = (failure: DiagnosticFailure) => { Atomics.store(state, counter.failure, configuration.failures.indexOf(failure)); notify(); };
  const lose = (count: number) => {
    let previous = Atomics.load(state, counter.dropped);
    for (;;) {
      const actual = Atomics.compareExchange(state, counter.dropped, previous, Math.min(0x7fffffff, previous + count));
      if (actual === previous) return;
      previous = actual;
    }
  };
  // process.exit() forcibly stops in-process Workers. Node 20 can abort when that
  // interrupts FSReqPromise::New. Only this separate process may execute storage.
  // Only resolved protection paths cross the boundary, never the producer's credentials/environment.
  const child = fork(configuration.entry, [], {
    execArgv: [], env: { TC_HOME: dirname(configuration.protectedRoots[0]), TC_APPS_STATE: configuration.protectedRoots[1] },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let stopping = false;
  let exited = false;
  let retiring = false;
  const discoveries = new Set<string>();
  let watchdog: NodeJS.Timeout | undefined;
  function stop(retire = false): void {
    if (exited) return;
    if (!retire) { retiring = false; Atomics.compareExchange(state, counter.closed, 0, 2); }
    if (stopping) return;
    stopping = true; retiring = retire;
    watchdog = setTimeout(() => { fail("timeout"); child.kill("SIGKILL"); }, CLOSE_GRACE_MS);
  }
  function send(message: ProducerMessage | WriterConfiguration): void {
    if (exited) return;
    try {
      child.send(message, (error) => {
        if (!error) return;
        fail("worker"); stop();
        if (child.connected) child.disconnect();
      });
    } catch {
      fail("worker"); stop();
      if (child.connected) child.disconnect();
    }
  }
  child.on("error", () => { fail("worker"); stop(); });
  child.on("message", (message: WriterReply) => {
    if (message.type === "ready") { if (!stopping) Atomics.store(ready, 0, 1); }
    else if (message.type === "discovered") {
      discoveries.delete(message.key);
      if (!stopping) port.postMessage(message);
    } else if (message.type === "settled") {
      // The child reports a batch only after appendDiagnosticBatch releases its lock.
      Atomics.add(state, counter.acknowledged, message.acknowledged);
      lose(message.count - message.acknowledged);
      Atomics.sub(state, counter.bytes, message.bytes);
      Atomics.sub(state, counter.pending, message.count);
      if (message.failure) fail(message.failure);
    } else if (message.type === "maintenance") {
      Atomics.store(state, counter.maintenance, message.active ? 1 : 0);
      if (message.failure) fail(message.failure);
    } else if (message.type === "failed") fail(message.failure);
    notify();
  });
  // 'close', not merely 'exit': consume the final IPC acknowledgments first.
  child.once("close", (code, signal) => {
    exited = true; clearTimeout(watchdog);
    if (!stopping || code !== 0 || signal !== null) fail("worker");
    // Only confirmed child death permits retiring unacknowledged reservations.
    lose(Atomics.exchange(state, counter.pending, 0));
    Atomics.store(state, counter.bytes, 0); Atomics.store(state, counter.maintenance, 0);
    Atomics.store(ready, 0, 0);
    if (retiring && code === 0 && signal === null) port.postMessage({ type: "retired" } satisfies DiagnosticWorkerReply);
    else {
      Atomics.store(state, counter.closed, 1);
      port.postMessage({ type: "closed" } satisfies DiagnosticWorkerReply);
    }
    notify();
    port.close();
  });
  port.on("message", (message: ProducerMessage) => {
    if ("type" in message) {
      if (message.type === "discover") {
        if (stopping || discoveries.has(message.key)) return;
        if (discoveries.size >= 64) {
          port.postMessage({ type: "discovered", key: message.key, failure: "quota" } satisfies DiagnosticDiscoveryResult);
          return;
        }
        discoveries.add(message.key); send(message);
      } else {
        stop(message.type === "retire"); send({ type: "close" });
      }
    } else if (!stopping) send(message);
  });
  port.on("close", () => {
    stop();
    if (child.connected) child.disconnect();
  });
  send({ type: "configure", root: configuration.root, hosted: configuration.hosted, separateFrom: configuration.separateFrom,
    terminal: Atomics.load(state, counter.closed) !== 0,
    batchEvents: configuration.limits.batch_events, sweepMs: configuration.limits.sweep_ms });
}

/** One producer-owned file writer; IPC loss closes it, never leaves a collector. */
function writer(): void {
  if (!process.connected) return;
  const queue: PendingEvent[] = [];
  const discoveries: DiagnosticDiscoveryRequest[] = [];
  const recovery = new Map<string, DiagnosticWrite>();
  const recoveryProcessId = diagnosticId();
  let recoverySequence = 0;
  let configuration: WriterConfiguration | undefined;
  let storage: typeof DiagnosticStorage | undefined;
  let filesystem: typeof DiagnosticFilesystem | undefined;
  let control: typeof DiagnosticControl | undefined;
  let running = false;
  let stopping = false;
  let finished = false;
  let maintenancePending = false;
  let active = false;
  let cursor = 0;
  let sweep: NodeJS.Timeout | undefined;
  let flush: NodeJS.Immediate | undefined;
  // SIGKILL also bounds a hung filesystem threadpool; process.exit() would join it.
  const abandon = () => { process.kill(process.pid, "SIGKILL"); };
  // Covers a bridge lost during cold startup as well as an abandoned/hung sink.
  let watchdog: NodeJS.Timeout | undefined = setTimeout(abandon, CLOSE_GRACE_MS);
  function reply(message: WriterReply): void {
    if (!process.connected) return;
    try { process.send!(message, (error: Error | null) => { if (error) stop(); }); }
    catch { stop(); }
  }
  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog); clearInterval(sweep); clearImmediate(flush);
    // disconnect flushes already-submitted acknowledgments. Natural exit then
    // closes the child, rather than interrupting a successful storage operation.
    if (process.connected) process.disconnect();
  }
  function stop(): void {
    if (stopping || finished) return;
    stopping = true; maintenancePending = false; discoveries.length = 0; clearInterval(sweep);
    clearTimeout(watchdog);
    watchdog = setTimeout(abandon, CLOSE_GRACE_MS);
    schedule();
  }
  function schedule(): void {
    if (!flush && !running && !finished) flush = setImmediate(() => { flush = undefined; void pump(); });
  }
  async function discover(request: DiagnosticDiscoveryRequest): Promise<void> {
    const config = configuration!;
    const files = filesystem!;
    const controls = control!;
    const result: DiagnosticDiscoveryResult = { type: "discovered", key: request.key };
    try {
      await controls.validateDiagnosticRoot(config.root, config.separateFrom);
      if (request.kind === "maintenance") {
        if (!config.hosted) throw new files.DiagnosticError("invalid");
        result.retained = await files.withPrivateDirectory(config.root, false, async (directory) => {
          for (const name of ["partitions", "imports", "cases", "exports"]) {
            const base = join(directory.path, name);
            if (!await files.privateDirectoryExists(base)) continue;
            for (const partition of await files.privateEntries(base, controls.DIAGNOSTIC_LIMITS.partitions)) {
              if (!isDiagnosticId(partition)) continue;
              const path = join(base, partition);
              if (await files.privateDirectoryExists(path) && (await files.privateEntries(path)).length > 0) return true;
            }
          }
          return false;
        });
      } else {
        const partition = request.kind === "tenant"
          ? await controls.resolveDiagnosticTenant(config.root, request.verifiedTenantId!, { create: false })
          : request.partitionId;
        if (request.kind !== "tenant" || partition !== undefined) {
          result.policy = await files.withPrivateDirectory(config.root, false, (directory) => controls.readPolicy(directory, partition));
        }
      }
    } catch (error) {
      if (!files.isMissing(error)) result.failure = files.diagnosticFailure(error);
    }
    if (!stopping && !active && ((result.policy?.enabled && !result.policy.paused) || result.retained)) {
      active = true;
      reply({ type: "ready" });
      if (config.hosted) {
        maintenancePending = true;
        sweep = setInterval(() => { maintenancePending = true; schedule(); }, config.sweepMs);
        sweep.unref();
      }
    }
    reply(result);
  }
  async function pump(): Promise<void> {
    if (running || finished || !storage || !configuration || !filesystem || !control) return;
    running = true;
    try {
      while (queue.length || (!stopping && (discoveries.length || maintenancePending))) {
        const discovery = !stopping ? discoveries.shift() : undefined;
        if (discovery) await discover(discovery);
        if (queue.length) {
          const batch = queue.splice(0, configuration.batchEvents);
          let acknowledged = 0; let failure: DiagnosticFailure | undefined;
          try {
            const results = await storage.appendDiagnosticBatch(configuration.root, batch);
            for (let index = 0; index < batch.length; index++) {
              const result = results[index];
              if (result) {
                failure = result;
                control.recordDiagnosticRecovery(recovery, batch[index], result, recoveryProcessId, () => ++recoverySequence);
              } else acknowledged++;
            }
          } catch (error) {
            failure = filesystem.diagnosticFailure(error);
            for (const item of batch) control.recordDiagnosticRecovery(recovery, item, failure, recoveryProcessId, () => ++recoverySequence);
          }
          // One bounded health batch only after observed business-sink recovery.
          // Its writes keep their original generation; deletion/pause therefore
          // rejects stale health exactly like stale business events. A failed
          // report is discarded, not retried or counted as another lost event:
          // uncertain persistence must never amplify health or double its count.
          // Internal health records are excluded from producer accepted/ack totals.
          if (acknowledged && recovery.size) {
            const reports: DiagnosticWrite[] = [];
            for (const [key, report] of recovery) {
              recovery.delete(key); reports.push(report);
              if (reports.length >= configuration.batchEvents) break;
            }
            try {
              const results = await storage.appendDiagnosticBatch(configuration.root, reports);
              for (const result of results) if (result) failure = result;
            } catch (error) { failure = filesystem.diagnosticFailure(error); }
          }
          let bytes = 0; for (const event of batch) bytes += event.bytes;
          reply({ type: "settled", count: batch.length, bytes, acknowledged, failure });
        } else if (maintenancePending && !stopping && !discoveries.length) {
          maintenancePending = false;
          reply({ type: "maintenance", active: true });
          let failure: DiagnosticFailure | undefined;
          try {
            const result = await storage.sweepDiagnosticRoot(configuration.root, cursor);
            cursor = result.cursor; failure = result.failure;
          } catch (error) { failure = filesystem.diagnosticFailure(error); }
          reply({ type: "maintenance", active: false, failure });
        }
      }
    } finally {
      running = false;
      if (stopping) finish();
    }
  }
  process.on("disconnect", stop);
  // Group signals must not require the producer to wait for this private helper.
  // The child alone attempts lock-releasing cleanup under its existing watchdog.
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.on("message", (message: ProducerMessage | WriterConfiguration) => {
    if ("type" in message) {
      if (message.type === "close" || message.type === "retire" || message.type === "abort") { stop(); return; }
      if (message.type === "discover") {
        if (!stopping && !finished) {
          if (discoveries.length >= 64) reply({ type: "discovered", key: message.key, failure: "quota" });
          else { discoveries.push(message); schedule(); }
        }
        return;
      }
      if (configuration || stopping || finished) return;
      configuration = message;
      clearTimeout(watchdog);
      // Static imports would initialize filesystem/storage code in the bridge.
      // This process boundary requires child-only dynamic module initialization.
      void Promise.all([import("./storage.js"), import("./filesystem.js"), import("./control.js")]).then(([loaded, files, controls]) => {
        storage = loaded; filesystem = files; control = controls;
        if (configuration!.terminal) stop();
        schedule();
      }, () => { reply({ type: "failed", failure: "worker" }); finish(); });
      return;
    }
    // All hops share the producer's bounded event/byte outstanding reservation.
    if (!stopping && !finished) {
      // Piggyback bytes are covered by the producer reservation; retained
      // summaries have a separate fixed 64-entry cap and no raw observations.
      if (message.recovery && control && recovery.size < control.DIAGNOSTIC_LIMITS.recovery_entries) {
        recovery.set(`producer:${message.recovery.event.event_id}`, message.recovery);
      }
      delete message.recovery;
      queue.push(message); schedule();
    }
  });
}

if (isMainThread) {
  if (typeof process.send === "function") writer();
} else {
  const configuration = workerData as DiagnosticWorkerConfiguration;
  if (parentPort && configuration?.state instanceof SharedArrayBuffer && configuration.state.byteLength === 9 * Int32Array.BYTES_PER_ELEMENT
    && configuration.ready instanceof SharedArrayBuffer && configuration.ready.byteLength === Int32Array.BYTES_PER_ELEMENT) bridge(configuration);
}
