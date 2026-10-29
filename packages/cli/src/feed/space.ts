import { resolveSpaceUri } from "../lib/space.js";

/** primarySpaceId comes from the authenticated node, never from feed labels or registry metadata. */
export async function resolveFeedSpace(primarySpaceId: string | undefined, requested: string, profileName: string) {
  if (/^[A-Za-z0-9_-]+$/.test(requested) && primarySpaceId?.startsWith("tinycloud:") &&
    primarySpaceId.endsWith(`:${requested}`)) return primarySpaceId;
  return resolveSpaceUri(requested, profileName);
}
