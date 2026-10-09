import type { ReplicationControl } from "@tinycloud/node-sdk";

export type ReplicationCloseScheduler = (callback: () => void, delayMs: number) => NodeJS.Timeout;
type RegistryState = {
  controls: Map<string, ReplicationControl>;
  allControls: Set<ReplicationControl>;
  installedSignalHandlers: boolean;
  sigintHandler?: () => void;
  sigtermHandler?: () => void;
  closing?: Promise<boolean>;
  generation: number;
};

const registryKey = Symbol.for("@tinycloud/cli/replication-registry");
const globalState = globalThis as typeof globalThis & { [registryKey]?: RegistryState };
const state: RegistryState = globalState[registryKey] ??= {
  controls: new Map<string, ReplicationControl>(),
  allControls: new Set<ReplicationControl>(),
  installedSignalHandlers: false,
  generation: 0,
};
const CLOSE_TIMEOUT_MS = 3_000;
const scheduleTimeout: ReplicationCloseScheduler = (callback, delayMs) => setTimeout(callback, delayMs);

function stopForSignal(signal: "SIGINT" | "SIGTERM"): void {
  void closeReplication().finally(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

function installSignalHandlers(): void {
  if (state.installedSignalHandlers) return;
  state.installedSignalHandlers = true;
  state.sigintHandler = () => stopForSignal("SIGINT");
  state.sigtermHandler = () => stopForSignal("SIGTERM");
  process.once("SIGINT", state.sigintHandler);
  process.once("SIGTERM", state.sigtermHandler);
}

function removeSignalHandlers(): void {
  if (!state.installedSignalHandlers) return;
  state.installedSignalHandlers = false;
  if (state.sigintHandler) process.removeListener("SIGINT", state.sigintHandler);
  if (state.sigtermHandler) process.removeListener("SIGTERM", state.sigtermHandler);
  state.sigintHandler = undefined;
  state.sigtermHandler = undefined;
}

export function registerReplication(profile: string, control: ReplicationControl): void {
  state.controls.set(profile, control);
  state.allControls.add(control);
  state.generation += 1;
  installSignalHandlers();
}

export function replicationForProfile(profile: string): ReplicationControl | undefined {
  return state.controls.get(profile);
}

export function registeredReplications(): ReadonlyMap<string, ReplicationControl> {
  return state.controls;
}

/** Drain registered controllers; all generations share one three-second shutdown budget. */
export function closeReplication(schedule: ReplicationCloseScheduler = scheduleTimeout): Promise<boolean> {
  if (state.closing) return state.closing;
  removeSignalHandlers();
  state.closing = (async () => {
    let timedOut = false;
    let timeout!: NodeJS.Timeout;
    const bounded = new Promise<boolean>((resolve) => {
      timeout = schedule(() => resolve(true), CLOSE_TIMEOUT_MS);
    });
    try {
      while (state.allControls.size > 0) {
        const generation = state.generation;
        const pending = [...state.allControls];
        state.controls.clear();
        state.allControls.clear();
        const drained = Promise.allSettled(pending.map((control) => Promise.resolve().then(() => control.close())))
          .then(() => false);
        timedOut ||= await Promise.race([drained, bounded]);
        if (timedOut) {
          // Keep closing registrations made during the drain, but never wait beyond the shared deadline.
          for (const control of state.allControls) void Promise.resolve().then(() => control.close()).catch(() => undefined);
          state.controls.clear();
          state.allControls.clear();
          break;
        }
        // A registration in the drain's settlement microtask is another generation and must be drained.
        if (state.generation === generation && state.allControls.size === 0) break;
      }
      return timedOut;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    state.closing = undefined;
    if (state.allControls.size === 0) removeSignalHandlers();
  });
  return state.closing;
}
