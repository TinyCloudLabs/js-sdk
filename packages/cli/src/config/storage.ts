import { randomUUID } from "node:crypto";
import { readFile, writeFile, stat, mkdir, rm, readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Read and parse a JSON file. Returns null if the file does not exist.
 * Throws on any other error (permission denied, invalid JSON, etc.).
 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const data = await readFile(filePath, "utf-8");
    return JSON.parse(data) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** TinyCloud state holds keys, sessions and delegations: owner-only access. */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/**
 * Write data as JSON to a file. Creates parent directories if needed.
 *
 * Writes to a temp file in the same directory and renames it into place, so
 * a crash or concurrent read never observes a partially-written file. The
 * file is created 0600 and new directories 0700.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Check if a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * Ensure a directory exists (mkdir -p); new directories are created 0700.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Remove a directory recursively (rm -rf).
 */
export async function removeDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

/**
 * List directory names (not files) inside a directory.
 * Returns an empty array if the directory does not exist.
 */
export async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
