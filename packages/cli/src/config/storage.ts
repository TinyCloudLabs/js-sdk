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

/**
 * Write data as JSON to a file. Creates parent directories if needed.
 *
 * Writes to a temp file in the same directory and renames it into place, so
 * a crash or concurrent read never observes a partially-written file.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
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
 * Ensure a directory exists (mkdir -p).
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
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
