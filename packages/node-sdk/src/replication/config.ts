import { assertFolderPrefix, kvPrefixCovers } from "@tinycloud/replica";
import type { ReplicationOptions } from "@tinycloud/sdk-core";

/** Constructor-time validation; the space-dependent secrets check runs at sign-in and open. */
export function assertValidReplicationConfig(
  replication: (ReplicationOptions & { storage?: unknown }) | undefined,
): void {
  if (replication === undefined || replication.enabled !== true) return;
  if (replication.storage === undefined || replication.storage === null) {
    throw new TypeError("replication.enabled requires replication.storage");
  }
  if (!Array.isArray(replication.prefixes) || replication.prefixes.length === 0) {
    throw new TypeError("replication.prefixes must be a non-empty array");
  }
  for (const prefix of replication.prefixes) {
    try {
      assertFolderPrefix(prefix);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [index, prefix] of replication.prefixes.entries()) {
    for (const other of replication.prefixes.slice(index + 1)) {
      if (kvPrefixCovers(prefix, other) || kvPrefixCovers(other, prefix)) {
        throw new TypeError(
          `replication.prefixes must not overlap: ${JSON.stringify(prefix)} and ${JSON.stringify(other)}`,
        );
      }
    }
    if (prefix.split("/", 1)[0] === "vault" && replication.allowSecrets !== true) {
      throw new TypeError(
        `replication prefix ${JSON.stringify(prefix)} overlaps the vault namespace; pass allowSecrets to opt in`,
      );
    }
  }
}
