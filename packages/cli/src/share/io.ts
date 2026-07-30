import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, link, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";

export const MAX_SHARE_STDIN_BYTES = 100 * 1024 * 1024;
export const MAX_SHARE_URL_BYTES = 64 * 1024;

export async function readBoundedStdin(limit = MAX_SHARE_STDIN_BYTES): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("MAX_BYTES_EXCEEDED");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.byteLength;
    if (total > limit) throw new Error("MAX_BYTES_EXCEEDED");
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export async function readBoundedUrlStdin(): Promise<string> {
  const bytes = await readBoundedStdin(MAX_SHARE_URL_BYTES);
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (value.length === 0 || /\s/.test(value)) throw new Error("INVALID_ARGUMENT");
  return value;
}

export function safeFilename(value: string): string {
  if (value.length === 0 || value === "." || value === ".." || /[/\\\u0000-\u001f\u007f]/.test(value)) throw new Error("UNSAFE_FILENAME");
  return value;
}

export function markdownFilename(value: string): string {
  const filename = safeFilename(value);
  if (!/\.(?:md|markdown|txt)$/i.test(filename)) throw new Error("INVALID_ARGUMENT");
  return filename;
}

export async function readShareInput(input: string, name?: string, limit = MAX_SHARE_STDIN_BYTES): Promise<{ bytes: Uint8Array; filename: string }> {
  if (input === "-") {
    const bytes = await readBoundedStdin(limit);
    return { bytes, filename: markdownFilename(name ?? "stdin.md") };
  }
  const path = resolve(input);
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error("MAX_BYTES_EXCEEDED");
  const filename = markdownFilename(name ?? basename(path));
  const bytes = new Uint8Array(await readFile(path));
  // The pre-read stat is only an optimization. A file can grow between stat
  // and readFile, so enforce the same bound on the bytes actually published.
  if (bytes.byteLength > limit) throw new Error("MAX_BYTES_EXCEEDED");
  return { bytes, filename };
}

async function assertDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const segments = absolute.split(sep).filter(Boolean);
  let current = absolute.startsWith(sep) ? sep : "";
  for (const segment of segments) {
    current = current === sep ? join(current, segment) : join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        // macOS exposes /tmp and /var as stable system aliases. They are not
        // user-controlled output-directory components; canonicalize them and
        // continue checking every component below the alias.
        const canonical = await realpath(current);
        if (current !== "/tmp" && current !== "/var") throw new Error("OUTPUT_EXISTS");
        if (canonical !== `/private${current}`) throw new Error("OUTPUT_EXISTS");
      } else if (!info.isDirectory()) throw new Error("OUTPUT_EXISTS");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("OUTPUT_EXISTS");
    }
  }
}

export async function writeShareOutput(directory: string, filename: string, bytes: Uint8Array, force: boolean): Promise<string> {
  const outputDirectory = resolve(directory);
  await assertDirectory(outputDirectory);
  const safeName = safeFilename(filename);
  // Hold the directory identity while performing every child operation. A
  // second realpath check still leaves a rename/symlink replacement window;
  // /dev/fd/<dirfd> keeps the following names attached to this directory.
  const directoryHandle = await open(outputDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  // macOS exposes directory descriptors for inspection but does not permit
  // O_CREAT through /dev/fd/<fd>/<child>. Keep the canonical spelling for
  // mutating calls while the descriptor remains open; the descriptor is the
  // identity check and is closed only after the exclusive operation.
  const stableDirectory = await realpath(outputDirectory);
  const childPath = (name: string): string => join(stableDirectory, name);
  const outputPath = childPath(safeName);
  let temporaryPath: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      const existing = await lstat(outputPath);
      if (existing.isSymbolicLink()) throw new Error("UNSAFE_FILENAME");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    temporaryPath = childPath(`.tinycloud-share-${randomBytes(16).toString("hex")}.tmp`);
    handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    if (force) {
      // rename replaces the directory entry itself and never follows an
      // existing output symlink.  The content was written only to the fresh
      // exclusive temporary file above.
      await rename(temporaryPath, outputPath);
    } else {
      // A hard-link create is exclusive and does not follow a symlink at the
      // destination.  Remove the temporary name after the link succeeds.
      await link(temporaryPath, outputPath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("OUTPUT_EXISTS");
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("UNSAFE_FILENAME");
    throw error;
  } finally {
    await handle?.close();
    try { if (temporaryPath !== undefined) await unlink(temporaryPath); } catch { /* already linked, renamed, or absent */ }
    await directoryHandle.close();
  }
  return join(outputDirectory, safeName);
}
