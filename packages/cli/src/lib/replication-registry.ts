import type { ReplicationControl } from "@tinycloud/node-sdk";

export type ReplicationCloseScheduler = (callback: () => void, delayMs: number) => NodeJS.Timeout;
type RegistryState = {
  controls: Map<string, ReplicationControl>;
  allControls: Set<ReplicationControl>;
  installedSignalHandlers: boolean;
  sigintHandler?: () => void;
  sigtermHandler?: () => void;
  closing?: Promise<void>;
};

const registryKey = Symbol.for("@tinycloud/cli/replication-registry");
const globalState = globalThis as typeof globalThis & { [registryKey]?: RegistryState };
const state: RegistryState = globalState[registryKey] ??= {
  controls: new Map<string, ReplicationControl>(),
  allControls: new Set<ReplicationControl>(),
  installedSignalHandlers: false,
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
  installSignalHandlers();
}

export function replicationForProfile(profile: string): ReplicationControl | undefined {
  return state.controls.get(profile);
}

export function registeredReplications(): ReadonlyMap<string, ReplicationControl> {
  return state.controls;
}

/** Drain all registered controllers once; a stalled controller cannot delay CLI exit beyond three seconds. */
export function closeReplication(schedule: ReplicationCloseScheduler = scheduleTimeout): Promise<void> {
  if (state.closing) return state.closing;
  removeSignalHandlers();
  const pending = [...state.allControls];
  state.controls.clear();
  state.allControls.clear();
  let timeout: NodeJS.Timeout;
  const bounded = new Promise<void>((resolve) => {
    timeout = schedule(resolve, CLOSE_TIMEOUT_MS);
  });
  state.closing = Promise.race([
    Promise.allSettled(pending.map((control) => Promise.resolve().then(() => control.close()))).then(() => undefined),
    bounded,
  ]).finally(() => {
    clearTimeout(timeout!);
    state.closing = undefined;
  });
  return state.closing;
}
