import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

/** Signals this process passes on to the running command. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
/** Signals a terminal sends to its whole foreground process group: Ctrl-C, Ctrl-\ and hangup. */
const TERMINAL_SIGNALS: Partial<Record<NodeJS.Signals, true>> = { SIGINT: true, SIGQUIT: true, SIGHUP: true };

/**
 * Whether this process belongs to its terminal's foreground process group,
 * from `/proc/self/stat` (Linux). The command shares that group, so a signal
 * the terminal sends has reached it already. False where `/proc` is missing.
 */
function inTerminalForeground(): boolean {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    // After the parenthesised name: state, ppid, pgrp, session, tty_nr, tpgid, ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(fields[2]);
    const foreground = Number(fields[5]);
    return foreground > 0 && pgrp === foreground;
  } catch {
    return false;
  }
}

export type CommandOutcome =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: NodeJS.Signals }
  /** The command could not be started; `errno` is the spawn error's code (e.g. ENOENT, EACCES). */
  | { readonly kind: "not_started"; readonly errno?: string };

/**
 * Run `argv` directly from the array (no shell) with this process's stdio and
 * `env` as its whole environment. While it runs, SIGINT, SIGTERM, SIGHUP and
 * SIGQUIT sent to this process go to the command and do not end this
 * process; the command decides what they do. As its terminal's foreground
 * job (Linux), this process does not pass on SIGINT, SIGQUIT or SIGHUP: the
 * terminal sent them to the command too. Resolves once the command has
 * exited (or failed to start), with the forwarding removed.
 */
export function runCommand(argv: readonly [string, ...string[]], env: NodeJS.ProcessEnv): Promise<CommandOutcome> {
  // Executor form: the CLI supports Node 20, which lacks Promise.withResolvers.
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env, shell: false });
    } catch (error) {
      // An argument check failed before anything started. Its message can quote `env`, so only its code is kept.
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
      resolve({ kind: "not_started", ...(code === undefined ? {} : { errno: code }) });
      return;
    }
    const forward = (signal: NodeJS.Signals): void => {
      if (TERMINAL_SIGNALS[signal] && inTerminalForeground()) return;
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const settle = (outcome: CommandOutcome): void => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      resolve(outcome);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      // A started command reports through "exit"; a later error (a failed kill) changes nothing.
      if (child.pid === undefined) settle({ kind: "not_started", ...(error.code === undefined ? {} : { errno: error.code }) });
    });
    child.once("exit", (code, signal) => {
      settle(signal !== null ? { kind: "signaled", signal } : { kind: "exited", code: code ?? 1 });
    });
  });
}
