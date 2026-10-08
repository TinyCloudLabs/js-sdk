import { lstat, readdir, realpath } from "node:fs/promises";
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
export async function removeProfileReplicas(profile: string): Promise<string[]> {
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
        const lease = await store.acquireSyncLease(SYNC_LEASE_MS);
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
      await Promise.all(opened.map(async ({ store, lease }) => {
        if (lease !== null) await store.releaseLease(lease).catch(() => undefined);
        await store.close().catch(() => undefined);
      }));
    }
  });
}
