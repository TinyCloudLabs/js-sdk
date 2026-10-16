import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

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

export interface SqliteLayoutEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  dev: string;
  ino: string;
}

export type SqliteLayoutIdentity = { dev: string; ino: string };
type Identity = Pick<BigIntStats, "dev" | "ino">;
type Component = { path: string; identity: Identity };
type Directory = {
  path: string;
  name: string;
  relative: string;
  identity: BigIntStats;
  handle: FileHandle;
  children: Child[];
  parent?: Directory;
  components?: Component[];
};
type Child = { path: string; relative: string; kind: SqliteLayoutEntry["kind"]; identity: BigIntStats; parent: Directory; directory?: Directory };

function sameFile(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function identityOf(path: string, kind: SqliteLayoutEntry["kind"], details: Identity): SqliteLayoutEntry {
  return { path, kind, dev: details.dev.toString(), ino: details.ino.toString() };
}

function fileKind(details: BigIntStats): SqliteLayoutEntry["kind"] {
  if (details.isFile()) return "file";
  if (details.isDirectory()) return "directory";
  if (details.isSymbolicLink()) return "symlink";
  throw new Error("Unsupported replica entry type.");
}

// On named-path platforms every ancestor, including the root, is a real
// directory whose identity must remain stable for the duration of deletion.
async function pathComponents(path: string): Promise<Component[]> {
  const absolute = resolve(path);
  const parts = absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean);
  let current = parse(absolute).root;
  const components: Component[] = [];
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    const details = await lstat(current, { bigint: true });
    if (details.isSymbolicLink()) throw new Error(`Symlink in replica path: ${current}`);
    if (!details.isDirectory()) throw new Error(`Replica path component is not a directory: ${current}`);
    components.push({ path: current, identity: details });
  }
  return components;
}

async function pinnedDirectory(path: string, parent?: Directory, relative = ""): Promise<Directory> {
  const components = process.platform === "linux" ? undefined : parent?.components ?? await pathComponents(path);
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink()) throw new Error(`Symlink in replica path: ${path}`);
  if (!before.isDirectory()) throw new Error("Replica directory is not a real directory.");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) {
      throw new Error("Replica directory changed during inspection.");
    }
    return {
      handle, identity: before, parent, components, children: [],
      relative, name: path,
      path: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function checkDirectory(directory: Directory): Promise<void> {
  if (directory.parent) await checkDirectory(directory.parent);
  else if (directory.components) {
    for (const component of directory.components) {
      const details = await lstat(component.path, { bigint: true });
      if (details.isSymbolicLink() || !details.isDirectory() || !sameFile(component.identity, details)) {
        throw new Error(`Replica path component changed: ${component.path}`);
      }
    }
  }
  const details = await lstat(directory.name, { bigint: true });
  if (!details.isDirectory() || !sameFile(directory.identity, details)) {
    throw new Error(`Replica directory changed: ${directory.relative || directory.name}`);
  }
}

async function inspect(dir: string, allowAdapterFence: boolean): Promise<{
  root: Directory; directories: Directory[];
  knownEntries: SqliteLayoutEntry[]; unknownPaths: string[]; unknownEntries: SqliteLayoutEntry[];
}> {
  const root = await pinnedDirectory(dir);
  const directories = [root];
  const unknownPaths: string[] = [];
  const knownEntries: SqliteLayoutEntry[] = [];
  const unknownEntries: SqliteLayoutEntry[] = [];
  let hasDatabase = false;
  try {
    async function walk(parent: Directory): Promise<void> {
      await checkDirectory(parent);
      for (const name of (await readdir(parent.path)).sort()) {
        await checkDirectory(parent);
        const relative = parent.relative ? `${parent.relative}/${name}` : name;
        const path = join(parent.path, name);
        const details = await lstat(path, { bigint: true });
        if (process.platform !== "linux" && details.isSymbolicLink()) {
          throw new Error(`Symlink in replica path: ${relative}`);
        }
        const kind = fileKind(details);
        const child: Child = { path, relative, kind, identity: details, parent };
        parent.children.push(child);
        if (parent.relative === "" && name === "replica.db" && kind === "file") hasDatabase = true;
        if (sourceKind(parent.relative, name, allowAdapterFence) !== kind) {
          unknownPaths.push(relative);
          unknownEntries.push(identityOf(relative, kind, details));
        } else {
          knownEntries.push(identityOf(relative, kind, details));
        }
        if (kind === "directory") {
          const directory = await pinnedDirectory(path, parent, relative);
          if (!sameFile(details, directory.identity)) {
            await directory.handle.close();
            throw new Error(`Replica directory changed during inspection: ${relative}`);
          }
          child.directory = directory;
          directories.push(directory);
          await walk(directory);
        }
      }
    }
    await walk(root);
    if (!hasDatabase) unknownPaths.push("replica.db");
    return { root, directories, knownEntries, unknownPaths, unknownEntries };
  } catch (error) {
    await closeDirectories(directories);
    throw error;
  }
}

async function closeDirectories(directories: Directory[]): Promise<void> {
  for (const directory of directories.reverse()) await directory.handle.close();
}

/** JSON-safe exact inventory of non-mirror entries for durable approval. */
export async function inspectSqliteReplicaLayout(
  dir: string, options: { allowAdapterFence?: boolean } = {},
): Promise<{ knownEntries: SqliteLayoutEntry[]; unknownPaths: string[]; unknownEntries: SqliteLayoutEntry[]; rootIdentity: SqliteLayoutIdentity }> {
  const inventory = await inspect(dir, options.allowAdapterFence === true);
  try {
    return {
      knownEntries: inventory.knownEntries, unknownPaths: inventory.unknownPaths, unknownEntries: inventory.unknownEntries,
      rootIdentity: { dev: inventory.root.identity.dev.toString(), ino: inventory.root.identity.ino.toString() },
    };
  } finally {
    await closeDirectories(inventory.directories);
  }
}

function approvedEntries(entries: readonly SqliteLayoutEntry[]): Map<string, SqliteLayoutEntry> {
  const approved = new Map<string, SqliteLayoutEntry>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null ||
        Object.keys(entry).sort().join(",") !== "dev,ino,kind,path" ||
        typeof entry.path !== "string" || !entry.path ||
        entry.path.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")) ||
        !["file", "directory", "symlink"].includes(entry.kind) ||
        typeof entry.dev !== "string" || !/^(0|[1-9][0-9]*)$/.test(entry.dev) ||
        typeof entry.ino !== "string" || !/^(0|[1-9][0-9]*)$/.test(entry.ino) ||
        approved.has(entry.path)) {
      throw new Error("Invalid or duplicate replica approval.");
    }
    approved.set(entry.path, entry);
  }
  return approved;
}

