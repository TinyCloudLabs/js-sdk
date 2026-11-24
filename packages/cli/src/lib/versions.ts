/**
 * The versioned install layout (TC-4276). Kept free of non-builtin imports: the global launcher loads it before any
 * version of the CLI is chosen.
 *
 *   <root>/current.json                     pointer {version, base, auto, pinned, previous?}: replaced by rename only
 *   <root>/<X.Y.Z>/node_modules/@tinycloud/cli/   an npm --prefix install of exactly that version, never rewritten
 *   <root>/<X.Y.Z>/.verified                written last, after provenance and the smoke test passed; the launcher
 *                                           deletes it when that version fails to load, so no run chooses it again
 *   <root>/.leases/<pid>.json               {pid, version, courier, start}: a process that may still use <version>
 *
 * The root is `TC_VERSIONS_DIR`, else `~/.tinycloud/versions` under the real home (not TC_HOME: the binary is per user).
 */
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const CLI_PACKAGE = "@tinycloud/cli";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export interface Pointer {
  version: string;
  /** The version of the global package that wrote this pointer. A different global version means a manual reinstall won. */
  base: string;
  /** Installed by the background updater; only these follow a channel tag down. */
  auto: boolean;
  /** Set by `upgrade --to`; the background updater leaves a pinned install alone. */
  pinned: boolean;
  previous?: string;
}

export interface Lease { pid: number; version: string; courier: boolean }

/** What the global launcher hands to the version it runs. */
export interface LaunchContext { basePackageDir: string; baseVersion: string; root: string }

const LAUNCH_CONTEXT = Symbol.for("tinycloud.cli.launchContext");

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

export function versionsRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.TC_VERSIONS_DIR ? resolve(env.TC_VERSIONS_DIR) : join(home, ".tinycloud", "versions");
}

export function versionPackageDir(root: string, version: string): string {
  return join(root, version, "node_modules", "@tinycloud", "cli");
}

