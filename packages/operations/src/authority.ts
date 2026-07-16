import {
  canonicalizeRecapCaveats,
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
 * Operation-owned space resolution. The SDK's general capability evaluator
 * intentionally preserves its historical short/full-space compatibility; the
 * operation kernel supplies this narrower resolver when a space identifies a
 * remote owner's resource.
 */
export type OperationSpaceResolver = (space: string) => string;

const EXACT_PERMISSION_KEYS = new Set([
  "service",
  "space",
  "path",
  "actions",
  "skipPrefix",
  "expiry",
  "description",
]);

/**
 * Validate requirements that can be represented without semantic broadening in
 * a v1 artifact. Caveated authority is intentionally rejected: the v1 request
 * schema and grant path cannot preserve those signed branches end-to-end.
 */
export function validateExactCapabilities(value: unknown): PermissionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const permissions: PermissionEntry[] = [];
  for (const candidate of value) {
    if (!isExactPermission(candidate)) return undefined;
    permissions.push(candidate);
  }
  return canonicalizeCapabilities(permissions);
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

/**
 * Evaluate operation capabilities without allowing two owners' same-named
 * spaces to compare equal. Path and action containment still come from the
 * SDK primitive; only the operation space identity is made owner-exact.
 */
export function evaluateOperationAuthority(
  granted: readonly PermissionEntry[],
  required: readonly PermissionEntry[],
  resolveSpace?: OperationSpaceResolver,
): AuthorityEvaluation {
  const canonicalGranted = canonicalizeOperationCapabilities(granted, resolveSpace);
  const canonicalRequired = canonicalizeOperationCapabilities(required, resolveSpace);
  const missing: CanonicalPermissionEntry[] = [];

  for (const requested of canonicalRequired) {
    const covered = canonicalGranted.some((candidate) =>
      candidate.service === requested.service &&
      operationSpacesEqual(candidate.space, requested.space) &&
      isCapabilitySubset([requested], [candidate]).subset,
    );
    if (!covered) missing.push(requested);
  }

  return {
    satisfied: missing.length === 0,
    missing: canonicalizeCapabilities(missing),
  };
}

/**
 * Validate a runtime hint as an exact member of the registered plan. Runtime
 * nodes may report the one phase that failed, but they may not introduce a
 * broader, differently-owned, caveated, or otherwise new capability.
 */
export function isExactCapabilityMemberSubset(
  hinted: readonly PermissionEntry[],
  planned: readonly PermissionEntry[],
  resolveSpace?: OperationSpaceResolver,
): boolean {
  const canonicalHinted = canonicalizeOperationCapabilities(hinted, resolveSpace);
  const canonicalPlanned = canonicalizeOperationCapabilities(planned, resolveSpace);
  return canonicalHinted.length > 0 && canonicalHinted.every((hint) => canonicalPlanned.some((plan) =>
    JSON.stringify(hint) === JSON.stringify(plan),
  ));
}

/** Canonical identity used by operation preflight, hints, and artifacts. */
export function canonicalizeOperationCapabilities(
  permissions: readonly PermissionEntry[],
  resolveSpace?: OperationSpaceResolver,
): CanonicalPermissionEntry[] {
  return canonicalizeCapabilities(permissions.map((permission) => {
    const canonicalPath = canonicalizeOperationPath(permission);
    if (permission.space === undefined || resolveSpace === undefined) {
      return canonicalPath;
    }
    try {
      return { ...canonicalPath, space: resolveSpace(permission.space) };
    } catch {
      // An unresolvable identity remains a non-matching literal. It must never
      // be widened to a wildcard or to another authenticated owner.
      return canonicalPath;
    }
  }));
}

function canonicalizeOperationPath(permission: PermissionEntry): PermissionEntry {
  if (permission.service !== "tinycloud.encryption") return permission;
  const match = permission.path.match(
    /^(urn:tinycloud:encryption:did:pkh:eip155:\d+:)(0x[0-9a-fA-F]{40})(:.*)$/,
  );
  if (!match) return permission;
  return { ...permission, path: `${match[1]}${match[2]!.toLowerCase()}${match[3]}` };
}

function operationSpacesEqual(
  granted: string | undefined,
  requested: string | undefined,
): boolean {
  return granted === requested;
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
    ...(permission.caveats === undefined
      ? {}
      : { caveats: canonicalizeCaveats(permission.caveats) }),
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
    ...(permission.caveats === undefined ? {} : { caveats: permission.caveats }),
  });
}

function isExactPermission(value: unknown): value is PermissionEntry {
  if (
    !isExactRecord(value) ||
    Object.getOwnPropertyNames(value).some((key) => !EXACT_PERMISSION_KEYS.has(key)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return false;
  }
  if (
    !isExactText(value.service) ||
    !isExactPath(value.path, value.actions) ||
    (value.space !== undefined && !isExactText(value.space)) ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    !value.actions.every(isExactText) ||
    new Set(value.actions).size !== value.actions.length ||
    value.skipPrefix === true ||
    (value.skipPrefix !== undefined && value.skipPrefix !== false) ||
    (value.expiry !== undefined && !isExactText(value.expiry)) ||
    (value.description !== undefined && !isExactText(value.description))
  ) {
    return false;
  }
  return !("caveats" in value);
}

function isExactRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("*");
}

function isExactPath(value: unknown, actions: unknown): value is string {
  if (typeof value !== "string" || value === "/" || value.includes("*")) return false;
  if (value === "" || value.endsWith("/")) {
    return Array.isArray(actions) && actions.includes("tinycloud.kv/list");
  }
  return true;
}

function canonicalizeCaveats(
  caveats: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return [...caveats]
    .map((caveat) => ({
      identity: canonicalizeRecapCaveats([caveat]),
      value: JSON.parse(JSON.stringify(caveat)) as Record<string, unknown>,
    }))
    .sort((left, right) => left.identity.localeCompare(right.identity))
    .map(({ value }) => value);
}
