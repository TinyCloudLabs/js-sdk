import { NodeWasmBindings, type PermissionEntry } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { resolveProfilePosture, type ProfileConfig } from "../config/types.js";
import { parseDuration } from "../lib/duration.js";
import { normalizePkhIdentifier } from "../lib/space.js";

/** Tolerated clock difference between OpenKey and this machine. */
export const CLOCK_SKEW_MS = 30_000;

/** Session `permissionsSource` value for permissions taken from the verified signed recap. */
export const SIGNED_RECAP = "signed-recap";

/**
 * A requested `--expiry`, as a lifetime. OpenKey signs approval time plus a
 * lifetime, so an absolute deadline cannot be honored once approval takes
 * longer than the clock-skew allowance; only durations are accepted.
 */
export interface RequestedExpiry {
  readonly durationMs: number;
}

/** Parse an OpenKey login `--expiry`: `30m`/`7d`/`1w` or raw milliseconds. */
export function parseRequestedExpiry(value: string | number): RequestedExpiry {
  if (typeof value === "number") return { durationMs: value };
  if (/^\d+(m|h|d|w)$/.test(value)) return { durationMs: parseDuration(value) };
  throw new CLIError(
    "INVALID_EXPIRY",
    Number.isFinite(Date.parse(value))
      ? `--expiry "${value}" is a date. OpenKey signs approval time plus a lifetime, so use a duration such as 2h or 7d.`
      : `Invalid --expiry "${value}". Use a duration such as 1h or 7d, or milliseconds.`,
    ExitCode.USAGE_ERROR,
  );
}

/** Latest signed expiry the request allows, evaluated when the approval arrives. */
export function expiryLimit(expiry: RequestedExpiry): number {
  return Date.now() + expiry.durationMs + CLOCK_SKEW_MS;
}

/** OpenKey's minimum delegation lifetime; it raises anything shorter. */
const OPENKEY_MIN_LIFETIME_SECONDS = 60;

/**
 * `--expiry` as OpenKey's `/delegate?expiry=` accepts it (`<seconds>s`);
 * OpenKey raises lifetimes under a minute, so refuse those before consent.
 */
export function openKeyExpiryParam(expiry: RequestedExpiry): string {
  const seconds = Math.floor(expiry.durationMs / 1000);
  if (seconds < OPENKEY_MIN_LIFETIME_SECONDS) {
    throw new CLIError("INVALID_EXPIRY", "--expiry must be at least 1 minute: OpenKey does not sign shorter sessions.", ExitCode.USAGE_ERROR);
  }
  return `${seconds}s`;
}

/**
 * Whether a profile holds a local owner key. An explicit posture does not
 * hide `authMethod: "local"` or a stored private key, which `tc auth login
 * --method local` leaves on any profile it signs in.
 */
export function isLocalOwnerProfile(profile: ProfileConfig): boolean {
  return resolveProfilePosture(profile) === "local-owner-key" || profile.authMethod === "local" || typeof profile.privateKey === "string";
}

/**
 * The owner a re-login must keep. Every profile that recorded an owner is
 * pinned to it, whatever wrote it (`tc init`, `tc profile create`, a scoped
 * or device login); only a local-owner-key profile, whose owner is the local
 * key itself, is not pinned to an OpenKey identity.
 */
export function pinnedOwner(profile: ProfileConfig | null | undefined): string | undefined {
  return profile && !isLocalOwnerProfile(profile) ? profile.ownerDid : undefined;
}

/**
 * Session fields that state authority. They are set only from a verified
 * proof, never copied from an OpenKey callback.
 */
const TRUST_FIELDS = ["ownerDid", "permissions", "permissionsSource", "expiresAt", "expiry", "expirationTime"];

/** A callback-supplied session with every authority claim removed. */
export function withoutTrustFields(session: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(session).filter(([name]) => !TRUST_FIELDS.includes(name)));
}

/** A session whose authority fields come only from the verified proof. */
export function withVerifiedAuthority(session: Record<string, unknown>, signed: SignedSession): Record<string, unknown> & SignedSession {
  return {
    ...withoutTrustFields(session),
    ownerDid: signed.ownerDid,
    permissions: signed.permissions,
    permissionsSource: SIGNED_RECAP,
    expiresAt: signed.expiresAt,
    expiry: signed.expiresAt,
    expirationTime: signed.expiresAt,
  };
}

/** The owner a login must match: the profile's pinned owner, or `--owner`. They must agree when both exist. */
export function expectedOwnerFor(profileName: string, profile: ProfileConfig | null | undefined, requested: string | undefined): string | undefined {
  const pinned = pinnedOwner(profile);
  if (pinned && requested && normalizePkhIdentifier(pinned) !== normalizePkhIdentifier(requested)) {
    throw new CLIError("OPENKEY_OWNER_MISMATCH", `Profile "${profileName}" belongs to ${pinned}, not ${requested}. Use a new profile for another account.`, ExitCode.USAGE_ERROR);
  }
  return pinned ?? requested;
}

