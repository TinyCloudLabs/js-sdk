import { lstat, open, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ProfileDeletedError, profilePath, withProfileLock } from "@tinycloud/operations/state";
import { ReplicaError, ReplicaErrorCode, type LeaseToken } from "@tinycloud/replica";
import { SqliteReplicaStore, inspectSqliteReplicaLayout, removeSqliteReplicaLayout, type SqliteLayoutEntry } from "@tinycloud/replica/sqlite";

import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

const SYNC_LEASE_MS = 60_000;

function refuseUnsafeReplicaPath(profile: string, detail: string, operation: "logout" | "reset" = "logout"): CLIError {
  return new CLIError(
    "REPLICA_PURGE_FAILED",
    operation === "logout"
      ? `Logout for profile "${profile}" cleared the session, but ${detail}; the replicas were left untouched.`
      : `Cannot reset a replica in profile "${profile}": ${detail}; no replica was removed.`,
    ExitCode.ERROR,
  );
}
/** Return a real replica root only when it is a real directory inside this profile. */
async function safeReplicaRoot(profile: string, root: string, operation: "logout" | "reset" = "logout"): Promise<string | null> {
  let rootStats: Stats;
  try {
    rootStats = root.startsWith("/proc/self/fd/") ? await stat(root) : await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw refuseUnsafeReplicaPath(profile, `the replicas directory "${root}" is a symlink`, operation);
  }
  if (!rootStats.isDirectory()) {
    throw refuseUnsafeReplicaPath(profile, `the replicas path "${root}" is not a real directory`, operation);
  }

  const [profileRealPath, rootRealPath] = await Promise.all([realpath(profilePath(profile)), realpath(root)]);
  if (!rootRealPath.startsWith(profileRealPath + sep)) {
    throw refuseUnsafeReplicaPath(profile, `the replicas directory "${root}" resolves outside the selected profile`, operation);
  }
  return rootRealPath;
}

/** Refuse symlinks and escaped paths before opening or deleting any replica store. */
async function safeReplicaEntry(profile: string, root: string, entry: Dirent, operation: "logout" | "reset" = "logout"): Promise<{ path: string; identity: { dev: number; ino: number } }> {
  const entryPath = join(root, entry.name);
  const rootRealPath = await safeReplicaRoot(profile, root, operation);
  if (rootRealPath === null) {
    throw refuseUnsafeReplicaPath(profile, `the replicas directory "${root}" disappeared`, operation);
  }
  const entryStats = await lstat(entryPath);
  if (entry.isSymbolicLink() || entryStats.isSymbolicLink()) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" is a symlink`, operation);
  }
  if (!entry.isDirectory() || !entryStats.isDirectory()) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" is not a real directory`, operation);
  }

  const entryRealPath = await realpath(entryPath);
  if (!entryRealPath.startsWith(rootRealPath + sep)) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" resolves outside the replicas directory`, operation);
  }
  return { path: entryPath, identity: { dev: entryStats.dev, ino: entryStats.ino } };
}

/** Inspect a pinned legacy child before either lease acquisition or cleanup. */
async function inspectLegacyReplica(profile: string, root: string, entry: Dirent, allowUnrecognizedDatabase = false): Promise<{
  path: string;
  identity: { dev: number; ino: number };
  empty: boolean;
}> {
  const { path, identity } = await safeReplicaEntry(profile, root, entry);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const pinnedEntry = await handle.stat();
    if (pinnedEntry.dev !== identity.dev || pinnedEntry.ino !== identity.ino) {
      throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" changed during inspection`);
    }
    const children = await readdir(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path, { withFileTypes: true });
    if (children.length > 0 && !allowUnrecognizedDatabase &&
        !children.some((child) => child.name === "replica.db" && child.isFile())) {
      throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" has files but no regular replica database`);
    }
    return { path, identity, empty: children.length === 0 };
  } finally {
    await handle.close();
  }
}

interface PinnedReplicaRoot {
  readonly path: string;
  readonly identity: { dev: string; ino: string };
  assertNamed(): Promise<void>;
  close(): Promise<void>;
}

