import { lstat, open, readdir, realpath, rm, rmdir, stat } from "node:fs/promises";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import { ProfileDeletedError, profilePath, withProfileLock } from "@tinycloud/operations/state";
import { ReplicaError, ReplicaErrorCode, type LeaseToken } from "@tinycloud/replica";
import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";

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
async function inspectLegacyReplica(profile: string, root: string, entry: Dirent): Promise<{
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
    const children = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
    if (children.length > 0 && !children.some((child) => child.name === "replica.db" && child.isFile())) {
      throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" has files but no regular replica database`);
    }
    return { path, identity, empty: children.length === 0 };
  } finally {
    await handle.close();
  }
}

interface PinnedReplicaRoot {
  readonly path: string;
  assertNamed(): Promise<void>;
  close(): Promise<void>;
}

/** Pin the checked root for traversal; only remove its name after an inode check. */
async function pinReplicaRoot(profile: string, named: string, operation: "logout" | "reset"): Promise<PinnedReplicaRoot | null> {
  const initial = await lstat(named).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (await safeReplicaRoot(profile, named, operation) === null) return null;
  if (process.platform !== "linux") {
    throw refuseUnsafeReplicaPath(profile, "pinned replica removal is unavailable on this platform", operation);
  }
  const handle = await open(named, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat();
    const assertNamed = async () => {
      const current = await lstat(named);
      if (!current.isDirectory() || current.dev !== initial?.dev || current.ino !== initial?.ino ||
        current.dev !== pinned.dev || current.ino !== pinned.ino) {
        throw refuseUnsafeReplicaPath(profile, "the replicas directory changed during cleanup", operation);
      }
    };
    await assertNamed();
    return { path: `/proc/self/fd/${handle.fd}`, assertNamed, close: () => handle.close() };
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

/** Remove each replica through its fenced store API; refuse before deletion if any sync owns a lease. */
export async function removeProfileReplicas(profile: string, options: {
  discardLocalChanges?: boolean;
  heldLeases?: ReadonlyMap<string, LeaseToken>;
  preflightRoot?: PinnedReplicaRoot;
} = {}): Promise<string[]> {
  const { heldLeases, preflightRoot } = options;
  return withProfileLock(profile, async () => {
    const namedRoot = join(profilePath(profile), "replicas");
    const pinned = preflightRoot ?? await pinReplicaRoot(profile, namedRoot, "logout");
    if (!pinned) return [];
    if (preflightRoot) await pinned.assertNamed();
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
      // Preflight every entry before deleting even an empty interrupted store.
      const checked = await Promise.all(replicas.map(async (entry) => ({
        entry, ...await inspectLegacyReplica(profile, root, entry),
      })));
      const removed: string[] = [];
      const opened: Array<{ name: string; store: SqliteReplicaStore; lease: LeaseToken | null }> = [];
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
                (await readdir(`/proc/self/fd/${handle.fd}`)).length !== 0) {
              throw refuseUnsafeReplicaPath(profile, `empty replica entry "${entry.name}" changed during cleanup`);
            }
            await pinned.assertNamed();
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
        await loadSqlite();
        for (const { entry, empty } of checked) {
          if (empty) continue;
          const { path: entryPath, identity: expectedDirectory } = await safeReplicaEntry(profile, root, entry);
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
          opened.push({ name: entry.name, store, lease: null });
          if (await store.open() === null) {
            throw new CLIError("REPLICA_PURGE_FAILED", `Replica "${entry.name}" has no initialized store; logout cleared the session but removed no replicas.`, ExitCode.ERROR);
          }
          const lease = heldLeases?.get(join(namedRoot, entry.name)) ?? await store.acquireSyncLease(SYNC_LEASE_MS);
          if (lease === null) {
            throw new CLIError("REPLICA_BUSY", `Cannot log out: replica "${entry.name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
          }
          opened[opened.length - 1]!.lease = lease;
        }
        // Empty interrupted entries were already removed before SQLite opened.
        for (const replica of opened) {
          try {
            await replica.store.destroy(replica.lease!, { discardLocalChanges: options.discardLocalChanges === true });
            removed.push(replica.name);
          } catch (error) {
            const replicaStillExists = await lstat(join(root, replica.name)).then(
              () => true,
              (statError: NodeJS.ErrnoException) => statError.code !== "ENOENT",
            );
            if (!replicaStillExists) removed.push(replica.name);
            const remaining = opened.filter(({ name }) => !removed.includes(name)).map(({ name }) => name);
            throw new CLIError(
              "REPLICA_PURGE_FAILED",
              `Logout cleared the session, but replica removal failed. Removed: ${removed.length ? removed.join(", ") : "none"}. Not removed: ${remaining.join(", ") || "none"}. ${error instanceof Error ? error.message : String(error)}`,
              ExitCode.ERROR,
              { replicasRemoved: removed, replicasRemaining: remaining },
            );
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
        await Promise.all(opened.map(async ({ name, store, lease }) => {
          if (lease !== null && heldLeases?.has(join(namedRoot, name)) !== true) await store.releaseLease(lease).catch(() => undefined);
          await store.close().catch(() => undefined);
        }));
      }
    } finally {
      if (!preflightRoot) await pinned.close();
    }
  });
}

async function assertSafeFlagReplica(profile: string, root: string, partition: string, name: string): Promise<{ dev: number; ino: number }> {
  const rootReal = await safeReplicaRoot(profile, root);
  if (rootReal === null) throw refuseUnsafeReplicaPath(profile, `the replication root "${root}" disappeared`);
  const partitionPath = join(root, partition);
  const partitionStats = await lstat(partitionPath);
  if (partitionStats.isSymbolicLink() || !partitionStats.isDirectory()) {
    throw refuseUnsafeReplicaPath(profile, `replication entry "${partition}" is not a real directory`);
  }
  const partitionReal = await realpath(partitionPath);
  if (!partitionReal.startsWith(rootReal + sep)) {
    throw refuseUnsafeReplicaPath(profile, `replication entry "${partition}" resolves outside the replication root`);
  }
  const replicasRoot = join(partitionPath, "replicas");
  const replicasStats = await lstat(replicasRoot);
  if (replicasStats.isSymbolicLink() || !replicasStats.isDirectory()) {
    throw refuseUnsafeReplicaPath(profile, `replication replicas path "${replicasRoot}" is not a real directory`);
  }
  const replicaPath = join(replicasRoot, name);
  const replicaStats = await lstat(replicaPath);
  if (replicaStats.isSymbolicLink() || !replicaStats.isDirectory()) {
    throw refuseUnsafeReplicaPath(profile, `replication replica "${name}" is not a real directory`);
  }
  const replicaReal = await realpath(replicaPath);
  if (!replicaReal.startsWith(partitionReal + sep)) {
    throw refuseUnsafeReplicaPath(profile, `replication replica "${name}" resolves outside the partition`);
  }
  const database = await lstat(join(replicaPath, "replica.db"));
  if (database.isSymbolicLink() || !database.isFile()) {
    throw refuseUnsafeReplicaPath(profile, `replication database "${name}" is not a regular file`);
  }
  return { dev: replicaStats.dev, ino: replicaStats.ino };
}

/** Purge every flag-owned identity partition and remove its diagnostics root. */
export async function removeProfileReplication(profile: string, heldLeases?: ReadonlyMap<string, LeaseToken>, preflightRoot?: PinnedReplicaRoot): Promise<string[]> {
  return withProfileLock(profile, async () => {
    const namedRoot = join(profilePath(profile), "replication");
    const pinned = preflightRoot ?? await pinReplicaRoot(profile, namedRoot, "logout");
    if (!pinned) return [];
    if (preflightRoot) await pinned.assertNamed();
    try {
      const root = pinned.path;
      const rootReal = (await safeReplicaRoot(profile, root))!;
      const profileReal = await realpath(profilePath(profile));
      const partitions = await readdir(root, { withFileTypes: true });
      const opened: Array<{ name: string; path: string; store: SqliteReplicaStore; lease: LeaseToken }> = [];
      const removed: string[] = [];
      let deleting = false;
      try {
        for (const partition of partitions) {
          const partitionPath = join(root, partition.name);
          const partitionStats = await lstat(partitionPath);
          if (partition.isSymbolicLink() || partitionStats.isSymbolicLink()) {
            throw refuseUnsafeReplicaPath(profile, `replication entry "${partition.name}" is a symlink`);
          }
          if (partitionStats.isDirectory()) {
            const partitionReal = await realpath(partitionPath);
            if (!partitionReal.startsWith(rootReal + sep) || !partitionReal.startsWith(profileReal + sep)) {
              throw refuseUnsafeReplicaPath(profile, `replication entry "${partition.name}" resolves outside the selected profile`);
            }
            const replicasRoot = join(partitionPath, "replicas");
            const replicasStats = await lstat(replicasRoot).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (!replicasStats) continue;
            if (replicasStats.isSymbolicLink() || !replicasStats.isDirectory()) {
              throw refuseUnsafeReplicaPath(profile, `replication replicas path "${replicasRoot}" is not a real directory`);
            }
            const replicas = await readdir(replicasRoot, { withFileTypes: true });
            for (const replica of replicas) {
              const replicaPath = join(replicasRoot, replica.name);
              const replicaStats = await lstat(replicaPath);
              if (replica.isSymbolicLink() || replicaStats.isSymbolicLink() || !replicaStats.isDirectory()) {
                throw refuseUnsafeReplicaPath(profile, `replication replica "${replica.name}" is not a real directory`);
              }
              const replicaReal = await realpath(replicaPath);
              if (!replicaReal.startsWith(rootReal + sep)) {
                throw refuseUnsafeReplicaPath(profile, `replication replica "${replica.name}" resolves outside the replication root`);
              }
              const database = await lstat(join(replicaPath, "replica.db")).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              });
              if (!database) continue;
              if (database.isSymbolicLink() || !database.isFile()) {
                throw refuseUnsafeReplicaPath(profile, `replication database "${replica.name}" is not a regular file`);
              }
            }
          } else if (!partitionStats.isFile()) {
            throw refuseUnsafeReplicaPath(profile, `replication path "${partition.name}" is not a regular file or directory`);
          }
        }

        const hasReplicaDatabase = await Promise.all(partitions.filter((entry) => entry.isDirectory()).map(async (partition) => {
          return Promise.all((await readdir(join(root, partition.name, "replicas"), { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory())
            .map((entry) => lstat(join(root, partition.name, "replicas", entry.name, "replica.db")).then(() => true, () => false)));
        })).then((values) => values.some((partition) => partition.some(Boolean)));
        if (hasReplicaDatabase) await loadSqlite();
        for (const partition of partitions.filter((entry) => entry.isDirectory())) {
          const replicasRoot = join(root, partition.name, "replicas");
          for (const entry of await readdir(replicasRoot, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isDirectory()) continue;
            const database = await lstat(join(replicasRoot, entry.name, "replica.db")).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (!database) continue;
            const name = `replication/${partition.name}/${entry.name}`;
            const expectedDirectory = await assertSafeFlagReplica(profile, root, partition.name, entry.name);
            const store = await SqliteReplicaStore.open(join(replicasRoot, entry.name), {
              create: false,
              expectedDirectory,
              guard: async (action) => withProfileLock(profile, async () => {
                await assertSafeFlagReplica(profile, root, partition.name, entry.name);
                return action();
              }, { requireProfile: true }),
            });
            try {
              if (await store.open() === null) {
                throw new CLIError("REPLICA_PURGE_FAILED", `Logout cleared the session, but flag replica "${name}" has no initialized store.`, ExitCode.ERROR);
              }
              const leasePath = join(namedRoot, partition.name, "replicas", entry.name);
              const lease = heldLeases?.get(leasePath) ?? await store.acquireSyncLease(SYNC_LEASE_MS);
              if (lease === null) {
                throw new CLIError("REPLICA_BUSY", `Cannot log out: flag replica "${name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
              }
              opened.push({ name, path: leasePath, store, lease });
            } catch (error) {
              await store.close().catch(() => undefined);
              throw error;
            }
          }
        }
        deleting = true;
        for (const item of opened) {
          await item.store.destroy(item.lease);
          removed.push(item.name);
        }
        await pinned.assertNamed();
        for (const entry of await readdir(root)) await rm(join(root, entry), { recursive: true, force: true });
        await pinned.assertNamed();
        await rmdir(namedRoot);
        return removed;
      } catch (error) {
        if (deleting) {
          const remaining = opened.filter(({ name }) => !removed.includes(name)).map(({ name }) => name);
          throw new CLIError(
            "REPLICA_PURGE_FAILED",
            `Logout cleared the session, but replication cleanup failed. Removed: ${removed.join(", ") || "none"}. Not removed: ${remaining.join(", ") || "none"}. ${error instanceof Error ? error.message : String(error)}`,
            ExitCode.ERROR,
            { replicasRemoved: removed, replicasRemaining: remaining },
          );
        }
        if (error instanceof CLIError) throw error;
        throw new CLIError("REPLICA_PURGE_FAILED", `Logout cleared the session, but replication cleanup failed; no flag replicas were removed. ${error instanceof Error ? error.message : String(error)}`, ExitCode.ERROR);
      } finally {
        await Promise.all(opened.map(async ({ path, store, lease }) => {
          if (heldLeases?.has(path) !== true) await store.releaseLease(lease).catch(() => undefined);
          await store.close().catch(() => undefined);
        }));
      }
    } finally {
      if (!preflightRoot) await pinned.close();
    }
  });
}

