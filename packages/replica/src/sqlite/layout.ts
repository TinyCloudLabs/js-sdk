import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const SQLITE_FILE = /^(?:replica\.db|replica\.db-(?:wal|shm|journal))$/;
const SHARD = /^[0-9a-f]{2}$/;
const HASH = /^[0-9a-f]{64}$/;
const TEMP = /^[0-9a-f]{64}\.[0-9a-f]{12}$/;

type Kind = "file" | "directory" | "unknown";

/** The only names this store creates beside its SQLite database. */
function sourceKind(parent: string, name: string, allowAdapterFence: boolean): Kind {
  if (parent === "") {
    if (SQLITE_FILE.test(name) || (allowAdapterFence &&
        (name === "fence.json" || /^fence[.]json[.][0-9a-f]{12}[.]tmp$/.test(name)))) return "file";
    return name === "blobs" ? "directory" : "unknown";
  }
  if (parent === "blobs") return name === ".tmp" || SHARD.test(name) ? "directory" : "unknown";
  if (parent === "blobs/.tmp") return TEMP.test(name) ? "file" : "unknown";
  if (parent.startsWith("blobs/") && SHARD.test(parent.slice(6))) {
    return HASH.test(name) && name.startsWith(parent.slice(6)) ? "file" : "unknown";
  }
  return "unknown";
}

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function pinnedDirectory(path: string) {
  const before = await lstat(path);
  if (!before.isDirectory()) throw new Error("Replica directory is not a real directory.");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  if (!sameFile(before, await handle.stat())) {
    await handle.close();
    throw new Error("Replica directory changed during inspection.");
  }
  return { handle, path: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path, before };
}

/** Files unknown to this read-only mirror, relative to the selected replica directory. */
async function inspectPinned(path: string, allowAdapterFence: boolean): Promise<{ unknownPaths: string[] }> {
  const unknownPaths: string[] = [];
  let hasDatabase = false;
  async function inspect(current: string, parent: string): Promise<void> {
    for (const entry of await readdir(current)) {
      const relative = parent ? `${parent}/${entry}` : entry;
      const child = join(current, entry);
      const kind = sourceKind(parent, entry, allowAdapterFence);
      const details = await lstat(child);
      if (parent === "" && entry === "replica.db" && details.isFile()) hasDatabase = true;
      if (kind === "directory" && details.isDirectory()) {
        const pinned = await pinnedDirectory(child);
        try { await inspect(pinned.path, relative); } finally { await pinned.handle.close(); }
      } else if (kind !== "file" || !details.isFile()) {
        unknownPaths.push(relative);
      }
    }
  }
  await inspect(path, "");
  if (!hasDatabase) unknownPaths.push("replica.db");
  return { unknownPaths };
}

export async function inspectSqliteReplicaLayout(
  dir: string, options: { allowAdapterFence?: boolean } = {},
): Promise<{ unknownPaths: string[] }> {
  const root = await pinnedDirectory(dir);
  try {
    return await inspectPinned(root.path, options.allowAdapterFence === true);
  } finally {
    await root.handle.close();
  }
}

/** Lease holder only: no recursive rm or symlink traversal, including under explicit discard. */
export async function removeSqliteReplicaLayout(
  dir: string, options: { discardLocalChanges?: boolean; allowAdapterFence?: boolean } = {},
): Promise<void> {
  const root = await pinnedDirectory(dir);
  try {
    if (!options.discardLocalChanges &&
        (await inspectPinned(root.path, options.allowAdapterFence === true)).unknownPaths.length > 0) {
      throw new Error("Unknown files in the replica; sync first or use --discard-local-changes.");
    }
    async function remove(path: string, parent: string): Promise<void> {
      const entries = await readdir(path);
      // Keep the SQLite database until all content and sidecars are gone: a
      // failed unlink then leaves a usable store for the next guarded retry.
      if (parent === "") entries.sort((a, b) => (a === "replica.db" ? 1 : b === "replica.db" ? -1 : 0));
      for (const entry of entries) {
        const relative = parent ? `${parent}/${entry}` : entry;
        const child = join(path, entry);
        const kind = sourceKind(parent, entry, options.allowAdapterFence === true);
        const details = await lstat(child);
        if (!options.discardLocalChanges &&
            ((details.isDirectory() && kind !== "directory") || (!details.isDirectory() && (kind !== "file" || !details.isFile())))) {
          throw new Error(`Unknown replica child ${relative}; sync first or use --discard-local-changes.`);
        }
        if (details.isDirectory()) {
          const pinned = await pinnedDirectory(child);
          try { await remove(pinned.path, relative); } finally { await pinned.handle.close(); }
          if (!sameFile(details, await lstat(child))) throw new Error("Replica directory changed during removal.");
          await rmdir(child);
        } else {
          // unlink removes a symlink itself; no target is opened, even with explicit discard.
          await unlink(child);
        }
      }
    }
    await remove(root.path, "");
    if (!sameFile(root.before, await lstat(dir))) throw new Error("Replica directory changed during removal.");
    await rmdir(dir);
  } finally {
    await root.handle.close();
  }
}
