/**
 * The versioned install layout (TC-4276). Kept free of non-builtin imports: the global launcher loads it before any
 * version of the CLI is chosen.
 *
 *   <root>/current.json                     pointer {version, base, auto, pinned, previous?}: replaced by rename only
 *   <root>/<X.Y.Z>/node_modules/@tinycloud/cli/   an npm --prefix install of exactly that version, never rewritten
 *   <root>/<X.Y.Z>/.verified                written last, after provenance and the smoke test passed
 *   <root>/.leases/<pid>.json               {pid, version, courier}: a process that may still use <version>
 *
 * The root is `TC_VERSIONS_DIR`, else `~/.tinycloud/versions` under the real home (not TC_HOME: the binary is per user).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
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

/** Record that this process may use `version` until it exits. Returns the release function. */
export function writeLease(root: string, lease: Omit<Lease, "pid">): () => void {
  const file = join(root, ".leases", `${process.pid}.json`);
  try {
    writeFileAtomic(file, JSON.stringify({ pid: process.pid, ...lease }));
  } catch {
    return () => undefined;
  }
  const release = () => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  return release;
}

/** Leases whose process still exists. Leases of exited processes are removed. A reused pid only keeps a version longer. */
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
      if (!alive(value.pid)) {
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

/** Installed version directories, newest naming not implied. */
export function installedVersions(root: string): string[] {
  try {
    return readdirSync(root).filter(isVersion);
  } catch {
    return [];
  }
}
