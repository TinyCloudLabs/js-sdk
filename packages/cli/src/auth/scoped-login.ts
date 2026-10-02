import { readFile, stat } from "node:fs/promises";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

function normalizeSpace(space: string): string {
  return space.replace(/(eip155:\d+:)(0x[0-9a-fA-F]{40})/, (_, prefix, address) => prefix + address.toLowerCase());
}

// The scoped OpenKey adapter currently requests exact uncaveated abilities.
// Published WASM may expose a signed caveat branch as Map; never flatten it.
function isUnconstrained(caveats: unknown): boolean {
  if (caveats === undefined) return true;
  if (!Array.isArray(caveats)) return false;
  if (caveats.length === 0) return true;
  if (caveats.length !== 1) return false;
  const branch = caveats[0];
  return branch instanceof Map ? branch.size === 0
    : branch !== null && typeof branch === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(branch)) && Object.keys(branch).length === 0;
}

export function validateLoginPermissions(permissions: PermissionEntry[], allowMultipleSpaces = false): void {
  if (!Array.isArray(permissions) || !permissions.length || permissions.some((p) =>
    !p || typeof p !== "object" || typeof p.service !== "string" || !p.service.startsWith("tinycloud.") ||
    typeof p.space !== "string" || !p.space ||
    (!p.space.startsWith("tinycloud:") && !/^[A-Za-z0-9_-]+$/.test(p.space)) ||
    typeof p.path !== "string" || !Array.isArray(p.actions) || !p.actions.length ||
    !isUnconstrained(p.caveats) ||
    p.actions.some((action) => typeof action !== "string" || !action.startsWith(`${p.service}/`)),
  ) || (!allowMultipleSpaces && new Set(permissions.map((p) => normalizeSpace(p.space!))).size !== 1)) {
    throw new CLIError("INVALID_LOGIN_SCOPE", "Scoped login requires explicit non-empty TinyCloud permissions without constrained caveats." + (allowMultipleSpaces ? "" : " This route requires one space."), ExitCode.USAGE_ERROR);
  }
}

export async function loadLoginPermissionsFile(path: string): Promise<PermissionEntry[]> {
  if ((await stat(path)).size > 1024 * 1024) throw new CLIError("INVALID_LOGIN_SCOPE", "The permissions file exceeds the supported size.", ExitCode.USAGE_ERROR);
  let permissions: PermissionEntry[];
  try { permissions = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new CLIError("INVALID_LOGIN_SCOPE", "The permissions file must contain a JSON permission array.", ExitCode.USAGE_ERROR); }
  validateLoginPermissions(permissions, true);
  return permissions;
}

/** Verify signed authority before a scoped login can replace local state. */
export async function verifyScopedLogin(
  data: Record<string, unknown>,
  key: object,
  sessionDid: string,
  requested: PermissionEntry[],
  expectedOwner?: string,
  requireComplete = false,
): Promise<Record<string, unknown>> {
  validateLoginPermissions(requested, true);
  let proof: { verifiedRecap?: Array<{ service: string; space: string; path: string; actions: string[]; caveats?: unknown }>; expiresAt?: string };
  try {
    if (typeof data.siwe !== "string" || typeof data.signature !== "string" ||
      typeof data.address !== "string" || !Number.isSafeInteger(data.chainId) ||
      typeof data.spaceId !== "string" || typeof data.delegationCid !== "string" ||
      !data.delegationHeader || typeof data.delegationHeader !== "object" ||
      typeof data.verificationMethod !== "string" ||
      data.verificationMethod.split("#")[0] !== sessionDid.split("#")[0]) throw new Error();
    const { NodeWasmBindings } = await import("@tinycloud/node-sdk");
    proof = new NodeWasmBindings().validatePersistedSession({
      delegationHeader: data.delegationHeader as { Authorization: string },
      delegationCid: data.delegationCid, spaceId: data.spaceId,
      jwk: key, address: data.address, chainId: data.chainId as number,
      siwe: data.siwe, signature: data.signature,
    });
    if (!proof.verifiedRecap?.length || !proof.expiresAt || !Number.isFinite(Date.parse(proof.expiresAt))) throw new Error();
  } catch (error) {
    if (/expir/i.test(error instanceof Error ? error.message : String(error))) {
      throw new CLIError("AUTH_EXPIRED", "The approved session has expired. No scoped session was saved.", ExitCode.AUTH_REQUIRED);
    }
    throw new CLIError("OPENKEY_PROOF_INVALID", "OpenKey did not return a complete, verifiable session proof. No scoped session was saved.", ExitCode.AUTH_REQUIRED);
  }
  if (Date.parse(proof.expiresAt!) <= Date.now()) {
    throw new CLIError("AUTH_EXPIRED", "The approved session has expired. No scoped session was saved.", ExitCode.AUTH_REQUIRED);
  }
  const ownerDid = `did:pkh:eip155:${data.chainId}:${data.address}`;
  if (expectedOwner && normalizeSpace(expectedOwner) !== normalizeSpace(ownerDid)) {
    throw new CLIError("OPENKEY_OWNER_MISMATCH", "The approved signing identity differs from the expected owner. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
  }
  const spaceId = data.spaceId as string;
  const ownerSpacePrefix = normalizeSpace(`tinycloud:${ownerDid.slice(4)}:`);
  const requestedSpaces = new Set<string>();
  const allowed = new Set(requested.flatMap((permission) => {
    const expectedSpace = permission.space!.startsWith("tinycloud:")
      ? permission.space!
      : `tinycloud:${ownerDid.slice(4)}:${permission.space}`;
    if (!normalizeSpace(expectedSpace).startsWith(ownerSpacePrefix)) {
      throw new CLIError("OPENKEY_SCOPE_MISMATCH", "The requested space belongs to a different owner. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
    }
    requestedSpaces.add(normalizeSpace(expectedSpace));
    return permission.actions.map((action) => JSON.stringify([permission.service, normalizeSpace(expectedSpace), permission.path, action]));
  }));
  if (!requestedSpaces.has(normalizeSpace(spaceId))) {
    throw new CLIError("OPENKEY_SCOPE_MISMATCH", "The approved primary space differs from the requested spaces. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
  }
  const permissions = proof.verifiedRecap!.map((entry) => {
    if (!isUnconstrained(entry.caveats)) {
      throw new CLIError("OPENKEY_SCOPE_MISMATCH", "This scoped login adapter cannot preserve constrained ReCap caveats. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
    }
    const service = entry.service.startsWith("tinycloud.") ? entry.service : `tinycloud.${entry.service}`;
    const actions = entry.actions.map((action) => action.includes("/") ? action : `${service}/${action}`);
    for (const action of actions) {
      if (!allowed.has(JSON.stringify([service, normalizeSpace(entry.space), entry.path, action]))) {
        throw new CLIError("OPENKEY_GRANT_BROADENED", "The signed grant contains authority beyond the login manifest. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
      }
    }
    return { service, space: entry.space, path: entry.path, actions };
  });
  if (requireComplete) {
    const effective = new Set(permissions.flatMap(p => p.actions.map(action => JSON.stringify([p.service, normalizeSpace(p.space!), p.path, action]))));
    if ([...allowed].some(permission => !effective.has(permission))) {
      throw new CLIError("OPENKEY_SCOPE_INCOMPLETE", "The approved grant does not cover the pending operation. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
    }
  }
  // Keep signed proof intact; unsigned callback identity/expiry/permissions
  // cannot override the verified values. Never accept a returned private key.
  return { ...data, jwk: key, ownerDid, permissions, expiresAt: proof.expiresAt, expiry: proof.expiresAt, expirationTime: proof.expiresAt };
}
