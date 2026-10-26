import {
  KV,
  isCapabilitySubset,
  type PermissionEntry,
  type ReplicationOptions,
} from "@tinycloud/sdk-core";
import { requiresSecretsOptIn } from "@tinycloud/sdk-services";
import { assertFolderPrefix } from "@tinycloud/sdk-services/kv/replication/prefix";

const KV_GET = KV.GET;
const KV_SYNC = KV.SYNC;
const KV_SERVICE = "tinycloud.kv";

export function hasUnrestrictedGetCoverage(
  entries: readonly PermissionEntry[],
  spaceId: string,
  prefix: string,
): boolean {
  return isCapabilitySubset(
    [{ service: KV_SERVICE, space: spaceId, path: prefix, actions: [KV_GET] }],
    [...entries],
  ).subset;
}

export function augmentSignInEntriesWithReplication(input: {
  entries: readonly PermissionEntry[];
  primarySpaceId: string;
  replication?: Pick<ReplicationOptions, "prefixes" | "allowSecrets" | "syncScope">;
}): PermissionEntry[] {
  const out: PermissionEntry[] = [];
  const replication = input.replication;
  if (replication === undefined) return out;
  const eligiblePaths: string[] = [];
  for (const prefix of replication.prefixes) {
    assertFolderPrefix(prefix);
    const path = prefix === "/" ? "" : prefix;
    if (
      requiresSecretsOptIn(input.primarySpaceId, prefix) &&
      replication.allowSecrets !== true
    ) {
      continue;
    }
    if (!hasUnrestrictedGetCoverage(input.entries, input.primarySpaceId, path)) {
      continue;
    }
    eligiblePaths.push(path);
  }
  if (
    replication.syncScope !== "prefixes" &&
    eligiblePaths.length === replication.prefixes.length &&
    eligiblePaths.length > 0 &&
    hasUnrestrictedGetCoverage(input.entries, input.primarySpaceId, "")
  ) {
    return [{
      service: KV_SERVICE,
      space: input.primarySpaceId,
      path: "",
      actions: [KV_GET, KV_SYNC],
    }];
  }
  for (const path of eligiblePaths) {
    out.push({
      service: KV_SERVICE,
      space: input.primarySpaceId,
      path,
      actions: [KV_GET, KV_SYNC],
    });
  }
  return out;
}