async function acquireLogoutLeases(profile: string): Promise<{
  stores: Array<{ path: string; store: SqliteReplicaStore; lease: LeaseToken }>;
  roots: Map<string, PinnedReplicaRoot>;
}> {
  return withProfileLock(profile, async () => {
    let sqliteLoaded = false;
    const opened: Array<{ path: string; store: SqliteReplicaStore; lease: LeaseToken }> = [];
    const roots = new Map<string, PinnedReplicaRoot>();
    try {
      const legacyNamed = join(profilePath(profile), "replicas");
      const legacyPin = await pinReplicaRoot(profile, legacyNamed, "logout");
      if (legacyPin) {
        roots.set("replicas", legacyPin);
        const legacyRoot = legacyPin.path;
        const entries = (await readdir(legacyRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const { path, identity: expectedDirectory, empty } = await inspectLegacyReplica(profile, legacyRoot, entry);
          if (empty) continue;
          if (!sqliteLoaded) {
            await loadSqlite();
            sqliteLoaded = true;
          }
          const store = await SqliteReplicaStore.open(path, {
            create: false,
            expectedDirectory,
            guard: async (action) => withProfileLock(profile, async () => {
              await safeReplicaEntry(profile, legacyRoot, entry);
              return action();
            }, { requireProfile: true }),
          });
          try {
            if (await store.open() === null) {
              throw new CLIError("REPLICA_PURGE_FAILED", `Replica "${entry.name}" has no initialized store; logout cleared the session but removed no replicas.`, ExitCode.ERROR);
            }
            const lease = await store.acquireSyncLease(SYNC_LEASE_MS);
            if (lease === null) {
              throw new CLIError("REPLICA_BUSY", `Cannot log out: replica "${entry.name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
            }
            opened.push({ path: join(legacyNamed, entry.name), store, lease });
          } catch (error) {
            await store.close().catch(() => undefined);
            throw error;
          }

        }
      }
      const replicationNamed = join(profilePath(profile), "replication");
      const replicationPin = await pinReplicaRoot(profile, replicationNamed, "logout");
      if (replicationPin) {
        roots.set("replication", replicationPin);
        const replicationRoot = replicationPin.path;
        const replicationReal = (await safeReplicaRoot(profile, replicationRoot))!;
        const partitions = await readdir(replicationRoot, { withFileTypes: true });
        for (const partition of partitions) {
          const partitionPath = join(replicationRoot, partition.name);
          const partitionStats = await lstat(partitionPath);
          if (partition.isSymbolicLink() || partitionStats.isSymbolicLink()) {
            throw refuseUnsafeReplicaPath(profile, `replication entry "${partition.name}" is a symlink`);
          }
          if (!partitionStats.isDirectory()) {
            if (!partitionStats.isFile()) throw refuseUnsafeReplicaPath(profile, `replication path "${partition.name}" is not a regular file or directory`);
            continue;
          }
          const partitionReal = await realpath(partitionPath);
          if (!partitionReal.startsWith(replicationReal + sep)) {
            throw refuseUnsafeReplicaPath(profile, `replication entry "${partition.name}" resolves outside the replication root`);
          }
          const replicasRoot = join(partitionPath, "replicas");
          const replicasStats = await lstat(replicasRoot).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (!replicasStats) continue;
          if (replicasStats.isSymbolicLink() || !replicasStats.isDirectory()) {
            throw refuseUnsafeReplicaPath(profile, `replication replicas path "${replicasRoot}" is not a real directory`);
          }
          for (const replica of await readdir(replicasRoot, { withFileTypes: true })) {
            const path = join(replicasRoot, replica.name);
            const stats = await lstat(path);
            if (!replica.isDirectory() || replica.isSymbolicLink() || stats.isSymbolicLink() || !stats.isDirectory()) {
              throw refuseUnsafeReplicaPath(profile, `replication replica "${replica.name}" is not a real directory`);
            }
            const database = await lstat(join(path, "replica.db")).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (!database) continue;
            if (database.isSymbolicLink() || !database.isFile()) {
              throw refuseUnsafeReplicaPath(profile, `replication database "${replica.name}" is not a regular file`);
            }
            const replicaReal = await realpath(path);
            if (!replicaReal.startsWith(replicationReal + sep)) {
              throw refuseUnsafeReplicaPath(profile, `replication replica "${replica.name}" resolves outside the replication root`);
            }
            if (!sqliteLoaded) {
              await loadSqlite();
              sqliteLoaded = true;
            }
            const expectedDirectory = await assertSafeFlagReplica(profile, replicationRoot, partition.name, replica.name);
            const store = await SqliteReplicaStore.open(path, {
              create: false,
              expectedDirectory,
              guard: async (action) => withProfileLock(profile, async () => {
                await assertSafeFlagReplica(profile, replicationRoot, partition.name, replica.name);
                return action();
              }, { requireProfile: true }),
            });
            try {
              if (await store.open() === null) {
                throw new CLIError("REPLICA_PURGE_FAILED", `Logout cleared the session, but flag replica "replication/${partition.name}/${replica.name}" has no initialized store.`, ExitCode.ERROR);
              }
              const lease = await store.acquireSyncLease(SYNC_LEASE_MS);
              if (lease === null) {
                throw new CLIError("REPLICA_BUSY", `Cannot log out: flag replica "replication/${partition.name}/${replica.name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
              }
              opened.push({ path: join(replicationNamed, partition.name, "replicas", replica.name), store, lease });
            } catch (error) {
              await store.close().catch(() => undefined);
              throw error;
            }

          }
        }
      }
      return { stores: opened, roots };
    } catch (error) {
      await Promise.all(opened.map(async ({ store, lease }) => {
        await store.releaseLease(lease).catch(() => undefined);
        await store.close().catch(() => undefined);
      }));
      await Promise.all([...roots.values()].map((root) => root.close()));
      throw error;
    }
  });
}

/** Acquire every legacy and flag-owned lease and delete both roots under one profile-lock turn. */
export async function removeProfileReplicasAndReplication(profile: string): Promise<string[]> {
  return withProfileLock(profile, async () => {
    const acquired = await acquireLogoutLeases(profile);
    const heldLeases = new Map(acquired.stores.map(({ path, lease }) => [path, lease]));
    let legacyRemoved: string[] = [];
    try {
      legacyRemoved = await removeProfileReplicas(profile, {
        heldLeases, preflightRoot: acquired.roots.get("replicas"),
      });
      const replication = await removeProfileReplication(profile, heldLeases, acquired.roots.get("replication"));
      return [...legacyRemoved, ...replication];
    } catch (error) {
      const partialRemoved = error instanceof CLIError && Array.isArray(error.metadata?.replicasRemoved)
        ? error.metadata.replicasRemoved.filter((name): name is string => typeof name === "string")
        : [];
      const removed = [...new Set([...legacyRemoved, ...partialRemoved])];
      const removedSet = new Set(removed);
      const remaining = acquired.stores
        .map(({ path }) => {
          const name = relative(profilePath(profile), path).split(sep).join("/");
          return name.startsWith("replication/") ? name.replace("/replicas/", "/") : name.split("/").at(-1)!;
        })
        .filter((name) => !removedSet.has(name));
      throw new CLIError(
        error instanceof CLIError ? error.code : "REPLICA_PURGE_FAILED",
        `Logout cleared the session, but replica cleanup failed. Removed: ${removed.join(", ") || "none"}. Not removed: ${remaining.join(", ") || "none"}. ${error instanceof Error ? error.message : String(error)}`,
        error instanceof CLIError ? error.exitCode : ExitCode.ERROR,
        { replicasRemoved: removed, replicasRemaining: remaining },
      );
    } finally {
      await Promise.all(acquired.stores.map(async ({ store, lease }) => {
        await store.releaseLease(lease).catch(() => undefined);
        await store.close().catch(() => undefined);
      }));
      await Promise.all([...acquired.roots.values()].map((root) => root.close()));
    }
  });
}
