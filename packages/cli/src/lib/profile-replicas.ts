import { lstat, readdir, realpath, rm } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join, sep } from "node:path";
import { ProfileDeletedError, profilePath, withProfileLock } from "@tinycloud/operations/state";
import { ReplicaError, ReplicaErrorCode, type LeaseToken } from "@tinycloud/replica";
import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";

import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

const SYNC_LEASE_MS = 60_000;

function refuseUnsafeReplicaPath(profile: string, detail: string): CLIError {
  return new CLIError(
    "REPLICA_PURGE_FAILED",
    `Logout for profile "${profile}" cleared the session, but ${detail}; the replicas were left untouched.`,
    ExitCode.ERROR,
  );
}
/** Return a real replica root only when it is a real directory inside this profile. */
async function safeReplicaRoot(profile: string, root: string): Promise<string | null> {
  let rootStats: Stats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw refuseUnsafeReplicaPath(profile, `the replicas directory "${root}" is a symlink`);
  }
  if (!rootStats.isDirectory()) {
    throw refuseUnsafeReplicaPath(profile, `the replicas path "${root}" is not a real directory`);
  }

  const [profileRealPath, rootRealPath] = await Promise.all([realpath(profilePath(profile)), realpath(root)]);
  if (!rootRealPath.startsWith(profileRealPath + sep)) {
    throw refuseUnsafeReplicaPath(profile, `the replicas directory "${root}" resolves outside the selected profile`);
  }
  return rootRealPath;
}

/** Refuse symlinks and escaped paths before opening or deleting any replica store. */
async function safeReplicaEntry(profile: string, root: string, entry: Dirent): Promise<string> {
  const entryPath = join(root, entry.name);
  const rootRealPath = await safeReplicaRoot(profile, root);
  if (rootRealPath === null) {
    throw refuseUnsafeReplicaPath(profile, `the replicas directory "${root}" disappeared`);
  }
  const entryStats = await lstat(entryPath);
  if (entry.isSymbolicLink() || entryStats.isSymbolicLink()) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" is a symlink`);
  }
  if (!entry.isDirectory() || !entryStats.isDirectory()) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" is not a real directory`);
  }

  const entryRealPath = await realpath(entryPath);
  if (!entryRealPath.startsWith(rootRealPath + sep)) {
    throw refuseUnsafeReplicaPath(profile, `replica entry "${entry.name}" resolves outside the replicas directory`);
  }
  return entryPath;
}

