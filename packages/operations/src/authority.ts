import {
  isCapabilitySubset,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

/**
 * A capability in the canonical form persisted in a v1 request artifact.
 *
 * The SDK remains the semantic authority for containment. This module only
 * establishes deterministic exact identity for persistence and display.
 */
export type CanonicalPermissionEntry = Readonly<PermissionEntry>;

export interface AuthorityEvaluation {
  readonly satisfied: boolean;
  readonly missing: readonly CanonicalPermissionEntry[];
}

/**
 * Evaluates required authority with the SDK's public subset primitive.
 *
 * In particular, this intentionally does not implement matching rules or
 * manufacture wildcards. A wildcard can cover a requirement only when it was
 * already present in the supplied granted authority and the SDK says so.
 */
export function evaluateAuthority(
  granted: readonly PermissionEntry[],
  required: readonly PermissionEntry[],
): AuthorityEvaluation {
  const canonicalGranted = canonicalizeCapabilities(granted);
  const canonicalRequired = canonicalizeCapabilities(required);
  const result = isCapabilitySubset(canonicalRequired, canonicalGranted);

  return {
    satisfied: result.subset,
    missing: canonicalizeCapabilities(result.missing),
  };
}

/** Returns a stable exact identity for one capability without containment. */
export function permissionIdentity(permission: PermissionEntry): string {
  return JSON.stringify(canonicalizeCapability(permission));
}

/**
 * Sorts actions and entries and removes only exactly-identical capabilities.
 * It does not coalesce paths, services, spaces, or actions into a broader
 * capability.
 */
export function canonicalizeCapabilities(
  permissions: readonly PermissionEntry[],
): CanonicalPermissionEntry[] {
  const byIdentity = new Map<string, CanonicalPermissionEntry>();
  for (const permission of permissions) {
    const canonical = canonicalizeCapability(permission);
    byIdentity.set(permissionIdentityFromCanonical(canonical), canonical);
  }

  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, permission]) => permission);
}

function canonicalizeCapability(permission: PermissionEntry): CanonicalPermissionEntry {
  const actions = [...new Set(permission.actions)].sort((left, right) => left.localeCompare(right));
  return {
    service: permission.service,
    ...(permission.space !== undefined ? { space: permission.space } : {}),
    path: permission.path,
    actions,
    ...(permission.skipPrefix !== undefined ? { skipPrefix: permission.skipPrefix } : {}),
    ...(permission.expiry !== undefined ? { expiry: permission.expiry } : {}),
    ...(permission.description !== undefined ? { description: permission.description } : {}),
  };
}

function permissionIdentityFromCanonical(permission: CanonicalPermissionEntry): string {
  return JSON.stringify({
    service: permission.service,
    ...(permission.space !== undefined ? { space: permission.space } : {}),
    path: permission.path,
    actions: permission.actions,
    ...(permission.skipPrefix !== undefined ? { skipPrefix: permission.skipPrefix } : {}),
    ...(permission.expiry !== undefined ? { expiry: permission.expiry } : {}),
    ...(permission.description !== undefined ? { description: permission.description } : {}),
  });
}
