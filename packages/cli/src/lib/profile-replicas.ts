import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { ProfileDeletedError, profilePath, withProfileLock } from "@tinycloud/operations/state";
import { ReplicaError, ReplicaErrorCode, type LeaseToken } from "@tinycloud/replica";
import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";

import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

const SYNC_LEASE_MS = 60_000;

/** Remove each replica through its fenced store API; refuse before deletion if any sync owns a lease. */
export async function removeProfileReplicas(profile: string): Promise<string[]> {
  return withProfileLock(profile, async () => {
    const root = join(profilePath(profile), "replicas");
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw error;
    }

    const replicas = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    if (replicas.length === 0) return [];
    await loadSqlite();

    const opened: Array<{ name: string; store: SqliteReplicaStore; lease: LeaseToken | null }> = [];
    try {
      for (const entry of replicas) {
        const store = await SqliteReplicaStore.open(join(root, entry.name), {
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