/** Remove each replica through its fenced store API; refuse before deletion if any sync owns a lease. */
export async function removeProfileReplicas(profile: string, heldLeases?: ReadonlyMap<string, LeaseToken>): Promise<string[]> {
  return withProfileLock(profile, async () => {
    const root = join(profilePath(profile), "replicas");
    if (await safeReplicaRoot(profile, root) === null) return [];
    const replicas = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    if (replicas.length === 0) return [];
    for (const entry of replicas) await safeReplicaEntry(profile, root, entry);
    await loadSqlite();
    const opened: Array<{ name: string; store: SqliteReplicaStore; lease: LeaseToken | null }> = [];
    try {
      for (const entry of replicas) {
        const entryPath = await safeReplicaEntry(profile, root, entry);
        const store = await SqliteReplicaStore.open(entryPath, {
          create: false,
          guard: async (action) => {
            try {
              return await withProfileLock(profile, action, { requireProfile: true });
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
        const lease = heldLeases?.get(entryPath) ?? await store.acquireSyncLease(SYNC_LEASE_MS);
        if (lease === null) {
          throw new CLIError("REPLICA_BUSY", `Cannot log out: replica "${entry.name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
        }
        opened[opened.length - 1]!.lease = lease;
      }
      const removed: string[] = [];
      for (const replica of opened) {
        try {
          await replica.store.destroy(replica.lease!);
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
      return removed;
    } catch (error) {
      if (error instanceof CLIError) throw error;
      throw new CLIError(
        "REPLICA_PURGE_FAILED",
        `Logout cleared the session, but replica cleanup could not start; no replicas were removed. ${error instanceof Error ? error.message : String(error)}`,
        ExitCode.ERROR,
      );
    } finally {
      await Promise.all(opened.map(async ({ name, store, lease }) => {
        if (lease !== null && heldLeases?.has(join(root, name)) !== true) await store.releaseLease(lease).catch(() => undefined);
        await store.close().catch(() => undefined);
      }));
    }
  });
}

/** Purge every flag-owned identity partition and remove its diagnostics root. */
export async function removeProfileReplication(profile: string, heldLeases?: ReadonlyMap<string, LeaseToken>): Promise<string[]> {
  return withProfileLock(profile, async () => {
    const root = join(profilePath(profile), "replication");
    const rootReal = await safeReplicaRoot(profile, root);
    if (rootReal === null) return [];
    const profileReal = await realpath(profilePath(profile));
    const partitions = await readdir(root, { withFileTypes: true });
    const opened: Array<{ name: string; path: string; store: SqliteReplicaStore; lease: LeaseToken }> = [];
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
          const store = await SqliteReplicaStore.open(join(replicasRoot, entry.name), { create: false, guard: async (action) => withProfileLock(profile, action, { requireProfile: true }) });
          if (await store.open() === null) {
            await store.close();
            throw new CLIError("REPLICA_PURGE_FAILED", `Logout cleared the session, but flag replica "${name}" has no initialized store.`, ExitCode.ERROR);
          }
          const lease = heldLeases?.get(join(replicasRoot, entry.name)) ?? await store.acquireSyncLease(SYNC_LEASE_MS);
          if (lease === null) {
            await store.close();
            throw new CLIError("REPLICA_BUSY", `Cannot log out: flag replica "${name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
          }
          opened.push({ name, path: join(replicasRoot, entry.name), store, lease });
        }
      }
      for (const item of opened) await item.store.destroy(item.lease);
      await rm(root, { recursive: true });
      return opened.map((item) => item.name);
    } catch (error) {
      if (error instanceof CLIError) throw error;
      throw new CLIError("REPLICA_PURGE_FAILED", `Logout cleared the session, but replication cleanup failed; the replication root was retained. ${error instanceof Error ? error.message : String(error)}`, ExitCode.ERROR);
    } finally {
      await Promise.all(opened.map(async ({ path, store, lease }) => {
        if (heldLeases?.has(path) !== true) await store.releaseLease(lease).catch(() => undefined);
        await store.close().catch(() => undefined);
      }));
    }
  });
}

async function acquireLogoutLeases(profile: string): Promise<Array<{ path: string; store: SqliteReplicaStore; lease: LeaseToken }>> {
  return withProfileLock(profile, async () => {
    let sqliteLoaded = false;
    const opened: Array<{ path: string; store: SqliteReplicaStore; lease: LeaseToken }> = [];
    try {
      const legacyRoot = join(profilePath(profile), "replicas");
      if (await safeReplicaRoot(profile, legacyRoot) !== null) {
        const entries = (await readdir(legacyRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const path = await safeReplicaEntry(profile, legacyRoot, entry);
          if (!sqliteLoaded) {
            await loadSqlite();
            sqliteLoaded = true;
          }
          const store = await SqliteReplicaStore.open(path, { create: false, guard: async (action) => withProfileLock(profile, action, { requireProfile: true }) });
          if (await store.open() === null) {
            await store.close();
            throw new CLIError("REPLICA_PURGE_FAILED", `Replica "${entry.name}" has no initialized store; logout cleared the session but removed no replicas.`, ExitCode.ERROR);
          }
          const lease = await store.acquireSyncLease(SYNC_LEASE_MS);
          if (lease === null) {
            await store.close();
            throw new CLIError("REPLICA_BUSY", `Cannot log out: replica "${entry.name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
          }
          opened.push({ path, store, lease });
        }
      }
      const replicationRoot = join(profilePath(profile), "replication");
      const replicationReal = await safeReplicaRoot(profile, replicationRoot);
      if (replicationReal !== null) {
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
            const store = await SqliteReplicaStore.open(path, { create: false, guard: async (action) => withProfileLock(profile, action, { requireProfile: true }) });
            if (await store.open() === null) {
              await store.close();
              throw new CLIError("REPLICA_PURGE_FAILED", `Logout cleared the session, but flag replica "replication/${partition.name}/${replica.name}" has no initialized store.`, ExitCode.ERROR);
            }
            const lease = await store.acquireSyncLease(SYNC_LEASE_MS);
            if (lease === null) {
              await store.close();
              throw new CLIError("REPLICA_BUSY", `Cannot log out: flag replica "replication/${partition.name}/${replica.name}" is syncing. The session was cleared and no replicas were removed.`, ExitCode.ERROR);
            }
            opened.push({ path, store, lease });
          }
        }
      }
      return opened;
    } catch (error) {
      await Promise.all(opened.map(async ({ store, lease }) => {
        await store.releaseLease(lease).catch(() => undefined);
        await store.close().catch(() => undefined);
      }));
      throw error;
    }
  });
}

/** Acquire every legacy and flag-owned lease before deleting either root. */
export async function removeProfileReplicasAndReplication(profile: string): Promise<string[]> {
  const acquired = await acquireLogoutLeases(profile);
  const heldLeases = new Map(acquired.map(({ path, lease }) => [path, lease]));
  try {
    const legacy = await removeProfileReplicas(profile, heldLeases);
    const replication = await removeProfileReplication(profile, heldLeases);
    return [...legacy, ...replication];
  } finally {
    await Promise.all(acquired.map(async ({ store, lease }) => {
      await store.releaseLease(lease).catch(() => undefined);
      await store.close().catch(() => undefined);
    }));
  }
}
