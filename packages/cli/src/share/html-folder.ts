import { constants, existsSync, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import {
  ArtifactBundleError,
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_SOURCE_BYTES,
  canonicalArtifactPath,
  inlineHtmlFolder,
  type ArtifactFile,
} from "@tinycloud/share-sdk/html-bundle";
import { CLIError } from "../output/errors.js";
import { ECHO_LIST_MAX, safeClipped, safeClippedList } from "../output/safe-text.js";
import { shareFilename } from "./io.js";

/**
 * `tc share publish ./site/`: a folder with a root `index.html` becomes ONE self-contained `.html` file, published as
 * any other single file. The folder is read here (the CLI's filesystem rules), the rewriting is the share-sdk
 * `html-bundle` rewriter (the rules of what a page may reference). Nothing outside the folder is read, symbolic links are
 * refused rather than followed, and every path or reference text echoed in an error is escaped for the terminal.
 */

/** Deepest directory nesting read. */
export const MAX_HTML_FOLDER_DEPTH = 16;

/** The Share viewer's preview budget for a page (its `MAX_SAFE_CONTENT_BYTES`): a larger page is download-only. */
const VIEWER_PREVIEW_BYTES = 1024 * 1024;

const FOLDER_HINT = "A folder is published as one self-contained page: every stylesheet, script and image it uses is inlined, and external URLs, frames, forms, <base>, module scripts and links to other pages are refused.";

/** Why a directory is refused where a folder cannot be published as one page (addressed, `--prefix`, several inputs). */
export const FOLDER_NOT_AVAILABLE = "Folders can only be published as a single page for an anyone-with-the-link share (`--to anyone`); for others publish a single file";

/** True when `input` names an existing directory (a symbolic link to one counts: the user typed it). */
export async function isDirectoryInput(input: string): Promise<boolean> {
  if (input === "-") return false;
  try {
    return (await stat(resolve(input))).isDirectory();
  } catch {
    return false;
  }
}

export interface FolderProblem {
  readonly code: "UNSUPPORTED_FOLDER_ENTRY" | "UNSAFE_PATH";
  readonly path: string;
  readonly reason: string;
}

function limitError(message: string): CLIError {
  return new CLIError("MAX_BYTES_EXCEEDED", message, 7);
}

/** True when `candidate` is a path strictly inside `root` (both absolute and already resolved). */
export function isWithinFolder(root: string, candidate: string): boolean {
  const path = relativePath(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

const CHANGED = "changed while it was read";

function isRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/**
 * Seams for the filesystem checks. Production code passes none. The two hooks let a test model another process changing the
 * folder at an exact point; `descriptorPath` lets a test run the checks used where the platform cannot name an open file.
 */
export interface FolderReadHooks {
  /** Runs just before an entry is opened. */
  readonly beforeOpen?: () => Promise<void>;
  /** Runs after an entry's `lstat` and before it is opened. */
  readonly afterLstat?: () => Promise<void>;
  /** Runs just after an entry is opened, before anything is checked. */
  readonly afterOpen?: () => Promise<void>;
  /** Runs after a file's bytes are read, before they are accepted. */
  readonly afterRead?: () => Promise<void>;
  /** The real path an open descriptor refers to, or `undefined` where the platform cannot say (then the weaker checks run). */
  readonly descriptorPath?: (fd: number) => Promise<string | undefined>;
}

const PROC_FD = "/proc/self/fd";

/**
 * The real path the kernel says an open descriptor refers to: Linux only (`/proc/self/fd/<fd>`). Other platforms return
 * `undefined`: Node exposes neither `F_GETPATH` (macOS) nor `openat`, so there is no way to ask a descriptor where it
 * lives. An error means the file moved or was deleted since it was opened.
 */
export async function linuxDescriptorPath(fd: number): Promise<string | undefined> {
  if (process.platform !== "linux" || !existsSync(PROC_FD)) return undefined;
  return realpath(`${PROC_FD}/${fd}`);
}

/** Every directory between `root` (not included) and the entry named by `path` (not included) is a real directory. */
async function parentChainIsRealDirectories(root: string, path: string): Promise<boolean> {
  let current = dirname(path);
  while (current !== root && isWithinFolder(root, current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    current = dirname(current);
  }
  return current === root;
}

/**
 * The file's bytes, read from one descriptor, never past `limit` bytes. `root` is the folder's real path and `path` is the
 * file as `root` plus its names, so no component of it may be a link.
 *
 * `O_NOFOLLOW` covers only the last component, so a link in a parent directory is checked another way. On Linux the check
 * is on the OPEN DESCRIPTOR: its real path (`/proc/self/fd/<fd>`) must be exactly `path`, so what was opened is the file
 * at that path inside the folder and no path is looked up again; swapping a parent directory for a link at any moment
 * cannot get an outside file read. Elsewhere (macOS: Node has no `F_GETPATH`) the closest checks are made instead: `path`
 * must resolve to itself, its `lstat` must be the opened file (same device and inode), and after the read every parent
 * directory and the file are checked again. That narrows the window but does not close it: a process that can write to the
 * folder while it is published and times its swaps can still win there.
 */
export async function readRegularFile(root: string, path: string, relative: string, remaining: number, limit: number, hooks: FolderReadHooks = {}): Promise<Uint8Array | FolderProblem> {
  const problem = (reason: string): FolderProblem => ({ code: "UNSUPPORTED_FOLDER_ENTRY", path: relative, reason });
  const descriptorPath = hooks.descriptorPath ?? linuxDescriptorPath;
  let handle;
  let before;
  try {
    await hooks.beforeOpen?.();
    before = await lstat(path);
    await hooks.afterLstat?.();
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return problem("symbolic link");
    if (isRaceError(error)) return problem(CHANGED);
    throw error;
  }
  try {
    await hooks.afterOpen?.();
    const info = await handle.stat();
    if (!info.isFile()) return problem("not a regular file");
    let byDescriptor: string | undefined;
    try {
      if (before.dev !== info.dev || before.ino !== info.ino) return problem(CHANGED);
      byDescriptor = await descriptorPath(handle.fd);
      if (byDescriptor !== undefined) {
        if (byDescriptor !== path || !isWithinFolder(root, byDescriptor)) return problem("symbolic link");
      } else {
        const real = await realpath(path);
        if (real !== path || !isWithinFolder(root, real)) return problem("symbolic link");
      }
    } catch (error) {
      if (isRaceError(error)) return problem(CHANGED);
      throw error;
    }
    if (info.size > remaining) throw limitError(`folder is larger than the ${limit} byte limit (at "${safeClipped(relative)}")`);
    // The stat is only a shortcut: a file can grow while it is read, so the bytes read are bounded too.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1 << 20, remaining - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > remaining) throw limitError(`folder is larger than the ${limit} byte limit (at "${safeClipped(relative)}")`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await hooks.afterRead?.();
    if (byDescriptor === undefined) {
      // Without a descriptor path, look at the path again once the bytes are in: every parent still a real directory and the
      // file still the one that was read.
      try {
        const again = await lstat(path);
        if (again.isSymbolicLink() || again.dev !== info.dev || again.ino !== info.ino || !(await parentChainIsRealDirectories(root, path))) return problem(CHANGED);
      } catch (error) {
        if (isRaceError(error)) return problem(CHANGED);
        throw error;
      }
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

/**
 * The entries of one directory of the folder: a real directory (not a link), listed from the descriptor it was opened as
 * where the platform can name one (see `readRegularFile` for what that closes and what it does not).
 */
export async function listFolderDirectory(root: string, absolute: string, relative: string, hooks: FolderReadHooks = {}): Promise<{ entries: Dirent[] } | FolderProblem> {
  const problem = (reason: string): FolderProblem => ({ code: "UNSUPPORTED_FOLDER_ENTRY", path: relative === "" ? "." : relative, reason });
  const descriptorPath = hooks.descriptorPath ?? linuxDescriptorPath;
  try {
    await hooks.beforeOpen?.();
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) return problem("symbolic link");
    if (!before.isDirectory()) return problem(CHANGED);
    await hooks.afterLstat?.();
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      await hooks.afterOpen?.();
      const info = await handle.stat();
      if (!info.isDirectory() || info.dev !== before.dev || info.ino !== before.ino) return problem(CHANGED);
      const byDescriptor = await descriptorPath(handle.fd);
      if (byDescriptor !== undefined) {
        if (byDescriptor !== absolute || (absolute !== root && !isWithinFolder(root, byDescriptor))) return problem("symbolic link");
        // The listing comes from the descriptor, not from the path.
        return { entries: await readdir(`${PROC_FD}/${handle.fd}`, { withFileTypes: true }) };
      }
      const real = await realpath(absolute);
      if (real !== absolute || (absolute !== root && !isWithinFolder(root, real))) return problem("symbolic link");
      const entries = await readdir(absolute, { withFileTypes: true });
      const after = await lstat(absolute);
      if (after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) return problem(CHANGED);
      if (absolute !== root && !(await parentChainIsRealDirectories(root, absolute))) return problem(CHANGED);
      return { entries };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isRaceError(error)) return problem(CHANGED);
    throw error;
  }
}

function problemError(problems: readonly FolderProblem[]): CLIError {
  const first = problems[0]!;
  const listed = problems.slice(0, ECHO_LIST_MAX).map((problem) => `"${safeClipped(problem.path)}" (${problem.reason})`).join(", ");
  const more = problems.length > ECHO_LIST_MAX ? ` … and ${problems.length - ECHO_LIST_MAX} more` : "";
  const noun = first.code === "UNSAFE_PATH" ? "paths that cannot be published safely" : "entries that cannot be published";
  return new CLIError(
    first.code,
    `folder has ${problems.length} ${noun}: ${listed}${more}`,
    first.code === "UNSAFE_PATH" ? 8 : 2,
    { hint: first.code === "UNSAFE_PATH" ? "Rename these files to plain names without control, invisible or direction-changing characters." : "Symbolic links and special files are never followed or read; copy the real files into the folder." },
  );
}

/**
 * Every regular file of `directory`, with its path relative to it. Entries starting with `.` (`.git`, `.env`,
 * `.DS_Store`) are skipped and never read; they are counted in `skippedHidden`. Symbolic links, special files and
 * unsafe names are all collected and refused together.
 */
export async function readHtmlFolder(directory: string, limit: number): Promise<{ readonly files: ArtifactFile[]; readonly skippedHidden: number }> {
  // The folder's real path: every path below is built from it, so a link anywhere under it shows as a mismatch.
  const root = await realpath(resolve(directory));
  const files: ArtifactFile[] = [];
  const problems: FolderProblem[] = [];
  let skippedHidden = 0;
  let total = 0;
  const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
    const listed = await listFolderDirectory(root, absolute, relative);
    if ("reason" in listed) {
      problems.push(listed);
      return;
    }
    const entries = listed.entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        skippedHidden += 1;
        continue;
      }
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const child = join(absolute, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push({ code: "UNSUPPORTED_FOLDER_ENTRY", path, reason: "symbolic link" });
      } else if (entry.isDirectory()) {
        if (depth >= MAX_HTML_FOLDER_DEPTH) problems.push({ code: "UNSUPPORTED_FOLDER_ENTRY", path, reason: `nested deeper than ${MAX_HTML_FOLDER_DEPTH} folders` });
        else await walk(child, path, depth + 1);
      } else if (!entry.isFile()) {
        problems.push({ code: "UNSUPPORTED_FOLDER_ENTRY", path, reason: "not a regular file" });
      } else {
        try {
          canonicalArtifactPath(path);
        } catch {
          problems.push({ code: "UNSAFE_PATH", path, reason: "unsafe name" });
          continue;
        }
        if (files.length >= MAX_ARTIFACT_FILES) throw limitError(`folder has more than ${MAX_ARTIFACT_FILES} files`);
        const read = await readRegularFile(root, child, path, limit - total, limit);
        if (read instanceof Uint8Array) {
          total += read.byteLength;
          files.push({ path: path.normalize("NFC"), bytes: read });
        } else problems.push(read);
      }
    }
  };
  await walk(root, "", 0);
  if (problems.length > 0) throw problemError(problems);
  return { files, skippedHidden };
}

/** The refusal of the rewriter as a typed CLI error: a fixed message, the file, and the offending reference escaped. */
export function htmlFolderError(error: ArtifactBundleError): CLIError {
  const file = error.path === undefined ? "" : `"${safeClipped(error.path)}"`;
  const reference = error.reference === undefined ? "" : ` "${safeClipped(error.reference)}"`;
  if (error.kind === "limit") return limitError(`folder cannot be published as one page: ${error.message.replace(/^artifact /, "")}${file === "" ? "" : ` (${file})`}`);
  if (error.kind === "missing") {
    if (error.reference === undefined) {
      return new CLIError("INVALID_ARGUMENT", "folder needs an index.html at its top level", 2, { hint: "Publish the folder that directly contains index.html." });
    }
    return new CLIError(
      "HTML_RESOURCE_MISSING",
      `${file} refers to${reference}, which is not in the folder`,
      2,
      { hint: "manifest.json and knowledge/ are never inlined, so a page cannot refer to them. Names are case-sensitive." },
    );
  }
  if (error.kind === "unsupported") {
    return new CLIError("UNSUPPORTED_HTML", `${file === "" ? "folder" : file} cannot be published as one page: ${error.message.replace(/^artifact /, "")}${reference}`, 2, { hint: FOLDER_HINT });
  }
  const pathProblem = /\b(?:path|paths|reference)\b/.test(error.message);
  return new CLIError(
    pathProblem ? "UNSAFE_PATH" : "INVALID_ARGUMENT",
    `folder cannot be published as one page: ${error.message.replace(/^artifact /, "")}${file === "" ? "" : ` (${file}${reference})`}`,
    pathProblem ? 8 : 2,
  );
}

interface JsdomModule {
  readonly JSDOM: new (html: string) => {
    readonly window: {
      readonly DOMParser: new () => { parseFromString(html: string, type: "text/html"): Document };
      close(): void;
    };
  };
}

async function jsdomParser(): Promise<{ readonly parseHtml: (html: string) => Document; readonly close: () => void }> {
  // Loaded on demand: only a folder publish pays for it. jsdom is built on parse5, the HTML5 tree builder a browser uses,
  // so the rewriter sees the tree the viewer's browser will build. Scripting and subresource loading are off in a
  // fresh JSDOM; nothing the folder contains runs or is fetched.
  // The specifier is not a literal so the package needs no type declarations (`@types/jsdom` would put the DOM lib into
  // every workspace project that resolves root `@types`); only the members used here are typed.
  const { JSDOM } = (await import("jsdom" as string)) as JsdomModule;
  const window = new JSDOM("").window;
  const parser = new window.DOMParser();
  return { parseHtml: (html) => parser.parseFromString(html, "text/html"), close: () => window.close() };
}

export interface HtmlFolderBundle {
  /** The published name: `--name`, or `<folder>.html`. */
  readonly filename: string;
  readonly bytes: Uint8Array;
  /** `manifest.json` and `knowledge/**`: carried apart from the page (the T8 sidecar hook), never inlined. */
  readonly passive: readonly ArtifactFile[];
  readonly skippedHidden: number;
  readonly fileCount: number;
}

/** The published name of a folder, validated before anything is read. */
export function htmlFolderFilename(directory: string, name?: string): string {
  const filename = shareFilename(name ?? `${basename(resolve(directory))}.html`);
  if (!/\.html?$/i.test(filename)) throw new CLIError("INVALID_ARGUMENT", "a folder is published as an .html file; --name must end in .html", 2);
  return filename;
}

/** Read `directory` and inline it into one `.html` document. */
export async function bundleHtmlFolder(directory: string, options: { readonly name?: string; readonly maxBytes?: number } = {}): Promise<HtmlFolderBundle> {
  const filename = htmlFolderFilename(directory, options.name);
  const { files, skippedHidden } = await readHtmlFolder(directory, Math.min(options.maxBytes ?? MAX_ARTIFACT_SOURCE_BYTES, MAX_ARTIFACT_SOURCE_BYTES));
  const parser = await jsdomParser();
  try {
    const inlined = await inlineHtmlFolder(files, { parseHtml: parser.parseHtml });
    return { filename, bytes: inlined.html, passive: inlined.passive, skippedHidden, fileCount: inlined.fileCount };
  } catch (error) {
    if (error instanceof ArtifactBundleError) throw htmlFolderError(error);
    throw error;
  } finally {
    parser.close();
  }
}

/** One stderr line naming what was left out of the page, or undefined when nothing was. */
export function htmlFolderNotice(bundle: HtmlFolderBundle): string | undefined {
  const parts: string[] = [];
  if (bundle.passive.length > 0) {
    parts.push(`Left out of the page and not published (never inlined): ${safeClippedList(bundle.passive.map((file) => file.path))}.`);
  }
  if (bundle.bytes.byteLength > VIEWER_PREVIEW_BYTES) {
    parts.push(`The page is ${(bundle.bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB; the Share viewer previews pages up to 1 MiB and offers a download above that.`);
  }
  if (bundle.skippedHidden > 0) parts.push(`Skipped ${bundle.skippedHidden} hidden ${bundle.skippedHidden === 1 ? "entry" : "entries"} (names starting with a dot).`);
  return parts.length === 0 ? undefined : `${parts.join(" ")}\n`;
}
