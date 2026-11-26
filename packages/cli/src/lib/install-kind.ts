/**
 * Verified install kinds (TC-4276, Naomi's F1b). `detectInstallKind` guesses from path substrings; the self-update
 * acts only on an install whose real path is `@tinycloud/cli` in npm's global root (`npm root -g`) or in bun's global
 * directory. Anything else gets the notice only.
 *
 * `npm root -g` costs a process start, so the background job and `tinycloud upgrade` verify, and record the result
 * in `<versions root>/install.json` for the foreground's notice to read.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_PACKAGE, writeFileAtomic } from "./versions.js";

export type VerifiedInstallKind = "npm-global" | "bun-global";

export interface GlobalRoots {
  /** npm's global `node_modules` (`npm root -g`), or null when npm can't say. */
  npm(): Promise<string | null>;
  /** bun's global `node_modules`. */
  bun(): string;
}

/** bun's global directory: `BUN_INSTALL_GLOBAL_DIR`, else `$BUN_INSTALL/install/global` (default `~/.bun`). */
export function bunGlobalModules(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const globalDir = env.BUN_INSTALL_GLOBAL_DIR || join(env.BUN_INSTALL || join(home, ".bun"), "install", "global");
  return join(globalDir, "node_modules");
}

export async function verifyInstallKind(packageDir: string, roots: GlobalRoots): Promise<VerifiedInstallKind | null> {
  const actual = realpathOrNull(packageDir);
  if (!actual) return null;
  if (realpathOrNull(join(roots.bun(), CLI_PACKAGE)) === actual) return "bun-global";
  const npmRoot = await roots.npm();
  if (npmRoot && realpathOrNull(join(npmRoot, CLI_PACKAGE)) === actual) return "npm-global";
  return null;
}

/** Record what the last verification found for the install at `packageDir` (version `version`). */
export function recordInstallKind(root: string, packageDir: string, version: string, kind: VerifiedInstallKind | null): void {
  const actual = realpathOrNull(packageDir);
  if (!actual) return;
  try {
    writeFileAtomic(join(root, "install.json"), `${JSON.stringify({ packageDir: actual, version, kind })}\n`);
  } catch {
    // Best effort: without a record the notice keeps showing.
  }
}

/** The recorded verified kind of the install at `packageDir`, if the record is for this very install. */
export function recordedInstallKind(root: string, packageDir: string, version: string): VerifiedInstallKind | null {
  try {
    const record = JSON.parse(readFileSync(join(root, "install.json"), "utf8")) as { packageDir?: unknown; version?: unknown; kind?: unknown };
    if (record.version !== version || record.packageDir !== realpathOrNull(packageDir)) return null;
    return record.kind === "npm-global" || record.kind === "bun-global" ? record.kind : null;
  } catch {
    return null;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}
