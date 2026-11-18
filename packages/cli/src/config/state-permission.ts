import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "./constants.js";

// TC-3278: a first-time install can fail because the owner's TinyCloud folder is not writable. The error names the
// folder and says why, and nothing has been changed. It carries no command and no advice: guidance comes from the
// CLI's own help, a little at a time, not from an error.

const REFUSALS = ["EACCES", "EPERM", "EROFS"];
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface StateFolderContext {
  /** The folder `.tinycloud` lives in: TC_HOME, else HOME or USERPROFILE. */
  home: string;
  platform: NodeJS.Platform;
  /** The current user's id on platforms that have one. */
  uid: number | undefined;
  /** The current user's name, when the environment has one. */
  user?: string | undefined;
  /** Whether a path exists; the real file system unless a test supplies one. */
  exists?: (file: string) => boolean;
  /** The name of the user with this id; the passwd file unless a test supplies one. */
  ownerOf?: (uid: number) => string;
}

export function stateFolderContext(): StateFolderContext {
  const home = process.env.TC_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const user = process.platform === "win32" ? process.env.USERNAME : (process.env.USER ?? process.env.LOGNAME);
  return { home, platform: process.platform, uid: process.getuid?.(), user };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

const shown = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, "?");

function realOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** The user that owns a folder, by name when the passwd file knows the id, else by id. */
function passwdOwner(uid: number): string {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields[2] === String(uid)) return fields[0] ?? `uid ${uid}`;
    }
  } catch {
    // No passwd file: report the id.
  }
  return `uid ${uid}`;
}

/** The nearest folder at or above `target` that exists: the one that refused the write. */
function refusing(target: string, api: path.PlatformPath, exists: (file: string) => boolean): string {
  let at = target;
  while (!exists(at) && api.dirname(at) !== at) at = api.dirname(at);
  return at;
}

/**
 * The CLIError for a permission refusal while creating or tightening `target`, or `error` unchanged when it is
 * anything else, so callers can `throw unwritableStateFolder(error, target)` from a catch block.
 */
export function unwritableStateFolder(error: unknown, target: string, context: StateFolderContext = stateFolderContext()): unknown {
  const code = errnoOf(error);
  if (code === undefined || !REFUSALS.includes(code)) return error;
  const windows = context.platform === "win32";
  const api = windows ? path.win32 : path;
  const folder = refusing(target, api, context.exists ?? existsSync);
  const fold = (file: string): string => (windows ? file.toLowerCase() : file);
  // Real paths (symlinks resolved), so a folder that links out of the home counts as outside it.
  const [resolvedFolder, resolvedHome] = [realOr(folder), realOr(context.home)];
  const relative = api.relative(fold(api.resolve(resolvedHome)), fold(api.resolve(resolvedFolder)));
  const isHome = relative === "";
  const inside = !isHome && !relative.startsWith("..") && !api.isAbsolute(relative);
  const who = context.user || "your user";
  const head = `The TinyCloud CLI can't write to its folder ${shown(folder)} (${code})`;
  const metadata = { path: shown(folder), errno: code };
  const refuse = (cause: string): CLIError => new CLIError("STATE_FOLDER_NOT_WRITABLE", `${head}: ${cause} Nothing was changed.`, ExitCode.ERROR, metadata);

  if (CONTROL.test(folder)) return refuse("its name has control characters.");
  if (!inside && !isHome) return refuse("it's outside the home folder.");
  if (windows) return refuse(`Windows user ${who} can't write to it.`);
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(folder);
  } catch {
    // The cause stays general when the folder cannot be inspected.
    return refuse(`${who} can't write to it.`);
  }
  const mode = (info.mode & 0o777).toString(8);
  if (info.uid === context.uid) return refuse(`it's read-only for ${who} (mode ${mode}), or the disk is read-only.`);
  if (isHome) return refuse("the home folder belongs to another user.");
  return refuse(`it belongs to another user (owner ${(context.ownerOf ?? passwdOwner)(info.uid)}, mode ${mode}).`);
}