/** Pin the checked root for traversal; named-path logout additionally verifies every ancestor. */
async function pinReplicaRoot(
  profile: string, named: string, operation: "logout" | "reset", allowNamedLogout = false,
): Promise<PinnedReplicaRoot | null> {
  const initial = await lstat(named, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (await safeReplicaRoot(profile, named, operation) === null) return null;
  if (process.platform !== "linux" && !allowNamedLogout) {
    throw refuseUnsafeReplicaPath(profile, "pinned replica removal is unavailable on this platform", operation);
  }
  const ancestors: Array<{ path: string; dev: bigint; ino: bigint }> = [];
  if (process.platform !== "linux") {
    for (let path = resolve(named); ; path = dirname(path)) {
      const details = await lstat(path, { bigint: true });
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw refuseUnsafeReplicaPath(profile, `replica path component "${path}" is not a real directory`, operation);
      }
      ancestors.push({ path, dev: details.dev, ino: details.ino });
      if (dirname(path) === path) break;
    }
  }
  const handle = await open(named, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat({ bigint: true });
    const assertNamed = async () => {
      for (const component of ancestors) {
        const details = await lstat(component.path, { bigint: true });
        if (!details.isDirectory() || details.isSymbolicLink() ||
            details.dev !== component.dev || details.ino !== component.ino) {
          throw refuseUnsafeReplicaPath(profile, `replica path component "${component.path}" changed during cleanup`, operation);
        }
      }
      const current = await lstat(named, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== initial?.dev || current.ino !== initial?.ino ||
          current.dev !== pinned.dev || current.ino !== pinned.ino) {
        throw refuseUnsafeReplicaPath(profile, "the replicas directory changed during cleanup", operation);
      }
    };
    await assertNamed();
    return {
      path: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : named,
      identity: { dev: pinned.dev.toString(), ino: pinned.ino.toString() },
      assertNamed,
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Pin the checked replicas root while SQLite opens and removes its entry.
 * A concurrent rename of the root cannot redirect removal into another profile.
 */
export async function withPinnedReplicaForReset<T>(
  profile: string,
  name: string,
  action: (path: string, recheck: () => Promise<void>, identity: { dev: number; ino: number }) => Promise<T>,
): Promise<T> {
  return withProfileLock(profile, async () => {
    const root = join(profilePath(profile), "replicas");
    const pinned = await pinReplicaRoot(profile, root, "reset");
    if (!pinned) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Profile "${profile}" has no replicas.`);
    try {
      const fdRoot = pinned.path;
      const entry = (await readdir(fdRoot, { withFileTypes: true })).find((item) => item.name === name);
      if (!entry) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Replica "${name}" was not found.`);
      const { path, identity: initial } = await safeReplicaEntry(profile, fdRoot, entry, "reset");
      const recheck = async () => {
        const current = await lstat(path);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino) {
          throw refuseUnsafeReplicaPath(profile, `replica entry "${name}" changed during removal`, "reset");
        }
      };
      await recheck();
      return await action(path, recheck, { dev: initial.dev, ino: initial.ino });
    } finally {
      await pinned.close();
    }
  });
}

type LegacyRemovalOptions = {
  /** Descriptive only; never authorizes a file outside approvedUnknown. */
  discardLocalChanges?: boolean;
  approvedUnknown?: readonly SqliteLayoutEntry[];
  knownRoots?: readonly { path: string; dev: string; ino: string }[];
  knownEntries?: readonly SqliteLayoutEntry[];
  missingDatabases?: readonly string[];
};

