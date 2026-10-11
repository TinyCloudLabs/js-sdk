import { join } from "node:path";
import { profilePath, withProfileLock } from "@tinycloud/operations/state";
import { sqliteReplicaStorage, type KVReplicaStorage, type ReplicationOptions } from "@tinycloud/node-sdk";
import { createReplicationEventSink } from "./replication-log.js";

export interface CLIReplicationConfig extends ReplicationOptions {
  storage: KVReplicaStorage;
  mode: "foreground";
}

export interface ProfileReplicationSettings {
  prefixes: string[];
  allowSecrets?: boolean;
}

export function createCliReplicationConfig(
  profile: string,
  settings: ProfileReplicationSettings | undefined,
  output: { debug: boolean; quiet: boolean },
  enabled: boolean,
): CLIReplicationConfig | undefined {
  if (!enabled || !settings || settings.prefixes.length === 0) return undefined;
  const root = profilePath(profile);
  return {
    enabled: true,
    prefixes: settings.prefixes,
    allowSecrets: settings.allowSecrets === true,
    mode: "foreground",
    verify: process.env.TC_REPLICATION_VERIFY === "1",
    maxStalenessMs: Number(process.env.TC_REPLICATION_MAX_STALENESS_MS ?? 60_000),
    staleSyncTimeoutMs: Number(process.env.TC_REPLICATION_SYNC_TIMEOUT_MS ?? 10_000),
    storage: sqliteReplicaStorage({
      dir: join(root, "replication"),
      guard: (section) => withProfileLock(profile, section, { requireProfile: true, timeoutMs: 35_000 }),
    }),
    onEvent: createReplicationEventSink(root, output),
  };
}
