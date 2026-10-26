import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

/** Signals this process passes on to the running command. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
/** Signals a terminal sends to its whole foreground process group: Ctrl-C, Ctrl-\ and hangup. */
const TERMINAL_SIGNALS: Partial<Record<NodeJS.Signals, true>> = { SIGINT: true, SIGQUIT: true, SIGHUP: true };

/**
 * This process's group and its terminal's foreground group, read when a
 * signal arrives: from `/proc/self/stat` (Linux), else from `ps` (macOS, BSD)
 * with this process's own environment; none when both fail.
 */
function processGroups(): { group: number; foreground: number } | undefined {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    // After the parenthesised name: state, ppid, pgrp, session, tty_nr, tpgid, ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { group: Number(fields[2]), foreground: Number(fields[5]) };
  } catch {
    // No /proc: ask ps.
  }
  try {
    const columns = execFileSync("ps", ["-o", "pgid=,tpgid=", "-p", String(process.pid)], {
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim().split(/\s+/);
    return { group: Number(columns[0]), foreground: Number(columns[1]) };
  } catch {
    return undefined;
  }
}

/**
 * Whether this process belongs to its terminal's foreground process group.
 * The command shares that group, so a signal the terminal sends has reached
 * it already. False when the groups cannot be read, so the signal is passed on.
 */
function inTerminalForeground(): boolean {
  const groups = processGroups();
  return groups !== undefined && groups.foreground > 0 && groups.group === groups.foreground;
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
 * job, this process does not pass on SIGINT, SIGQUIT or SIGHUP: the
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
    child.on("error", (error: NodeJS.ErrnoException) => {
      // A started command reports through "exit"; a later error (a failed kill) changes nothing.
      if (child.pid === undefined) settle({ kind: "not_started", ...(error.code === undefined ? {} : { errno: error.code }) });
    });
    child.once("exit", (code, signal) => {
      settle(signal !== null ? { kind: "signaled", signal } : { kind: "exited", code: code ?? 1 });
    });
  });
}