/** Lease holder only: delete enumerated files, never recurse into an unapproved child. */
export async function removeSqliteReplicaLayout(
  dir: string, options: {
    approvedUnknown?: readonly SqliteLayoutEntry[];
    expectedKnown?: readonly SqliteLayoutEntry[];
    allowMissingDatabase?: boolean;
    expectedRoot?: SqliteLayoutIdentity;
    allowAdapterFence?: boolean;
  } = {},
): Promise<void> {
  const inventory = await inspect(dir, options.allowAdapterFence === true);
  try {
    if (options.expectedRoot &&
        (options.expectedRoot.dev !== inventory.root.identity.dev.toString() ||
         options.expectedRoot.ino !== inventory.root.identity.ino.toString())) {
      throw new Error("Replica root identity changed since approval.");
    }
    const approved = approvedEntries(options.approvedUnknown ?? []);
    // Missing approved entries are safe after a partially completed prior attempt.
    // Every entry still present must match its original kind and inode.
    for (const entry of inventory.unknownEntries) {
      const match = approved.get(entry.path);
      if (!match || match.kind !== entry.kind || match.dev !== entry.dev || match.ino !== entry.ino) {
        throw new Error(`Unknown replica child or approval identity mismatch: ${entry.path}`);
      }
    }
    if (options.expectedKnown) {
      const expected = approvedEntries(options.expectedKnown);
      for (const entry of inventory.knownEntries) {
        const match = expected.get(entry.path);
        if (!match || match.kind !== entry.kind || match.dev !== entry.dev || match.ino !== entry.ino) {
          throw new Error(`Known replica child changed since preflight: ${entry.path}`);
        }
      }
    }
    if (options.allowMissingDatabase && inventory.knownEntries.some((entry) => entry.path === "replica.db")) {
      throw new Error("Replica database appeared after approval of its absence.");
    }
    if (inventory.unknownPaths.length !== inventory.unknownEntries.length &&
        inventory.root.children.length > 0 && !options.allowMissingDatabase) {
      throw new Error("Replica database is missing; cannot approve removal.");
    }
    // Keep the SQLite database until all other content is gone, so failures
    // before its unlink leave the mirror usable for a guarded retry.
    async function removeDirectory(directory: Directory): Promise<void> {
      for (const child of directory.children
        .sort((a, b) => (a.relative === "replica.db" ? 1 : b.relative === "replica.db" ? -1 : 0))) {
        if (child.directory) {
          await removeDirectory(child.directory);
        }
        await checkDirectory(directory);
        const details = await lstat(child.path, { bigint: true });
        if (process.platform !== "linux" && details.isSymbolicLink()) {
          throw new Error(`Symlink in replica path: ${child.relative}`);
        }
        if (fileKind(details) !== child.kind || !sameFile(child.identity, details)) {
          throw new Error(`Replica child identity changed: ${child.relative}`);
        }
        if (child.directory) await rmdir(child.path);
        else await unlink(child.path);
      }
    }
    await removeDirectory(inventory.root);
    await checkDirectory(inventory.root);
    await rmdir(inventory.root.name);
  } finally {
    await closeDirectories(inventory.directories);
  }
}
