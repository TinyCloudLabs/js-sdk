import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "./constants.js";

// TC-3278: a first-time install can fail because the owner's TinyCloud folder is not writable. The error names
// the folder, the cause and the exact fix, and nothing has been changed. The fix is for the owner to run, never
// an agent; it is printed only for a folder inside the owner's home (the home folder itself gets chmod only).

const REFUSALS = ["EACCES", "EPERM", "EROFS"];
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface StateFolderContext {
  /** The folder `.tinycloud` lives in: TC_HOME, else HOME or USERPROFILE. */
  home: string;
  platform: NodeJS.Platform;
  /** The current user's id on platforms that have one. */
  uid: number | undefined;
  /** Whether a path exists; the real file system unless a test supplies one. */
  exists?: (file: string) => boolean;
}

export function stateFolderContext(): StateFolderContext {
  const home = process.env.TC_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return { home, platform: process.platform, uid: process.getuid?.() };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

const shown = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, "?");
// Single quotes keep `$`, backticks, `!` and `(` literal when the owner pastes the line into a shell.
const posixQuoted = (folder: string): string => `'${folder.replace(/'/g, "'\\''")}'`;
const powershellQuoted = (folder: string): string => `'${folder.replace(/'/g, "''")}'`;

function realOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
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
  // Real paths (symlinks resolved), so a folder that links out of the home gets no command.
  const [resolvedFolder, resolvedHome] = windows ? [folder, context.home] : [realOr(folder), realOr(context.home)];
  const relative = api.relative(fold(api.resolve(resolvedHome)), fold(api.resolve(resolvedFolder)));
  const isHome = relative === "";
  const inside = !isHome && !relative.startsWith("..") && !api.isAbsolute(relative);
  const again = "Then run the same command again; nothing was changed.";
  const head = `TinyCloud can't write its folder ${shown(folder)} (${code})`;
  const metadata = { path: shown(folder), errno: code };
  const refuse = (message: string): CLIError => new CLIError("STATE_FOLDER_NOT_WRITABLE", message, ExitCode.ERROR, metadata);

  if (CONTROL.test(folder) || (!inside && !isHome) || (windows && isHome)) {
    const where = CONTROL.test(folder) ? ", and its name has control characters" : inside || isHome ? "" : ", which is outside your home folder";
    return refuse(`${head}${where}. Ask the person who manages this computer to give your user write access to it. ${again}`);
  }
  if (windows) {
    return refuse(`${head}: your Windows user cannot write there. Run yourself in PowerShell: icacls ${powershellQuoted(folder)} /grant "\${env:USERNAME}:(OI)(CI)F" /T. ${again}`);
  }
  let owned = false;
  let mode = "";
  try {
    const info = statSync(folder);
    owned = info.uid === context.uid;
    mode = (info.mode & 0o777).toString(8);
  } catch {
    // The cause stays general when the folder cannot be inspected.
  }
  if (owned) {
    return refuse(`${head}: it is read-only for your user (mode ${mode}) or sits on a read-only disk. Run yourself: chmod u+rwx ${posixQuoted(folder)}. ${again}`);
  }
  if (isHome) {
    return refuse(`${head}: your home folder belongs to another user. Ask the person who manages this computer to give your user write access to it. ${again}`);
  }
  return refuse(`${head}: it belongs to another user, often root after an earlier sudo run. Run yourself in a terminal, not through an agent: sudo chown -R "$USER" ${posixQuoted(folder)}. ${again}`);
}
