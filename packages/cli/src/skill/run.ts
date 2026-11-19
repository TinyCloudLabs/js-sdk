import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { CLIENT_NAMES, skillRoots, type SkillContext } from "./clients.js";
import { bundledSkillDir, readSkillFiles, refusingFolder, saveSkill, shownPath, SkillFolderBusy, SKILL_NAME, skillState, type SkillState } from "./bundle.js";

export interface SkillFolderResult {
  folder: string;
  state: SkillState;
}

export interface SkillCheck {
  skill: string;
  /** The state that matters most when several folders differ: changed, then outdated, then missing. */
  state: SkillState;
  folder: string;
  folders: SkillFolderResult[];
}

export interface SkillSaved {
  saved: string;
  version: string;
  folder: string;
  folders: string[];
  /** Folders that already held this exact skill. */
  unchanged: string[];
}

export interface SkillOptions {
  agent?: string | undefined;
  context: SkillContext;
  /** The folder the package ships the skill in; the CLI's own unless a test supplies one. */
  bundledDir?: string;
}

const list = (names: readonly string[]): string => `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

function targets(options: SkillOptions): { bundledDir: string; folders: string[] } {
  const roots = skillRoots(options.agent, options.context);
  if (roots === undefined) {
    throw new CLIError("INVALID_ARGUMENT", `Can't tell which agent this is. --agent takes ${list(CLIENT_NAMES)}.`, ExitCode.USAGE_ERROR);
  }
  return { bundledDir: options.bundledDir ?? bundledSkillDir(), folders: roots.map((root) => join(root, SKILL_NAME)) };
}

function cliVersion(bundledDir: string): string {
  const { version } = JSON.parse(readFileSync(join(dirname(dirname(bundledDir)), "package.json"), "utf8")) as { version?: unknown };
  return typeof version === "string" ? version : "unknown";
}

const PRIORITY: readonly SkillState[] = ["changed", "outdated", "missing", "current"];

/** `skill save --check`: what is in each skills folder compared with this CLI's skill. Writes nothing. */
export function checkSkill(options: SkillOptions): SkillCheck {
  const { bundledDir, folders } = targets(options);
  const bundled = readSkillFiles(bundledDir);
  if (bundled === undefined) throw new Error("This CLI's bundled skill is not a plain folder of files.");
  const results = folders.map((folder) => ({ folder, state: skillState(folder, bundled) }));
  const state = PRIORITY.find((candidate) => results.some((result) => result.state === candidate)) ?? "current";
  return { skill: SKILL_NAME, state, folder: results[0]!.folder, folders: results };
}

/** The refusal for a folder the user cannot write: which folder, and why. No command and no advice. */
function refusal(target: string, errno: string | undefined, saved: readonly string[]): CLIError {
  let why: string;
  let folder = dirname(target);
  try {
    const refusing = refusingFolder(target);
    folder = refusing.folder;
    why = process.platform === "win32"
      ? "this Windows user can't write to it"
      : refusing.ownedByUser ? `it's read-only for this user (mode ${refusing.mode})` : `it belongs to another user (mode ${refusing.mode})`;
  } catch {
    why = "this user can't write to it";
  }
  return new CLIError("SKILL_FOLDER_NOT_WRITABLE", `Can't write ${shownPath(folder)}: ${why}.`, ExitCode.ERROR, {
    path: shownPath(folder),
    ...(errno ? { errno } : {}),
    ...(saved.length > 0 ? { saved: saved.map(shownPath) } : {}),
  });
}

export function unwritableFolder(error: unknown, target: string, saved: readonly string[] = []): CLIError | undefined {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") return undefined;
  return refusal(target, code, saved);
}

/** A folder (or the nearest one above it) that another user owns is refused before anything is written, wherever the path came from. */
function foreignFolder(target: string): CLIError | undefined {
  if (process.platform === "win32") return undefined;
  try {
    if (refusingFolder(target).ownedByUser) return undefined;
  } catch {
    return undefined;
  }
  return refusal(target, undefined, []);
}

/**
 * `skill save`: copy the skill this CLI ships into each client's skills folder. A folder holding files TinyCloud did not
 * write is never touched, and nothing is written if any folder is in that state.
 */
export function saveBundledSkill(options: SkillOptions): SkillSaved {
  const { bundledDir, folders } = targets(options);
  const bundled = readSkillFiles(bundledDir);
  if (bundled === undefined) throw new Error("This CLI's bundled skill is not a plain folder of files.");
  const states = folders.map((folder) => ({ folder, state: skillState(folder, bundled) }));
  const changed = states.find((entry) => entry.state === "changed");
  if (changed) {
    throw new CLIError(
      "SKILL_FOLDER_CHANGED",
      `${shownPath(changed.folder)} has files TinyCloud didn't write, so nothing was replaced.`,
      ExitCode.ERROR,
      { path: shownPath(changed.folder) },
    );
  }
  for (const entry of states) {
    if (entry.state === "current") continue;
    const foreign = foreignFolder(entry.folder);
    if (foreign) throw foreign;
  }
  const version = cliVersion(bundledDir);
  const saved: string[] = [];
  for (const entry of states) {
    if (entry.state === "current") continue;
    try {
      saveSkill(entry.folder, bundledDir, bundled, version);
      saved.push(entry.folder);
    } catch (error) {
      if (error instanceof SkillFolderBusy) {
        throw new CLIError("SKILL_FOLDER_BUSY", `Another save is writing ${shownPath(dirname(entry.folder))}.`, ExitCode.ERROR, {
          path: shownPath(dirname(entry.folder)),
          ...(saved.length > 0 ? { saved: saved.map(shownPath) } : {}),
        });
      }
      const unwritable = unwritableFolder(error, entry.folder, saved);
      if (unwritable) throw unwritable;
      if (saved.length === 0) throw error;
      throw new CLIError("SKILL_SAVE_FAILED", `Couldn't write ${shownPath(entry.folder)}.`, ExitCode.ERROR, { path: shownPath(entry.folder), saved: saved.map(shownPath) });
    }
  }
  return {
    saved: SKILL_NAME,
    version,
    folder: folders[0]!,
    folders,
    unchanged: states.filter((entry) => entry.state === "current").map((entry) => entry.folder),
  };
}
