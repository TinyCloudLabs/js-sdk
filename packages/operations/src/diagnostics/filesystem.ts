import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type DiagnosticFailure = "invalid" | "unsafe_path" | "permission" | "missing" | "locked" | "quota" | "expired" | "disabled" | "generation" | "io" | "worker" | "queue" | "timeout";
export class DiagnosticError extends Error {
  constructor(readonly code: DiagnosticFailure) { super(`Diagnostic ${code}`); this.name = "DiagnosticError"; }
}
export function diagnosticFailure(error: unknown): DiagnosticFailure {
  if (error instanceof DiagnosticError) return error.code;
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case "ENOENT": return "missing";
    case "EACCES": case "EPERM": return "permission";
    case "ELOOP": case "ENOTDIR": case "EISDIR": return "unsafe_path";
    case "ENOSPC": case "EDQUOT": return "quota";
    default: return "io";
  }
}
export async function diagnosticGuard<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { throw new DiagnosticError(diagnosticFailure(error)); }
}
export function isMissing(error: unknown): boolean { return diagnosticFailure(error) === "missing"; }
export function inside(parent: string, child: string): boolean { return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep); }
export function absolutePath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || path.length > 4096) throw new DiagnosticError("unsafe_path");
  return resolve(path);
}
/** Resolve missing descendants through existing ancestors; dangling links remain unsafe. */
async function physicalLocation(path: string): Promise<string> {
  let current = absolutePath(path);
  const missing: string[] = [];
  for (;;) {
    try { return resolve(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if (!isMissing(error)) throw new DiagnosticError("unsafe_path");
      try { await lstat(current); }
      catch (absent) {
        if (!isMissing(absent)) throw new DiagnosticError("unsafe_path");
        const parent = dirname(current);
        if (parent === current) throw new DiagnosticError("unsafe_path");
        missing.push(basename(current)); current = parent;
        continue;
      }
      throw new DiagnosticError("unsafe_path");
    }
  }
}
export async function assertSeparateDirectories(root: string, protectedRoots: readonly string[]): Promise<void> {
  const selected = await physicalLocation(root);
  for (const path of protectedRoots) {
    const protectedPath = await physicalLocation(path);
    if (inside(selected, protectedPath) || inside(protectedPath, selected)) throw new DiagnosticError("unsafe_path");
  }
}
function owner(stats: Stats): boolean { return typeof process.getuid !== "function" || stats.uid === process.getuid(); }
function directory(stats: Stats, privateMode: boolean): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new DiagnosticError("unsafe_path");
  if (privateMode) {
    if (!owner(stats) || (stats.mode & 0o077) !== 0) throw new DiagnosticError("unsafe_path");
  } else if ((stats.mode & 0o022) !== 0 && !(stats.uid === 0 && (stats.mode & 0o1000) !== 0)) {
    throw new DiagnosticError("unsafe_path");
  } else if (!owner(stats) && stats.uid !== 0) throw new DiagnosticError("unsafe_path");
}
function regular(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || !owner(stats) || stats.nlink !== 1 || (stats.mode & 0o077) !== 0) throw new DiagnosticError("unsafe_path");
}
export interface PrivateDirectory {
  readonly path: string;
  readonly logical: string;
  readonly handle: FileHandle;
  assertStable(): Promise<void>;
}
/** Linux pins every ancestor by descriptor. Other platforms additionally check identity at handoff. */
export async function withPrivateDirectory<T>(path: string, create: boolean, action: (directory: PrivateDirectory) => Promise<T>, boundary = path): Promise<T> {
  path = absolutePath(path); boundary = absolutePath(boundary);
  const handles: FileHandle[] = [];
  let logical: string = sep;
  let pinned: string = sep;
  try {
    for (const component of path.split(sep).filter(Boolean)) {
      logical = join(logical, component);
      const child = join(pinned, component);
      try { await lstat(child); } catch (error) {
        if (!isMissing(error) || !create) throw error;
        try { await mkdir(child, { mode: 0o700 }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      }
      const before = await lstat(child);
      directory(before, inside(boundary, logical));
      const handle = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      const after = await handle.stat();
      directory(after, inside(boundary, logical));
      if (before.dev !== after.dev || before.ino !== after.ino) throw new DiagnosticError("unsafe_path");
      pinned = process.platform === "linux" ? `/proc/self/fd/${handle.fd}/.` : logical;
    }
    const handle = handles[handles.length - 1];
    if (!handle) throw new DiagnosticError("unsafe_path");
    const identity = await handle.stat();
    const held: PrivateDirectory = {
      path: pinned, logical: path, handle,
      async assertStable() {
        const current = await lstat(path);
        directory(current, true);
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw new DiagnosticError("unsafe_path");
      },
    };
    await held.assertStable();
    const result = await action(held);
    await held.assertStable();
    return result;
  } finally { for (const handle of handles.reverse()) await handle.close().catch(() => undefined); }
}
export async function privateRead(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat(); regular(stats);
    if (stats.size > maxBytes) throw new DiagnosticError("quota");
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    // Reject growth while reading rather than allowing readFile to allocate unbounded data.
    const final = await handle.stat(); regular(final);
    if (final.size !== stats.size || offset !== stats.size) throw new DiagnosticError("io");
    return bytes;
  } finally { await handle.close(); }
}
export async function privateJson<T>(path: string, maxBytes = 64 * 1024): Promise<T> {
  try { return JSON.parse((await privateRead(path, maxBytes)).toString("utf8")) as T; }
  catch (error) { if (error instanceof SyntaxError) throw new DiagnosticError("invalid"); throw error; }
}
export async function privateExists(path: string): Promise<boolean> {
  try { const stats = await lstat(path); regular(stats); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
export async function privateDirectoryExists(path: string): Promise<boolean> {
  try { directory(await lstat(path), true); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
export async function privateMkdir(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  directory(await lstat(path), true);
}
export async function privateEntries(path: string, limit = 8192): Promise<string[]> {
  directory(await lstat(path), true);
  const entries: string[] = [];
  const handle = await opendir(path, { bufferSize: 32 });
  for await (const entry of handle) {
    if (entries.length === limit) throw new DiagnosticError("quota");
    entries.push(entry.name);
  }
  return entries.sort();
}
export async function privateStat(path: string): Promise<Stats> { const stats = await lstat(path); regular(stats); return stats; }
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle.close(); }
}
export async function syncPrivateFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    regular(await handle.stat());
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle.close(); }
}
export async function atomicPrivateWrite(path: string, data: string | Uint8Array): Promise<void> {
  await privateExists(path);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    regular(await handle.stat());
    await handle.writeFile(data); await handle.sync(); await handle.close(); handle = undefined;
    await privateExists(path);
    await rename(temporary, path); await syncDirectory(dirname(path));
  } finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
}
export async function privateAppend(path: string, line: string): Promise<void> {
  const handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stats = await handle.stat(); regular(stats);
    if (stats.size > 0) {
      const last = Buffer.allocUnsafe(1);
      const read = await handle.read(last, 0, 1, stats.size - 1);
      if (read.bytesRead !== 1) throw new DiagnosticError("io");
      if (last[0] !== 10) throw new DiagnosticError("invalid");
    }
    const bytes = Buffer.from(line);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      if (!bytesWritten) throw new DiagnosticError("io");
      offset += bytesWritten;
    }
  } finally { await handle.close(); }
}
/** No recursive rm: a replaced entry can never redirect deletion into another tree. */
export async function removePrivateTree(path: string, depth = 0): Promise<void> {
  if (depth > 4) throw new DiagnosticError("unsafe_path");
  const stats = await lstat(path);
  if (stats.isDirectory()) {
    directory(stats, true);
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      if (stats.dev !== actual.dev || stats.ino !== actual.ino) throw new DiagnosticError("unsafe_path");
      const pinned = process.platform === "linux" ? `/proc/self/fd/${handle.fd}/.` : path;
      for (const name of await privateEntries(pinned)) await removePrivateTree(join(pinned, name), depth + 1);
      const current = await lstat(path);
      if (stats.dev !== current.dev || stats.ino !== current.ino) throw new DiagnosticError("unsafe_path");
      await rmdir(path);
    } finally { await handle.close(); }
  } else { regular(stats); await unlink(path); }
}
export async function writePrivateDirectory(destination: string, files: Readonly<Record<string, string | Uint8Array>>, managedMetadata?: string, expiresAt?: number): Promise<void> {
  if (await privateDirectoryExists(destination)) throw new DiagnosticError("invalid");
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  await privateMkdir(temporary);
  try {
    const payload = managedMetadata === undefined ? temporary : join(temporary, "bundle");
    if (managedMetadata !== undefined) {
      await privateMkdir(payload);
      await atomicPrivateWrite(join(temporary, "metadata.json"), managedMetadata);
    }
    for (const [name, bytes] of Object.entries(files)) {
      if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name)) throw new DiagnosticError("unsafe_path");
      await atomicPrivateWrite(join(payload, name), bytes);
    }
    if (await privateDirectoryExists(destination)) throw new DiagnosticError("invalid");
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw new DiagnosticError("expired");
    await rename(temporary, destination); await syncDirectory(dirname(destination));
  } catch (error) { await removePrivateTree(temporary).catch(() => undefined); throw error; }
}
/** Called only under the root generation lock with temporary-space quota reserved. */
export async function replacePrivateDirectory(destination: string, files: Readonly<Record<string, string | Uint8Array>>, managedMetadata?: string, expiresAt?: number): Promise<void> {
  if (!await privateDirectoryExists(destination)) throw new DiagnosticError("missing");
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  const previous = join(dirname(destination), `.${basename(destination)}.old`);
  if (await privateDirectoryExists(previous)) throw new DiagnosticError("locked");
  await writePrivateDirectory(temporary, files, managedMetadata, expiresAt);
  try {
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw new DiagnosticError("expired");
    await rename(destination, previous);
    try { await rename(temporary, destination); }
    catch (error) { await rename(previous, destination); throw error; }
    await syncDirectory(dirname(destination));
    await removePrivateTree(previous);
    await syncDirectory(dirname(destination));
  } finally { if (await privateDirectoryExists(temporary)) await removePrivateTree(temporary); }
}
