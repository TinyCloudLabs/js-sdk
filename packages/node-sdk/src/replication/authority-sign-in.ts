import {
  KV,
  isCapabilitySubset,
  type PermissionEntry,
  type ReplicationOptions,
} from "@tinycloud/sdk-core";
import { requiresSecretsOptIn } from "@tinycloud/sdk-services";

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
  replication?: Pick<ReplicationOptions, "prefixes" | "allowSecrets">;
}): PermissionEntry[] {
  const out: PermissionEntry[] = [];
  const replication = input.replication;
  if (replication === undefined) return out;
  for (const prefix of replication.prefixes) {
    if (
      requiresSecretsOptIn(input.primarySpaceId, prefix) &&
      replication.allowSecrets !== true
    ) {
      continue;
    }
    if (!hasUnrestrictedGetCoverage(input.entries, input.primarySpaceId, prefix)) {
      continue;
    }
    out.push({
      service: KV_SERVICE,
      space: input.primarySpaceId,
      path: prefix,
      actions: [KV_GET, KV_SYNC],
    });
  }
  return out;
}
