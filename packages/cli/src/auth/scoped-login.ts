import { NodeWasmBindings, type PermissionEntry } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

/** Lowercase only the EIP-155 address segment; space names stay case-sensitive. */
export function normalizeSpace(space: string): string {
  return space.replace(/(eip155:\d+:)(0x[0-9a-fA-F]{40})/, (_, prefix, address) => prefix + address.toLowerCase());
}

/** Bind a logical space name (e.g. `default`) to the owner's space URI. */
export function ownerSpaceId(space: string, ownerDid: string): string {
  return space.startsWith("tinycloud:") ? space : `tinycloud:${ownerDid.slice("did:".length)}:${space}`;
}

/** Canonical one-action tuples, so permission sets compare independently of grouping or casing. */
export function permissionTuples(permissions: readonly PermissionEntry[], ownerDid: string): Set<string> {
  return new Set(permissions.flatMap((permission) => {
    const service = permission.service.startsWith("tinycloud.") ? permission.service : `tinycloud.${permission.service}`;
    const space = normalizeSpace(ownerSpaceId(permission.space ?? "", ownerDid));
    return permission.actions.map((action) =>
      JSON.stringify([service, space, permission.path, action.includes("/") ? action : `${service}/${action}`]));
  }));
}

/** Regroup tuples into permission entries (one entry per service/space/path). */
export function permissionsFromTuples(tuples: Iterable<string>): PermissionEntry[] {
  const grouped = new Map<string, PermissionEntry>();
  for (const tuple of tuples) {
    const [service, space, path, action] = JSON.parse(tuple) as [string, string, string, string];
    const key = JSON.stringify([service, space, path]);
    const entry = grouped.get(key) ?? { service, space, path, actions: [] };
    entry.actions.push(action);
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

export function validateLoginPermissions(permissions: PermissionEntry[]): void {
  if (!permissions.length || permissions.some((p) =>
    !p.service?.startsWith("tinycloud.") || !p.space ||
    (!p.space.startsWith("tinycloud:") && !/^[A-Za-z0-9_-]+$/.test(p.space)) ||
    typeof p.path !== "string" || !p.actions?.length ||
    p.actions.some((action) => !action.startsWith(`${p.service}/`)),
  ) || new Set(permissions.map((p) => normalizeSpace(p.space ?? ""))).size !== 1) {
    throw new CLIError("INVALID_LOGIN_SCOPE", "First login requires non-empty permissions in one TinyCloud space. Request additional spaces after login.", ExitCode.USAGE_ERROR);
  }
}

/** Verify signed authority before a scoped login can replace local state. */
export async function verifyScopedLogin(
  data: Record<string, unknown>,
  key: object,
  sessionDid: string,
  requested: PermissionEntry[],
  expectedOwner?: string,
): Promise<Record<string, unknown> & { ownerDid: string; permissions: PermissionEntry[]; expiresAt: string }> {
  let recap: PermissionEntry[];
  let expiresAt: string;
  try {
    if (typeof data.siwe !== "string" || typeof data.signature !== "string" ||
      typeof data.address !== "string" || !Number.isSafeInteger(data.chainId) ||
      typeof data.spaceId !== "string" || typeof data.delegationCid !== "string" ||
      !data.delegationHeader || typeof data.delegationHeader !== "object" ||
      typeof data.verificationMethod !== "string" ||
      data.verificationMethod.split("#")[0] !== sessionDid.split("#")[0]) throw new Error();
    const proof = new NodeWasmBindings().validatePersistedSession({
      delegationHeader: data.delegationHeader as { Authorization: string },
      delegationCid: data.delegationCid, spaceId: data.spaceId,
      jwk: key, address: data.address, chainId: data.chainId as number,
      siwe: data.siwe, signature: data.signature,
    });
    if (!proof.verifiedRecap?.length || !proof.expiresAt || !Number.isFinite(Date.parse(proof.expiresAt))) throw new Error();
    recap = proof.verifiedRecap;
    expiresAt = proof.expiresAt;
  } catch (error) {
    if (/expir/i.test(error instanceof Error ? error.message : String(error))) {
      throw new CLIError("AUTH_EXPIRED", "The approved session has expired. No scoped session was saved.", ExitCode.AUTH_REQUIRED);
    }
    throw new CLIError("OPENKEY_PROOF_INVALID", "OpenKey did not return a complete, verifiable session proof. No scoped session was saved.", ExitCode.AUTH_REQUIRED);
  }
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new CLIError("AUTH_EXPIRED", "The approved session has expired. No scoped session was saved.", ExitCode.AUTH_REQUIRED);
  }
  const ownerDid = `did:pkh:eip155:${data.chainId}:${data.address}`;
  if (expectedOwner && normalizeSpace(expectedOwner) !== normalizeSpace(ownerDid)) {
    throw new CLIError("OPENKEY_OWNER_MISMATCH", "The approved signing identity differs from the expected owner. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
  }
  const spaceId = data.spaceId as string;
  for (const permission of requested) {
    if (normalizeSpace(ownerSpaceId(permission.space ?? "", ownerDid)) !== normalizeSpace(spaceId)) {
      throw new CLIError("OPENKEY_SCOPE_MISMATCH", "The approved space differs from the requested space. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
    }
  }
  const allowed = permissionTuples(requested, ownerDid);
  const permissions = recap.map((entry) => {
    const service = entry.service.startsWith("tinycloud.") ? entry.service : `tinycloud.${entry.service}`;
    const actions = entry.actions.map((action) => action.includes("/") ? action : `${service}/${action}`);
    return { service, space: entry.space, path: entry.path, actions };
  });
  for (const tuple of permissionTuples(permissions, ownerDid)) {
    if (!allowed.has(tuple)) {
      throw new CLIError("OPENKEY_GRANT_BROADENED", "The signed grant contains authority beyond the requested manifest. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
    }
  }
  // Keep signed proof intact; unsigned callback identity/expiry/permissions
  // cannot override the verified values. Never accept a returned private key.
  return { ...data, jwk: key, ownerDid, permissions, expiresAt, expiry: expiresAt, expirationTime: expiresAt };
}
