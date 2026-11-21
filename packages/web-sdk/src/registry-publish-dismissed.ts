// TC-3547: persist the owner's "Not now" decision for the publish consent so
// the Home / tinycloud.one "finish setup" banner stays dismissed. Lives in the
// owner's account-registry KV so both first-party surfaces read the same bit.
//
// This module is dynamic-import()'d from the registry-publish module, which is
// itself dynamic-import()'d from tcw.ts. Nothing here lands in the root web-sdk
// chunk.

import type { TinyCloudNode } from "@tinycloud/node-sdk";

const DISMISSED_KEY = "system/registry-publish/dismissed/v1";

interface DismissedFlag {
  dismissed: boolean;
  at: string; // ISO-8601, for diagnosing when the "Not now" was recorded
}

function kvForAccountRegistry(node: TinyCloudNode) {
  // The account-registry space is the owner's own bootstrap KV. `accountSpaceId` is set
  // after a first-party bootstrap sign-in (includeAccountRegistryPermissions=true), and
  // the host that calls this module has already gone through that.
  const accountSpaceId = node.accountSpaceId;
  if (!accountSpaceId) return undefined;
  return node.kvForSpace(accountSpaceId);
}

export async function readRegistryPublishDismissed(node: TinyCloudNode): Promise<boolean> {
  const kv = kvForAccountRegistry(node);
  if (!kv) return false;
  try {
    const result = await kv.get<DismissedFlag>(DISMISSED_KEY);
    // KV.get returns Result<KVResponse<T>>: {ok: true, data: {data: T|undefined, headers}} | {ok: false, error}.
    if (!result.ok) return false;
    return result.data.data?.dismissed === true;
  } catch {
    // The account-registry KV being unreachable means we cannot prove a prior dismissal;
    // the safer default is to NOT short-circuit (so consent still asks once). The host can
    // still render its banner.
    return false;
  }
}

export async function writeRegistryPublishDismissed(node: TinyCloudNode): Promise<void> {
  const kv = kvForAccountRegistry(node);
  if (!kv) return;
  await kv.put(DISMISSED_KEY, { dismissed: true, at: new Date().toISOString() } satisfies DismissedFlag);
}

export const DISMISSED_FLAG_KEY_FOR_TEST = DISMISSED_KEY;
