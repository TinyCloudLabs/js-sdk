import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skills that ship inside the CLI's npm package (`skills/<name>/`), installed
 * from the package itself: no second download. A bundled skill lists every
 * file in `SHA256SUMS`, in the format agents.tinycloud.xyz serves; every file
 * is checked against it before anything is written, and a folder is replaced
 * as a whole, so a client never sees half of one version and half of another.
 */

export class SkillInstallError extends Error {
  constructor(readonly code: "SKILL_INTEGRITY_FAILED" | "SKILL_INSTALL_FAILED", message: string) {
    super(message);
    this.name = "SkillInstallError";
  }
}

export interface BundledSkill {
  readonly name: string;
  /** `metadata.version` from SKILL.md's frontmatter. */
  readonly version: string;
  /** Every file SHA256SUMS lists, by relative path, verified. */
  readonly files: ReadonlyMap<string, Buffer>;
  /** The SHA256SUMS text itself. */
  readonly sums: Buffer;
}

/** This package's root: the nearest folder up from this module whose package.json is @tinycloud/cli. */
export function cliPackageRoot(from: string = fileURLToPath(import.meta.url)): string {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "@tinycloud/cli") return dir;
      } catch {
        // Not a package manifest we can read; keep looking.
      }
    }
    if (dirname(dir) === dir) throw new SkillInstallError("SKILL_INSTALL_FAILED", "Could not find the @tinycloud/cli package folder.");
  }
}

const SUM_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read one bundled skill and check it: SHA256SUMS lists plain file names of
 * this folder, every listed file matches its checksum, no listed file is
 * missing, and the folder holds nothing it doesn't list.
 */
export async function readBundledSkill(dir: string, name: string): Promise<BundledSkill> {
  const sums = await readFile(join(dir, "SHA256SUMS")).catch(() => {
    throw new SkillInstallError("SKILL_INTEGRITY_FAILED", `The bundled ${name} skill has no SHA256SUMS.`);
  });
  const files = new Map<string, Buffer>();
  for (const line of sums.toString("utf8").split("\n").filter((entry) => entry !== "")) {
    const match = SUM_LINE.exec(line);
    if (!match || match[2] === "SHA256SUMS" || files.has(match[2]!)) {
      throw new SkillInstallError("SKILL_INTEGRITY_FAILED", `The bundled ${name} skill's SHA256SUMS has an invalid line.`);
    }
    const path = match[2]!;
    const body = await readFile(join(dir, path)).catch(() => {
      throw new SkillInstallError("SKILL_INTEGRITY_FAILED", `The bundled ${name} skill is missing ${path}.`);
    });
    if (sha256(body) !== match[1]) {
      throw new SkillInstallError("SKILL_INTEGRITY_FAILED", `The bundled ${name} skill's ${path} does not match SHA256SUMS; nothing was installed.`);
    }
    files.set(path, body);
  }
  const extra = (await readdir(dir)).filter((entry) => entry !== "SHA256SUMS" && !files.has(entry));
  if (extra.length > 0) {
    throw new SkillInstallError("SKILL_INTEGRITY_FAILED", `The bundled ${name} skill has files SHA256SUMS doesn't list: ${extra.join(", ")}.`);
  }
  const skill = files.get("SKILL.md")?.toString("utf8");
  if (skill === undefined) throw new SkillInstallError("SKILL_INTEGRITY_FAILED", `The bundled ${name} skill has no SKILL.md.`);
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
  if (/^name:\s*(\S+)/m.exec(frontmatter)?.[1] !== name) {
    throw new SkillInstallError("SKILL_INTEGRITY_FAILED", `The bundled ${name} skill's SKILL.md names another skill.`);
  }
  const version = /^\s+version:\s*["']?([^"'\n]+)["']?\s*$/m.exec(frontmatter)?.[1] ?? "unknown";
  return { name, version, files, sums };
}

const LOCK_WAIT_MS = 30_000;
/** A held lock covers only writing and renaming a few small files. */
const LOCK_STALE_MS = 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function age(path: string): Promise<number | null> {
  try {
    return Date.now() - (await lstat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function takeLock(lock: string, tag: string): Promise<void> {
  for (const deadline = Date.now() + LOCK_WAIT_MS; ;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner"), `${process.pid} ${tag}\n`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = await readFile(join(lock, "owner"), "utf8").catch(() => "");
    const pid = Number(owner.split(" ")[0]);
    const held = await age(lock);
    if (held !== null && ((owner && !alive(pid)) || held > LOCK_STALE_MS)) {
      await rm(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new SkillInstallError("SKILL_INSTALL_FAILED", `Another install is still writing ${dirname(lock)} (lock ${lock}).`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

function safeJoin(base: string, path: string): string {
  const target = resolve(base, path);
  if (!target.startsWith(base + sep)) throw new SkillInstallError("SKILL_INSTALL_FAILED", `Unsafe file path ${path}.`);
  return target;
}

/**
 * Replace `<root>/<name>` with exactly `files`: write a new folder beside it,
 * move the old one aside, move the new one in, then delete the old one. If
 * moving the new one in fails, the old one goes back. One install of a folder
 * at a time (a lock folder beside it). Returns the folder, read back and
 * checked.
 */
export async function replaceFolder(
  root: string,
  name: string,
  files: ReadonlyMap<string, Buffer>,
  options: { readonly dirMode?: number; readonly fileMode?: number } = {},
): Promise<string> {
  const base = resolve(root);
  const dest = join(base, name);
  const tag = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const stage = join(base, `.${name}.installing-${tag}`);
  const backup = join(base, `.${name}.previous-${tag}`);
  const lock = join(base, `.${name}.lock`);
  await mkdir(base, { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) });
  await takeLock(lock, tag);
  try {
    // Leftovers of installs whose process has exited.
    for (const entry of await readdir(base)) {
      const match = new RegExp(`^\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(installing|previous)-(\\d+)-[0-9a-f]+$`).exec(entry);
      if (match && !alive(Number(match[2]))) {
        if (match[1] === "previous" && (await age(dest)) === null) await rename(join(base, entry), dest);
        else await rm(join(base, entry), { recursive: true, force: true });
      }
    }
    try {
      await mkdir(stage, options.dirMode === undefined ? {} : { mode: options.dirMode });
      for (const [path, body] of files) {
        const target = safeJoin(stage, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body, options.fileMode === undefined ? {} : { mode: options.fileMode });
      }
      const hadOld = (await age(dest)) !== null;
      if (hadOld) await rename(dest, backup);
      try {
        await rename(stage, dest);
      } catch (error) {
        if (hadOld) await rename(backup, dest);
        throw error;
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof SkillInstallError) throw error;
    throw new SkillInstallError("SKILL_INSTALL_FAILED", `Could not write ${dest}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
  for (const [path, body] of files) {
    const written = await readFile(join(dest, path)).catch(() => undefined);
    if (written === undefined || !written.equals(body)) {
      throw new SkillInstallError("SKILL_INSTALL_FAILED", `${join(dest, path)} did not read back as written.`);
    }
  }
  return dest;
}