/** Expiry recorded in a saved session (explicit fields, else the SIWE message). */
export function sessionExpiresAt(session: Record<string, unknown> | null): string | null {
  if (session === null) return null;
  const candidates = [session.expiresAt, session.expiry, session.expirationTime,
    typeof session.siwe === "string" ? session.siwe.match(/^Expiration Time:\s*(.+)$/m)?.[1] : undefined];
  const value = candidates.find((candidate) => typeof candidate === "string" && Number.isFinite(Date.parse(candidate)));
  return typeof value === "string" ? new Date(value).toISOString() : null;
}

/** Bind a logical space name (e.g. `default`) to the owner's space URI. */
export function ownerSpaceId(space: string, ownerDid: string): string {
  return space.startsWith("tinycloud:") ? space : `tinycloud:${ownerDid.slice("did:".length)}:${space}`;
}

/** Canonical one-action tuples, so permission sets compare independently of grouping or casing. */
export function permissionTuples(permissions: readonly PermissionEntry[], ownerDid: string): Set<string> {
  return new Set(permissions.flatMap((permission) => {
    const service = permission.service.startsWith("tinycloud.") ? permission.service : `tinycloud.${permission.service}`;
    const space = normalizePkhIdentifier(ownerSpaceId(permission.space ?? "", ownerDid));
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
  ) || new Set(permissions.map((p) => normalizePkhIdentifier(p.space ?? ""))).size !== 1) {
    throw new CLIError("INVALID_LOGIN_SCOPE", "First login requires non-empty permissions in one TinyCloud space. Request additional spaces after login.", ExitCode.USAGE_ERROR);
  }
}

export interface SignedSessionExpectations {
  /** Primary DID the approving identity must match, when known. */
  expectedOwner?: string;
  /** Requested `--expiry`; a signed expiry beyond it (+ skew) is refused. */
  expiry?: RequestedExpiry;
}

export interface SignedSession {
  ownerDid: string;
  /** The verified ReCap, with fully qualified services and actions. */
  permissions: PermissionEntry[];
  expiresAt: string;
}

/**
 * Verify an OpenKey session proof: SIWE signature, session key, owner and
 * lifetime. Unsigned callback fields never stand in for these values.
 */
export function verifySignedSession(
  data: Record<string, unknown>,
  key: object,
  sessionDid: string,
  expected: SignedSessionExpectations = {},
): SignedSession {
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
      throw new CLIError("AUTH_EXPIRED", "The approved session has expired. No session was saved.", ExitCode.AUTH_REQUIRED);
    }
    throw new CLIError("OPENKEY_PROOF_INVALID", "OpenKey did not return a complete, verifiable session proof. No session was saved.", ExitCode.AUTH_REQUIRED);
  }
  const signedExpiry = Date.parse(expiresAt);
  if (signedExpiry <= Date.now()) {
    throw new CLIError("AUTH_EXPIRED", "The approved session has expired. No session was saved.", ExitCode.AUTH_REQUIRED);
  }
  if (expected.expiry !== undefined && signedExpiry > expiryLimit(expected.expiry)) {
    throw new CLIError("OPENKEY_EXPIRY_EXCEEDED", "The signed session outlives the requested --expiry. No session was saved.", ExitCode.PERMISSION_DENIED);
  }
  const ownerDid = `did:pkh:eip155:${data.chainId}:${data.address}`;
  if (expected.expectedOwner && normalizePkhIdentifier(expected.expectedOwner) !== normalizePkhIdentifier(ownerDid)) {
    throw new CLIError("OPENKEY_OWNER_MISMATCH", "The approved signing identity differs from this profile's owner. No session was saved. Use a new profile for another account.", ExitCode.PERMISSION_DENIED);
  }
  const permissions = recap.map((entry) => {
    const service = entry.service.startsWith("tinycloud.") ? entry.service : `tinycloud.${entry.service}`;
    const actions = entry.actions.map((action) => action.includes("/") ? action : `${service}/${action}`);
    return { service, space: entry.space, path: entry.path, actions };
  });
  return { ownerDid, permissions, expiresAt };
}

/** Verify signed authority, and that it stays inside the requested manifest, before a scoped login saves anything. */
export function verifyScopedLogin(
  data: Record<string, unknown>,
  key: object,
  sessionDid: string,
  requested: PermissionEntry[],
  expected: SignedSessionExpectations = {},
): Record<string, unknown> & SignedSession {
  const signed = verifySignedSession(data, key, sessionDid, expected);
  const spaceId = data.spaceId as string;
  for (const permission of requested) {
    if (normalizePkhIdentifier(ownerSpaceId(permission.space ?? "", signed.ownerDid)) !== normalizePkhIdentifier(spaceId)) {
      throw new CLIError("OPENKEY_SCOPE_MISMATCH", "The approved space differs from the requested space. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
    }
  }
  const allowed = permissionTuples(requested, signed.ownerDid);
  for (const tuple of permissionTuples(signed.permissions, signed.ownerDid)) {
    if (!allowed.has(tuple)) {
      throw new CLIError("OPENKEY_GRANT_BROADENED", "The signed grant contains authority beyond the requested manifest. No scoped session was saved.", ExitCode.PERMISSION_DENIED);
    }
  }
  // Keep signed proof intact; unsigned callback identity/expiry/permissions
  // cannot override the verified values. Never accept a returned private key.
  // `permissionsSource` marks `permissions` as the signed recap, so a later
  // login may rely on it to tell whether replacing this session drops authority.
  return withVerifiedAuthority({ ...data, jwk: key }, signed);
}
