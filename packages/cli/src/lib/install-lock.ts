/**
 * The mutex every CLI install, switch and prune runs under (TC-4276).
 *
 * The lock is a directory of numbered generations, `<root>/.install-lock/<n>.json`, each naming its owner. The
 * newest generation is the lock. Acquiring creates generation n+1 with `wx`, so of any processes that race for the
 * same generation exactly one wins, and a process that read an old `n` fails on a file that already exists, or sees
 * a newer generation right after creating its own. Generations are never reused: the holder only prunes ones below
 * its predecessor.
 *
 * Generation n is free once it is released, its owner process is gone, its owner pid is this process's (a reused
 * pid) without this process holding it, or it is older than the hard age cap. A holder stops making changes
 * `HOLDER_MARGIN_MS` before the cap (`valid()`), so a holder past the cap never overlaps the process that takes over.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { processAlive } from "./versions.js";

export const LOCK_MAX_AGE_MS = 45 * 60 * 1000;
export const HOLDER_MARGIN_MS = 5 * 60 * 1000;
/** A generation file with no owner yet is one being written; it counts as held this long. */
const UNWRITTEN_GRACE_MS = 10_000;

interface Owner { pid: number; host: string; startedAt: number; token: string }

export interface InstallLock {
  readonly generation: number;
  /** True while this process still holds the lock and may change the install. */
  valid(): boolean;
  release(): void;
}

export interface LockOptions {
  now?: () => number;
  alive?: (pid: number) => boolean;
}

/** Tokens of the locks this process holds: an owner with this process's pid is only live if listed here. */
const heldTokens = new Set<string>();

export function acquireInstallLock(root: string, options: LockOptions = {}): InstallLock | null {
  const now = options.now ?? Date.now;
  const alive = options.alive ?? processAlive;
  const directory = join(root, ".install-lock");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const latest = latestGeneration(directory);
  if (latest > 0 && held(directory, latest, now(), alive)) return null;
  const generation = latest + 1;
  const owner: Owner = { pid: process.pid, host: hostname(), startedAt: now(), token: randomUUID() };
  try {
    writeFileSync(join(directory, `${generation}.json`), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  // A process that read an old generation can create a number the holder pruned; a newer generation means it lost.
  if (latestGeneration(directory) !== generation) {
    rmSync(join(directory, `${generation}.json`), { force: true });
    return null;
  }
  heldTokens.add(owner.token);
  for (const name of readdirSync(directory)) {
    const number = Number.parseInt(name, 10);
    if (Number.isSafeInteger(number) && number < generation - 1) rmSync(join(directory, name), { force: true });
  }
  return {
    generation,
    valid: () => heldTokens.has(owner.token) && now() - owner.startedAt < LOCK_MAX_AGE_MS - HOLDER_MARGIN_MS &&
      latestGeneration(directory) === generation && readOwner(directory, generation)?.token === owner.token,
    release: () => {
      if (!heldTokens.delete(owner.token)) return;
      try {
        writeFileSync(join(directory, `${generation}.released`), "", { flag: "wx", mode: 0o600 });
      } catch {
        // Already released, or pruned by a newer holder.
      }
    },
  };
}

function latestGeneration(directory: string): number {
  let latest = 0;
  for (const name of readdirSync(directory)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match) latest = Math.max(latest, Number(match[1]));
  }
  return latest;
}

function readOwner(directory: string, generation: number): Owner | null {
  try {
    const value = JSON.parse(readFileSync(join(directory, `${generation}.json`), "utf8")) as Partial<Owner>;
    if (typeof value.pid !== "number" || typeof value.host !== "string" || typeof value.startedAt !== "number" || typeof value.token !== "string") return null;
    return value as Owner;
  } catch {
    return null;
  }
}

function held(directory: string, generation: number, now: number, alive: (pid: number) => boolean): boolean {
  try {
    statSync(join(directory, `${generation}.released`));
    return false;
  } catch {
    // Not released.
  }
  const owner = readOwner(directory, generation);
  if (!owner) {
    try {
      return now - statSync(join(directory, `${generation}.json`)).mtimeMs < UNWRITTEN_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (now - owner.startedAt >= LOCK_MAX_AGE_MS) return false;
  // Another machine sharing this home: its pid means nothing here, so only the age cap frees it.
  if (owner.host !== hostname()) return true;
  if (owner.pid === process.pid) return heldTokens.has(owner.token);
  return alive(owner.pid);
}
