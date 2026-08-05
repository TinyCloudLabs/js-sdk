import {
  parseCanonicalTinyCloudIdentityClaims,
  type CanonicalTinyCloudIdentity,
} from "@tinycloud/sdk-core";

/** The Notes client accepts its identity only from verified OAuth claims. */
export function resolveNotesClientIdentity(
  oidcClaims: unknown,
): CanonicalTinyCloudIdentity {
  return parseCanonicalTinyCloudIdentityClaims(oidcClaims);
}
