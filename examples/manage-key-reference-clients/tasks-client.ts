import {
  parseCanonicalTinyCloudIdentity,
  type CanonicalTinyCloudIdentity,
} from "@tinycloud/sdk-core";

/** The Tasks client accepts the canonical claim supplied by its OAuth adapter. */
export function resolveTasksClientIdentity(
  canonicalIdentityClaim: unknown,
): CanonicalTinyCloudIdentity {
  return parseCanonicalTinyCloudIdentity(canonicalIdentityClaim);
}