function legacyInventory(profile: string, options: LegacyRemovalOptions) {
  const supplied = options.approvedUnknown !== undefined || options.knownRoots !== undefined ||
    options.knownEntries !== undefined || options.missingDatabases !== undefined;
  if (!supplied) return null;
  if (!Array.isArray(options.approvedUnknown) || !Array.isArray(options.knownRoots) ||
      !Array.isArray(options.knownEntries) || !Array.isArray(options.missingDatabases)) {
    throw refuseUnsafeReplicaPath(profile, "the recorded legacy inventory is incomplete");
  }
  const roots = new Map<string, { dev: string; ino: string }>();
  for (const root of options.knownRoots) {
    if (root.path !== "replicas" && !/^replicas\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(root.path) ||
        !/^(0|[1-9][0-9]*)$/.test(root.dev) || !/^(0|[1-9][0-9]*)$/.test(root.ino) || roots.has(root.path)) {
      throw refuseUnsafeReplicaPath(profile, "the recorded legacy root identity is invalid");
    }
    roots.set(root.path, root);
  }
  for (const [entries, minimumParts] of [
    [options.approvedUnknown, 2], [options.knownEntries, 3],
  ] as const) {
    const paths = new Set<string>();
    for (const entry of entries) {
      const parts = entry.path.split("/");
      if (parts.length < minimumParts || parts[0] !== "replicas" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(parts[1]!) ||
          parts.slice(2).some((part: string) => !part || part === "." || part === ".." || part.includes("\\")) ||
          paths.has(entry.path)) {
        throw refuseUnsafeReplicaPath(profile, "the recorded legacy child path is invalid");
      }
      paths.add(entry.path);
    }
  }
  const missingDatabases = new Set<string>();
  for (const path of options.missingDatabases) {
    if (!/^replicas\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/replica\.db$/.test(path) || missingDatabases.has(path)) {
      throw refuseUnsafeReplicaPath(profile, "the recorded missing database path is invalid");
    }
    missingDatabases.add(path);
  }
  return { roots, approvedUnknown: options.approvedUnknown, knownEntries: options.knownEntries, missingDatabases };
}

function childEntries(name: string, entries: readonly SqliteLayoutEntry[]): SqliteLayoutEntry[] {
  const prefix = `replicas/${name}/`;
  return entries.filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
}

function assertApprovedEntry(profile: string, path: string, actual: SqliteLayoutEntry, recorded: readonly SqliteLayoutEntry[]): void {
  const prior = recorded.find((entry) => entry.path === path);
  if (!prior || prior.kind !== actual.kind || prior.dev !== actual.dev || prior.ino !== actual.ino) {
    throw refuseUnsafeReplicaPath(profile, `legacy path "${path}" changed since the recorded inventory`);
  }
}

function assertRecordedChild(
  profile: string, name: string, layout: Awaited<ReturnType<typeof inspectSqliteReplicaLayout>>,
  inventory: NonNullable<ReturnType<typeof legacyInventory>>,
  empty: boolean,
): void {
  const prefix = `replicas/${name}/`;
  const root = inventory.roots.get(`replicas/${name}`);
  if (!root || root.dev !== layout.rootIdentity.dev || root.ino !== layout.rootIdentity.ino) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${name}" changed since the recorded inventory`);
  }
  const databaseEntry = layout.knownEntries.find((entry) => entry.path === "replica.db");
  const approvedDatabase = inventory.knownEntries.find((entry) => entry.path === prefix + "replica.db");
  const stableDatabase = databaseEntry?.kind === "file" && approvedDatabase?.kind === "file" &&
    databaseEntry.dev === approvedDatabase.dev && databaseEntry.ino === approvedDatabase.ino;
  for (const entry of layout.knownEntries) {
    const recorded = inventory.knownEntries.find((item) => item.path === prefix + entry.path);
    // SQLite can recreate its own sidecars while a lease is held or acquired.
    // Never extend this to the database, an unknown child, or a changed root.
    if (stableDatabase && entry.kind === "file" &&
        /^replica\.db-(?:wal|shm|journal)$/.test(entry.path) &&
        (recorded === undefined || recorded.kind === "file") &&
        !inventory.approvedUnknown.some((item) => item.path === prefix + entry.path)) continue;
    assertApprovedEntry(profile, prefix + entry.path, entry, inventory.knownEntries);
  }
  for (const entry of layout.unknownEntries) {
    assertApprovedEntry(profile, prefix + entry.path, entry, inventory.approvedUnknown);
  }
  const database = [...layout.knownEntries, ...layout.unknownEntries].some((entry) => entry.path === "replica.db");
  const missingWasApproved = inventory.missingDatabases.has(prefix + "replica.db");
  if (missingWasApproved && database ||
      !database && !empty && !missingWasApproved) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${name}" has a different database than was approved`);
  }
}

