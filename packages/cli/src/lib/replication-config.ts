import { join } from "node:path";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { profilePath, withProfileLock } from "@tinycloud/operations/state";
import { REPLICA_LOGOUT_PENDING_FILE, sqliteReplicaStorage, type KVReplicaStorage, type ReplicationOptions } from "@tinycloud/node-sdk";
import { createReplicationEventSink, REPLICATION_DIAGNOSTIC_FILES } from "./replication-log.js";
import { assertFolderPrefix } from "@tinycloud/replica";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

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
  for (const prefix of settings.prefixes) {
    try {
      assertFolderPrefix(prefix);
    } catch (error) {
      const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
      const replacement = trimmed.length > 0 && !trimmed.includes("//") ? `${trimmed}/` : "/";
      throw new CLIError(
        "INVALID_REPLICATION_PREFIX",
        error instanceof Error ? error.message : String(error),
        ExitCode.USAGE_ERROR,
        { hint: `Replace the saved replication prefix with \`${CLI_NAME} auth login --replication-prefix ${replacement}\`; purging a replica alone does not change this profile setting.` },
      );
    }
  }
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
      logoutPendingFile: join(root, REPLICA_LOGOUT_PENDING_FILE),
      diagnosticFiles: REPLICATION_DIAGNOSTIC_FILES,
      guard: (section) => withProfileLock(profile, section, { requireProfile: true, timeoutMs: 35_000 }),
    }),
    onEvent: createReplicationEventSink(root, output),
  };
}
