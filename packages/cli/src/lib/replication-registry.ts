import type { ReplicationControl } from "@tinycloud/node-sdk";

export type ReplicationCloseScheduler = (callback: () => void, delayMs: number) => NodeJS.Timeout;
type RegistryState = {
  controls: Map<string, ReplicationControl>;
  allControls: Set<ReplicationControl>;
  installedSignalHandlers: boolean;
  sigintHandler?: () => void;
  sigtermHandler?: () => void;
  closing?: Promise<boolean>;
  closeSettled?: Promise<void>;
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
  void closeReplication().then(
    () => waitForReplicationCloseSettlement(),
    () => waitForReplicationCloseSettlement(),
  ).finally(() => {
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

/** Drain registered controllers; the result has a three-second budget, but shutdown retains its lifetime until all closes settle. */
export function closeReplication(schedule: ReplicationCloseScheduler = scheduleTimeout): Promise<boolean> {
  if (state.closing) return state.closing;
  removeSignalHandlers();

  const closing = Promise.withResolvers<boolean>();
  const settled = Promise.withResolvers<void>();
  state.closing = closing.promise;
  state.closeSettled = settled.promise;

  void (async () => {
    let timeout: NodeJS.Timeout | undefined;
    const deadline = Promise.withResolvers<boolean>();
    const inflight = new Set<Promise<void>>();
    const startClose = (control: ReplicationControl): Promise<void> => {
      const job = Promise.resolve().then(() => control.close()).then(
        () => undefined,
        () => undefined,
      );
      inflight.add(job);
      void job.then(() => inflight.delete(job));
      return job;
    };
    const drainQueued = (): Promise<void>[] => {
      const pending = [...state.allControls];
      state.controls.clear();
      state.allControls.clear();
      return pending.map(startClose);
    };
    const settleRemaining = async (): Promise<void> => {
      while (inflight.size > 0 || state.allControls.size > 0) {
        if (state.allControls.size > 0) drainQueued();
        await Promise.all([...inflight]);
      }
    };

    try {
      timeout = schedule(() => deadline.resolve(true), CLOSE_TIMEOUT_MS);
      let timedOut = false;
      while (!timedOut) {
        while (state.allControls.size > 0) {
          const generation = state.generation;
          const drained = Promise.all(drainQueued()).then(() => false);
          timedOut ||= await Promise.race([drained, deadline.promise]);
          if (timedOut) break;
          if (state.generation === generation && state.allControls.size === 0) break;
        }

        if (timedOut) break;
        // Keep the shared close promise pending through this turn. A registration
        // arriving after a generation settles is picked up before shutdown resolves.
        const turn = Promise.withResolvers<boolean>();
        setImmediate(() => turn.resolve(false));
        timedOut ||= await Promise.race([turn.promise, deadline.promise]);
        if (!timedOut && state.allControls.size === 0) break;
      }

      if (timedOut) {
        drainQueued();
        closing.resolve(true);
        // The deadline is only a response deadline. A pinned profile path used
        // by an event sink must outlive every close, including queued controls.
        await settleRemaining();
      } else {
        closing.resolve(false);
      }
    } catch (error) {
      closing.reject(error);
      await settleRemaining();
    } finally {
      clearTimeout(timeout);
      state.closing = undefined;
      state.closeSettled = undefined;
      if (state.allControls.size === 0) removeSignalHandlers();
      settled.resolve();
    }
  })();

  return closing.promise;
}

/** Wait for actual close work, not just the bounded close result. */
export function waitForReplicationCloseSettlement(): Promise<void> {
  return state.closeSettled ?? Promise.resolve();
}