async function inspectApprovedUnknownRoot(
  profile: string, root: string, entry: Dirent,
  inventory: NonNullable<ReturnType<typeof legacyInventory>>,
): Promise<{
  entry: Dirent; path: string; identity: SqliteLayoutEntry;
  layout: Awaited<ReturnType<typeof inspectSqliteReplicaLayout>> | null;
}> {
  const relative = `replicas/${entry.name}`;
  if (inventory.roots.has(relative)) {
    throw refuseUnsafeReplicaPath(profile, `legacy entry "${entry.name}" has conflicting recorded identities`);
  }
  const path = join(root, entry.name);
  const info = await lstat(path, { bigint: true });
  const kind = info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : null;
  if (kind === null || process.platform !== "linux" && kind === "symlink") {
    throw refuseUnsafeReplicaPath(profile, `legacy entry "${entry.name}" cannot be removed safely`);
  }
  const identity: SqliteLayoutEntry = { path: relative, kind, dev: info.dev.toString(), ino: info.ino.toString() };
  assertApprovedEntry(profile, relative, identity, inventory.approvedUnknown);
  const layout = kind === "directory" ? await inspectSqliteReplicaLayout(path) : null;
  if (layout) {
    if (layout.rootIdentity.dev !== identity.dev || layout.rootIdentity.ino !== identity.ino) {
      throw refuseUnsafeReplicaPath(profile, `legacy entry "${entry.name}" changed during inspection`);
    }
    for (const child of [...layout.knownEntries, ...layout.unknownEntries]) {
      assertApprovedEntry(profile, `${relative}/${child.path}`, child, inventory.approvedUnknown);
    }
  }
  return { entry, path, identity, layout };
}

