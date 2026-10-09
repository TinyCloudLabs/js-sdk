import type { ReplicationControl } from "@tinycloud/node-sdk";

const controls = new Map<string, ReplicationControl>();
const allControls = new Set<ReplicationControl>();
let installedSignalHandlers = false;
let closing: Promise<void> | undefined;

function stopForSignal(signal: "SIGINT" | "SIGTERM"): void {
  void closeReplication().finally(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

function installSignalHandlers(): void {
  if (installedSignalHandlers) return;
  installedSignalHandlers = true;
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);
}

function removeSignalHandlers(): void {
  if (!installedSignalHandlers) return;
  installedSignalHandlers = false;
  process.removeListener("SIGINT", sigintHandler);
  process.removeListener("SIGTERM", sigtermHandler);
}

function sigintHandler(): void { stopForSignal("SIGINT"); }
function sigtermHandler(): void { stopForSignal("SIGTERM"); }

export function registerReplication(profile: string, control: ReplicationControl): void {
  controls.set(profile, control);
  allControls.add(control);
  installSignalHandlers();
}

export function replicationForProfile(profile: string): ReplicationControl | undefined {
  return controls.get(profile);
}

export function registeredReplications(): ReadonlyMap<string, ReplicationControl> {
  return controls;
}

/** Drain all registered controllers before CLI termination. */
export function closeReplication(): Promise<void> {
  if (closing) return closing;
  removeSignalHandlers();
  const pending = [...allControls];
  controls.clear();
  allControls.clear();
  closing = Promise.allSettled(pending.map((control) => control.close())).then(() => undefined).finally(() => {
    closing = undefined;
  });
  return closing;
}
