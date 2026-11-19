import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The skill the CLI package ships, saved under this name in a client's skills folder. */
export const SKILL_NAME = "tinycloud-cli";

/** Written next to the files TinyCloud saved, so a later run can tell a stale copy from one someone edited. */
const MARKER = ".tinycloud-skill.json";

export type SkillState = "current" | "outdated" | "missing" | "changed";

/** File path (`/`-separated, relative to the skill folder) to the sha256 of its bytes. */
export type SkillFiles = ReadonlyMap<string, string>;

/** The folder the package ships `skills/tinycloud-cli` in: next to `dist` when built, next to `src` from source. */
export function bundledSkillDir(from: URL = new URL(import.meta.url)): string {
  for (const relative of ["../skills", "../../skills", "../../../skills"]) {
    const candidate = join(dirname(fileURLToPath(from)), relative, SKILL_NAME);
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
  }
  throw new Error("This CLI was installed without its bundled skill.");
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Every file under `dir` (not the marker) with its hash, or `undefined` when something in it is not a plain file or
 * folder: a link is never followed, so a saved folder that was turned into one counts as changed.
 */
export function readSkillFiles(dir: string): SkillFiles | undefined {
  const files = new Map<string, string>();
  const walk = (current: string, prefix: string): boolean => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!walk(path, name)) return false;
      } else if (entry.isFile()) {
        if (name !== MARKER) files.set(name, digest(readFileSync(path)));
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(dir, "") ? files : undefined;
}

const same = (a: SkillFiles, b: SkillFiles): boolean => a.size === b.size && [...a].every(([name, hash]) => b.get(name) === hash);

function markedFiles(dir: string): SkillFiles | undefined {
  try {
    const { files } = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { files?: Record<string, unknown> };
    if (typeof files !== "object" || files === null) return undefined;
    const marked = new Map<string, string>();
    for (const [name, hash] of Object.entries(files)) {
      if (typeof hash !== "string") return undefined;
      marked.set(name, hash);
    }
    return marked;
  } catch {
    return undefined;
  }
}

/**
 * What is in `target` compared with the skill this CLI ships. `current`: the same files. `outdated`: files TinyCloud
 * saved earlier and nobody edited. `changed`: anything else (extra, edited or removed files, a link). Read-only.
 */
export function skillState(target: string, bundled: SkillFiles): SkillState {
  let info;
  try {
    info = lstatSync(target);
  } catch {
    return "missing";
  }
  if (!info.isDirectory()) return "changed";
  const found = readSkillFiles(target);
  if (found === undefined) return "changed";
  if (same(found, bundled)) return "current";
  const marked = markedFiles(target);
  return marked !== undefined && same(found, marked) ? "outdated" : "changed";
}

/** Replace `target` (missing or outdated) with the bundled skill: staged beside it, then swapped in. */
export function saveSkill(target: string, bundledDir: string, bundled: SkillFiles, cliVersion: string): void {
  const root = dirname(target);
  mkdirSync(root, { recursive: true });
  const tag = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const staging = join(root, `.${SKILL_NAME}.staging-${tag}`);
  const backup = join(root, `.${SKILL_NAME}.old-${tag}`);
  try {
    mkdirSync(staging);
    for (const name of bundled.keys()) {
      const to = join(staging, ...name.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(bundledDir, ...name.split("/"))));
    }
    writeFileSync(join(staging, MARKER), `${JSON.stringify({ cli: cliVersion, files: Object.fromEntries(bundled) }, null, 2)}\n`);
    const replacing = existsSync(target);
    if (replacing) renameSync(target, backup);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (replacing) renameSync(backup, target);
      throw error;
    }
    if (replacing) rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The nearest folder at or above `file` that exists: the one that refused a write. Returned with its mode and whether
 * the current user owns it, so the caller can say why; never a command.
 */
export function refusingFolder(file: string): { folder: string; mode: string; ownedByUser: boolean } {
  let folder = file;
  while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
  const info = statSync(folder);
  return { folder, mode: (info.mode & 0o777).toString(8), ownedByUser: info.uid === process.getuid?.() };
}

/** A path as one line: control characters become `?`. */
export const shownPath = (path: string): string => path.replace(/[\u0000-\u001f\u007f]/g, "?");