export function readPackageVersion(packageDir: string): string | null {
  try {
    const { name, version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return name === CLI_PACKAGE && isVersion(version) ? version : null;
  } catch {
    return null;
  }
}

export function readPointer(root: string): Pointer | null {
  try {
    const value = JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as Record<string, unknown>;
    if (!isVersion(value.version) || !isVersion(value.base) || typeof value.auto !== "boolean" || typeof value.pinned !== "boolean") return null;
    if (value.previous !== undefined && !isVersion(value.previous)) return null;
    return { version: value.version, base: value.base, auto: value.auto, pinned: value.pinned, ...(value.previous ? { previous: value.previous } : {}) };
  } catch {
    return null;
  }
}

/** Write `file` whole or not at all: a reader sees the old or the new content, never a mix. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writePointer(root: string, pointer: Pointer): void {
  writeFileAtomic(join(root, "current.json"), `${JSON.stringify(pointer)}\n`);
}

export function removePointer(root: string): void {
  rmSync(join(root, "current.json"), { force: true });
}

export function isVerified(root: string, version: string): boolean {
  if (!isVersion(version) || readPackageVersion(versionPackageDir(root, version)) !== version) return false;
  try {
    return (JSON.parse(readFileSync(join(root, version, ".verified"), "utf8")) as { version?: unknown }).version === version;
  } catch {
    return false;
  }
}

export function markVerified(directory: string, version: string, integrity: string): void {
  writeFileAtomic(join(directory, ".verified"), `${JSON.stringify({ version, integrity })}\n`);
}

export function isWithin(parent: string, child: string): boolean {
  const realParent = realpathOr(parent);
  const realChild = realpathOr(child);
  return realChild.startsWith(realParent.endsWith(sep) ? realParent : `${realParent}${sep}`);
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The version the global install at `basePackageDir` runs: the pointer's when it is valid for this global install,
 * else its own. A copy inside the versions root always runs itself, so a staged version can be smoke-tested alone.
 */
export function activeVersion(root: string, basePackageDir: string, baseVersion: string): { version: string; packageDir: string } {
  const own = { version: baseVersion, packageDir: basePackageDir };
  if (isWithin(root, basePackageDir)) return own;
  const pointer = readPointer(root);
  if (!pointer || pointer.base !== baseVersion || pointer.version === baseVersion || !isVerified(root, pointer.version)) return own;
  return { version: pointer.version, packageDir: versionPackageDir(root, pointer.version) };
}

export function setLaunchContext(context: LaunchContext): void {
  (globalThis as { [LAUNCH_CONTEXT]?: LaunchContext })[LAUNCH_CONTEXT] = context;
}

export function launchContext(): LaunchContext | undefined {
  return (globalThis as { [LAUNCH_CONTEXT]?: LaunchContext })[LAUNCH_CONTEXT];
}

/**
 * A lease not rewritten for this long is stale whatever its pid says: the bound on a reused pid when the start time
 * can't be read (Windows) or wasn't recorded. A holder renews its lease well inside it, so a long-running Courier keeps it.
 */
export const LEASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LEASE_RENEW_MS = 60 * 60 * 1000;
/** `ps` reports start times to the second, and Node's clock starts a little after the process does. */
const START_SLACK_MS = 5000;

/** Record that this process may use `version` until it exits. Returns the release function. */
export function writeLease(root: string, lease: Omit<Lease, "pid">): () => void {
  const file = join(root, ".leases", `${process.pid}.json`);
  const content = JSON.stringify({ pid: process.pid, ...lease, start: processStartTime(process.pid) });
  try {
    writeFileAtomic(file, content);
  } catch {
    return () => undefined;
  }
  const renew = setInterval(() => {
    try {
      writeFileAtomic(file, content);
    } catch {
      // Retried on the next tick; the lease only goes stale after a day without one.
    }
  }, LEASE_RENEW_MS);
  renew.unref();
  const release = () => {
    clearInterval(renew);
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  return release;
}

/**
 * Leases of processes that still run. A lease is stale, and removed, once its pid is dead, its pid now belongs to a
 * process started at another time than the one recorded, or it has gone unrenewed for {@link LEASE_MAX_AGE_MS}.
 */
export function liveLeases(root: string, alive: (pid: number) => boolean = processAlive): Lease[] {
  const directory = join(root, ".leases");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const leases: Lease[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = join(directory, name);
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || !isVersion(value.version)) continue;
      if (!alive(value.pid) || Date.now() - statSync(file).mtimeMs > LEASE_MAX_AGE_MS || startChanged(value.start, value.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      leases.push({ pid: value.pid, version: value.version, courier: value.courier === true });
    } catch {
      // A lease being written right now; it is read on the next pass.
    }
  }
  return leases;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When `pid` started, as a token to compare with a later reading, or null when it can't be read (Windows, no /proc or
 * `ps`). Linux: the boot id and the start time in clock ticks since boot. Elsewhere `@<epoch ms>`, from `ps`.
 */
export function processStartTime(pid: number): string | null {
  if (process.platform === "win32") return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22; the fields after the parenthesised command name start at field 3.
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
      return /^\d+$/.test(ticks) ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}` : null;
    } catch {
      return null;
    }
  }
  // This process's own start needs no `ps`: every versioned run writes a lease, and a spawn costs more than the launch.
  if (pid === process.pid) return `@${Math.round(performance.timeOrigin)}`;
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const started = ps.status === 0 ? Date.parse(`${ps.stdout.trim()} UTC`) : Number.NaN;
  return Number.isFinite(started) ? `@${started}` : null;
}

/** Whether `pid` now belongs to a process started at another time than `recorded`; false when either is unknown. */
function startChanged(recorded: unknown, pid: number): boolean {
  if (typeof recorded !== "string") return false;
  const current = processStartTime(pid);
  if (current === null) return false;
  if (recorded.startsWith("@") && current.startsWith("@")) return Math.abs(Number(recorded.slice(1)) - Number(current.slice(1))) > START_SLACK_MS;
  return recorded !== current;
}

/** Installed version directories, newest naming not implied. */
export function installedVersions(root: string): string[] {
  try {
    return readdirSync(root).filter(isVersion);
  } catch {
    return [];
  }
}