/** Remove each replica through a live lease or an exact DB-absent approval; never recurse. */
export async function removeProfileReplicas(profile: string, options: LegacyRemovalOptions = {}): Promise<string[]> {
  const inventory = legacyInventory(profile, options);
  return withProfileLock(profile, async () => {
    const namedRoot = join(profilePath(profile), "replicas");
    const pinned = await pinReplicaRoot(profile, namedRoot, "logout", true);
    if (!pinned) return [];
    const expectedRoot = inventory?.roots.get("replicas");
    if (inventory && (!expectedRoot || expectedRoot.dev !== pinned.identity.dev || expectedRoot.ino !== pinned.identity.ino)) {
      throw refuseUnsafeReplicaPath(profile, "the replicas directory changed since the recorded inventory");
    }
    const removeEmptyRoot = async (removed: string[]) => {
      try {
        await pinned.assertNamed();
        // The parent profile is pinned. rmdir removes only an empty entry here;
        // it cannot follow a replacement symlink into another directory.
        await rmdir(namedRoot);
      } catch (error) {
        throw new CLIError(
          "REPLICA_PURGE_FAILED",
          `Logout cleared the session, but the legacy replicas directory could not be removed after ${removed.length} replica(s) were erased. ${error instanceof Error ? error.message : String(error)}`,
          ExitCode.ERROR,
          { replicasRemoved: removed, replicasRemaining: [] },
        );
      }
    };
    try {
      const root = pinned.path;
      const replicas = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      if (replicas.length === 0) {
        await removeEmptyRoot([]);
        return [];
      }
      // An unknown top-level file or directory is removable only if every
      // descendant appears in the marker with its original type and inode.
      const unknownNames = new Set(replicas.filter((entry) =>
        inventory?.approvedUnknown.some((item) => item.path === `replicas/${entry.name}`)).map((entry) => entry.name));
      const unknownRoots = await Promise.all(replicas.filter((entry) => unknownNames.has(entry.name))
        .map((entry) => inspectApprovedUnknownRoot(profile, root, entry, inventory!)));
      // Validate every currently present entry before the first deletion or lease write.
      const checked = await Promise.all(replicas.filter((entry) => !unknownNames.has(entry.name)).map(async (entry) => {
        const databasePath = `replicas/${entry.name}/replica.db`;
        const allowUnrecognized = inventory?.missingDatabases.has(databasePath) ||
          inventory?.approvedUnknown.some((item) => item.path === databasePath) || false;
        const inspected = await inspectLegacyReplica(profile, root, entry, allowUnrecognized);
        const layout = inspected.empty ? null : await inspectSqliteReplicaLayout(inspected.path);
        if (inventory) {
          if (layout) assertRecordedChild(profile, entry.name, layout, inventory, false);
          else {
            const child = await lstat(inspected.path, { bigint: true });
            const recorded = inventory.roots.get(`replicas/${entry.name}`);
            if (!recorded || child.dev.toString() !== recorded.dev || child.ino.toString() !== recorded.ino) {
              throw refuseUnsafeReplicaPath(profile, `empty replica entry "${entry.name}" changed since the recorded inventory`);
            }
          }
        } else if (layout?.unknownEntries.length) {
          throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" contains unapproved files`);
        }
        return { entry, ...inspected, layout };
      }));
      const removed: string[] = [];
      const opened: Array<{ name: string; store: SqliteReplicaStore; lease: LeaseToken | null; closed: boolean }> = [];
      try {
        for (const { entry, identity, empty } of checked) {
          if (!empty) continue;
          await pinned.assertNamed();
          const current = await safeReplicaEntry(profile, root, entry);
          if (current.identity.dev !== identity.dev || current.identity.ino !== identity.ino) {
            throw refuseUnsafeReplicaPath(profile, `empty replica entry "${entry.name}" changed during cleanup`);
          }
          const handle = await open(current.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
          try {
            const pinnedEntry = await handle.stat();
            if (pinnedEntry.dev !== identity.dev || pinnedEntry.ino !== identity.ino ||
                (await readdir(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : current.path)).length !== 0) {
              throw refuseUnsafeReplicaPath(profile, `empty replica entry "${entry.name}" changed during cleanup`);
            }
            await pinned.assertNamed();
            const namedEntry = await lstat(current.path);
            if (!namedEntry.isDirectory() || namedEntry.dev !== pinnedEntry.dev || namedEntry.ino !== pinnedEntry.ino) {
              throw refuseUnsafeReplicaPath(profile, `empty replica entry "${entry.name}" changed at removal`);
            }
            await rmdir(current.path);
          } finally {
            await handle.close();
          }
          removed.push(entry.name);
        }
        if (removed.length === replicas.length) {
          await removeEmptyRoot(removed);
          return removed;
        }
        for (const { entry, empty, identity, layout } of checked) {
          if (empty || !layout?.knownEntries.some((item) => item.path === "replica.db")) continue;
          await pinned.assertNamed();
          const { path: entryPath, identity: expectedDirectory } = await safeReplicaEntry(profile, root, entry);
          if (expectedDirectory.dev !== identity.dev || expectedDirectory.ino !== identity.ino) {
            throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" changed before its lease`);
          }
          const store = await SqliteReplicaStore.open(entryPath, {
            create: false,
            expectedDirectory,
            guard: async (action) => {
              try {
                return await withProfileLock(profile, async () => {
                  await safeReplicaEntry(profile, root, entry);
                  return action();
                }, { requireProfile: true });
              } catch (error) {
                if (error instanceof ProfileDeletedError) {
                  throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Profile "${profile}" was deleted; its replicas are gone and nothing was written.`);
                }
                throw error;
              }
            },
          });
          opened.push({ name: entry.name, store, lease: null, closed: false });
          if (await store.open() === null) {
            throw new CLIError("REPLICA_PURGE_FAILED", `Replica "${entry.name}" has no initialized store; logout cleared the session but removed no replicas.`, ExitCode.ERROR);
          }
          const lease = await store.acquireSyncLease(SYNC_LEASE_MS);
          if (lease === null) {
            // Every caller runs after both credential files are gone.
            throw new CLIError("REPLICA_BUSY", `Logout cleared the session, but replica "${entry.name}" is syncing; no legacy replicas were removed. Re-run \`auth logout\` when the sync ends.`, ExitCode.ERROR);
          }
          opened[opened.length - 1]!.lease = lease;
        }
        // Empty interrupted entries were already removed. A DB-absent child has
        // no SQLite lease to acquire, so only its exact recorded layout may go.
        for (const { entry, empty, path, layout } of checked) {
          if (empty) continue;
          await pinned.assertNamed();
          const replica = opened.find(({ name }) => name === entry.name);
          try {
            if (replica && process.platform !== "linux") {
              await replica.store.close();
              replica.closed = true;
            }
            // Opening/closing the lease can replace SQLite sidecars. Reinspect
            // under the profile lock, then pin their current inode for unlink.
            const current = inventory && replica ? await inspectSqliteReplicaLayout(path) : null;
            if (current && inventory) assertRecordedChild(profile, entry.name, current, inventory, false);
            const layoutOptions = {
              approvedUnknown: inventory ? childEntries(entry.name, inventory.approvedUnknown) : [],
              expectedKnown: current?.knownEntries ?? (inventory ? childEntries(entry.name, inventory.knownEntries) : undefined),
              expectedRoot: inventory?.roots.get(`replicas/${entry.name}`),
              allowMissingDatabase: inventory?.missingDatabases.has(`replicas/${entry.name}/replica.db`) === true ||
                layout?.unknownEntries.some((item) => item.path === "replica.db") === true,
              allowAdapterFence: false,
            };
            if (replica && process.platform === "linux") {
              await replica.store.destroy(replica.lease!, layoutOptions);
            } else {
              await removeSqliteReplicaLayout(path, layoutOptions);
            }
            removed.push(entry.name);
          } catch (error) {
            const replicaStillExists = await lstat(join(root, entry.name)).then(
              () => true,
              (statError: NodeJS.ErrnoException) => statError.code !== "ENOENT",
            );
            if (!replicaStillExists) removed.push(entry.name);
            const remaining = replicas.filter((child) => !removed.includes(child.name)).map((child) => child.name);
            throw new CLIError(
              "REPLICA_PURGE_FAILED",
              `Logout cleared the session, but replica removal failed. Removed: ${removed.length ? removed.join(", ") : "none"}. Not removed: ${remaining.join(", ") || "none"}. ${error instanceof Error ? error.message : String(error)}`,
              ExitCode.ERROR,
              { replicasRemoved: removed, replicasRemaining: remaining },
            );
          }
        }
        for (const { entry, path, identity, layout } of unknownRoots) {
          await pinned.assertNamed();
          const current = await lstat(path, { bigint: true });
          const kind = current.isDirectory() ? "directory" : current.isSymbolicLink() ? "symlink" : current.isFile() ? "file" : null;
          if (kind !== identity.kind || current.dev.toString() !== identity.dev ||
              current.ino.toString() !== identity.ino ||
              process.platform !== "linux" && kind === "symlink") {
            throw refuseUnsafeReplicaPath(profile, `approved legacy entry "${entry.name}" changed at removal`);
          }
          if (layout) {
            await removeSqliteReplicaLayout(path, {
              approvedUnknown: layout.unknownEntries,
              expectedKnown: layout.knownEntries,
              expectedRoot: { dev: identity.dev, ino: identity.ino },
              allowMissingDatabase: !layout.knownEntries.some((child) => child.path === "replica.db"),
              allowAdapterFence: false,
            });
          } else {
            await unlink(path);
          }
        }
        await removeEmptyRoot(removed);
        return removed;
      } catch (error) {
        if (error instanceof CLIError) throw error;
        throw new CLIError(
          "REPLICA_PURGE_FAILED",
          `Logout cleared the session, but replica cleanup could not finish. Removed: ${removed.length ? removed.join(", ") : "none"}. ${error instanceof Error ? error.message : String(error)}`,
          ExitCode.ERROR,
        );
      } finally {
        await Promise.all(opened.map(async ({ name, store, lease, closed }) => {
          if (!closed) {
            if (lease !== null) await store.releaseLease(lease).catch(() => undefined);
            await store.close().catch(() => undefined);
          }
        }));
      }
    } finally {
      await pinned.close();
    }
  });
}
