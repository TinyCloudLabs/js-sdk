import { NodeWasmBindings, type PermissionEntry } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { resolveProfilePosture, type ProfileConfig } from "../config/types.js";
import { parseDuration } from "../lib/duration.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import { ENCRYPTION_MANIFEST_SPACE } from "../../../sdk-core/src/manifest.js";
import { isRawEncryptionPermission, isVerifiedRawEncryptionPermission } from "../lib/raw-encryption.js";
import { canonicalNetworkUrn, rawEncryptionOwnerMatches } from "../lib/owner-did.js";

/** OpenKey signs a scoped delegation only when it carries this read on the session space. */
const CAPABILITIES_READ = "tinycloud.capabilities/read";

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

/** Canonical one-action tuples, so permission sets compare independently of grouping or casing. Caveats are not part of a tuple. */
export function permissionTuples(permissions: readonly PermissionEntry[], ownerDid: string): Set<string> {
  return new Set(permissions.flatMap((permission) => actionTuples(permission, ownerDid)));
}

export function isRawCidRevocationPermission(permission: PermissionEntry): boolean {
  return permission.service === "tinycloud.delegation" &&
    permission.space?.startsWith("urn:cid:") === true &&
    permission.path === "" &&
    permission.actions.includes("tinycloud.delegation/revoke");
}
function actionTuples(permission: PermissionEntry, ownerDid: string): string[] {
  const service = permission.service.startsWith("tinycloud.") ? permission.service : `tinycloud.${permission.service}`;
  // Only a top-level network entry is a raw grant. A legacy OpenKey signed
  // decrypt nested under the owner space must remain a distinct resource.
  const rawEncryption = isVerifiedRawEncryptionPermission(permission);
  const rawCidRevocation = isRawCidRevocationPermission(permission);
  const space = rawEncryption
    ? ENCRYPTION_MANIFEST_SPACE
    : rawCidRevocation ? permission.space! : normalizePkhIdentifier(ownerSpaceId(permission.space ?? "", ownerDid));
  const path = rawEncryption ? normalizePkhIdentifier(permission.path) : permission.path;
  return permission.actions.map((action) =>
    JSON.stringify([service, space, path, action.includes("/") ? action : `${service}/${action}`]));
}

/** Old OpenKey's signed space-prefixed decrypt is not a usable raw network grant. */
export function isLegacyNestedDecrypt(
  permission: PermissionEntry,
  requested: readonly PermissionEntry[],
  ownerDid: string,
  spaceId: string,
): boolean {
  return isRawEncryptionPermission(permission) && !isVerifiedRawEncryptionPermission(permission) &&
    normalizePkhIdentifier(ownerSpaceId(permission.space ?? "", ownerDid)) === normalizePkhIdentifier(spaceId) &&
    rawEncryptionOwnerMatches(permission.path, ownerDid) &&
    permission.actions.every((action) => action === "tinycloud.encryption/decrypt") &&
    requested.some((entry) => isRawEncryptionPermission(entry) &&
      normalizePkhIdentifier(entry.path) === normalizePkhIdentifier(permission.path) &&
      permission.actions.every((action) => entry.actions.includes(action)));
}

/** JSON with object keys sorted, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(canonical)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([name, inner]) => [name, canonical(inner)]))
      : entry;
  return JSON.stringify(canonical(value) ?? null);
}

/**
 * The restriction a permission's ReCap caveats impose: "" when unrestricted
 * (no caveats, or only empty ones), else their canonical, order-independent JSON.
 */
function caveatRestriction(caveats: readonly Record<string, unknown>[] | undefined): string {
  const restrictions = (caveats ?? []).filter((caveat) => Object.keys(caveat).length > 0).map(canonicalJson).sort();
  return restrictions.length === 0 ? "" : JSON.stringify(restrictions);
}

/**
 * Whether `granted` holds every action `held` holds, with no added caveat:
 * a granted action covers a held one when it is unrestricted or carries
 * exactly the same caveats. Caveats only narrow, so an action signed with a
 * new caveat (say `{tenant: "alpha"}`) does not cover the unrestricted one.
 */
export function scopeCovers(granted: readonly PermissionEntry[], held: readonly PermissionEntry[], ownerDid: string): boolean {
  const grants = new Map<string, Set<string>>();
  for (const permission of granted) {
    const restriction = caveatRestriction(permission.caveats);
    for (const tuple of actionTuples(permission, ownerDid)) {
      const restrictions = grants.get(tuple) ?? new Set<string>();
      restrictions.add(restriction);
      grants.set(tuple, restrictions);
    }
  }
  return held.every((permission) => {
    const restriction = caveatRestriction(permission.caveats);
    return actionTuples(permission, ownerDid).every((tuple) => {
      const restrictions = grants.get(tuple);
      return restrictions !== undefined && (restrictions.has("") || restrictions.has(restriction));
    });
  });
}

/**
 * A verified ReCap caveat as plain JSON. The WASM verifier (serde-wasm-bindgen)
 * returns JSON objects as `Map`s and JSON `null` as `undefined`; both are
 * converted back, as node-sdk does on restore, so login, renewal and restore
 * compare the same signed values.
 */
function plainCaveat(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(plainCaveat);
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([name, inner]: [unknown, unknown]) => {
      if (typeof name !== "string") throw new Error("ReCap caveat keys must be strings");
      return [name, plainCaveat(inner)];
    }));
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, plainCaveat(inner)]));
  }
  throw new Error("ReCap caveats must contain only JSON values");
}

function plainCaveats(caveats: readonly unknown[] | undefined): Record<string, unknown>[] {
  return (caveats ?? []).map((caveat) => {
    const plain = plainCaveat(caveat);
    if (plain === null || typeof plain !== "object" || Array.isArray(plain)) throw new Error("ReCap caveats must be objects");
    return plain as Record<string, unknown>;
  }).filter((caveat) => Object.keys(caveat).length > 0);
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

/** Requested actions the signed grant does not carry: what the owner unchecked. */
export function declinedPermissions(requested: readonly PermissionEntry[], signed: readonly PermissionEntry[], ownerDid: string): PermissionEntry[] {
  const granted = permissionTuples(signed, ownerDid);
  const missing = [...permissionTuples(requested, ownerDid)].filter((tuple) => !granted.has(tuple));
  const requestedScopes = new Map<string, { space: string; path: string }>();
  for (const entry of requested) {
    const space = isVerifiedRawEncryptionPermission(entry)
      ? entry.space ?? ENCRYPTION_MANIFEST_SPACE
      : isRawCidRevocationPermission(entry) ? entry.space! : ownerSpaceId(entry.space ?? "", ownerDid);
    for (const tuple of actionTuples(entry, ownerDid)) {
      requestedScopes.set(tuple, { space, path: entry.path });
    }
  }
  return permissionsFromTuples(missing).map((entry) => {
    const original = requestedScopes.get(actionTuples(entry, ownerDid)[0]!);
    return original === undefined ? entry : { ...entry, ...original };
  });
}

/**
 * A first-login scope: one TinyCloud space, plus optional raw encryption
 * network entries (`space: "encryption"`), which are not a second space.
 */
export function validateLoginPermissions(permissions: PermissionEntry[]): void {
  const spaced = permissions.filter((p) => !isRawEncryptionPermission(p));
  if (!spaced.length || permissions.some((p) =>
    !p.service?.startsWith("tinycloud.") || !p.space ||
    (isRawEncryptionPermission(p)
      ? p.space !== ENCRYPTION_MANIFEST_SPACE
      : !p.space.startsWith("tinycloud:") && !/^[A-Za-z0-9_-]+$/.test(p.space)) ||
    typeof p.path !== "string" || !p.actions?.length ||
    p.actions.some((action) => !action.startsWith(`${p.service}/`)),
  ) || new Set(spaced.map((p) => normalizePkhIdentifier(p.space ?? ""))).size !== 1) {
    throw new CLIError("INVALID_LOGIN_SCOPE", "First login requires non-empty permissions in one TinyCloud space (raw tinycloud.encryption network entries may accompany them). Request additional spaces after login.", ExitCode.USAGE_ERROR);
  }
}

/**
 * The scope a scoped OpenKey login requests: the validated manifest plus
 * `tinycloud.capabilities/read` on the space root, which OpenKey requires
 * before it signs any delegation.
 */
export function scopedLoginPermissions(permissions: PermissionEntry[]): PermissionEntry[] {
  // Validation guarantees one non-raw entry with a non-empty space.
  return withCapabilitiesRead(permissions, permissions.find((p) => !isRawEncryptionPermission(p))!.space ?? "");
}

/**
 * One escalation grant (one space's group of a `tc secrets` missing grant or
 * `auth request --grant`) as OpenKey `/delegate` signs it: the group's
 * single space, raw decrypt in the `encryption` pseudo-space with its owner
 * EIP-55 checksummed (the spelling the SDK invokes with), and
 * `tinycloud.capabilities/read` on the space root. A decrypt-only group has
 * no space of its own, so it is anchored on `anchorSpace`; OpenKey refuses a
 * request whose non-raw entries do not name exactly one space.
 */
export function grantRequestPermissions(group: PermissionEntry[], anchorSpace: string): PermissionEntry[] {
  const request = group.map((p) => isRawEncryptionPermission(p)
    ? { ...p, space: ENCRYPTION_MANIFEST_SPACE, path: canonicalNetworkUrn(p.path) }
    : p);
  return withCapabilitiesRead(request, request.find((p) => !isRawEncryptionPermission(p))?.space ?? anchorSpace);
}

function withCapabilitiesRead(permissions: PermissionEntry[], space: string): PermissionEntry[] {
  const hasRead = permissions.some((p) =>
    p.service === "tinycloud.capabilities" && p.path === "" && p.actions.includes(CAPABILITIES_READ) &&
    normalizePkhIdentifier(p.space ?? "") === normalizePkhIdentifier(space));
  return hasRead
    ? permissions
    : [{ service: "tinycloud.capabilities", space, path: "", actions: [CAPABILITIES_READ] }, ...permissions];
}

export interface SignedSessionExpectations {
  /** Primary DID the approving identity must match, when known. */
  expectedOwner?: string;
  /** Requested `--expiry`; a signed expiry beyond it (+ skew) is refused. */
  expiry?: RequestedExpiry;
  /** Grant escalation stores a portable delegation, not a login session. */
  purpose?: "grant";
}

/** What the WASM verifier returns (its binding is untyped). Caveats arrive as `Map`s. */
interface VerifiedSessionProof {
  verifiedRecap?: Array<{ service: string; space: string; path: string; actions: string[]; caveats?: unknown[] }>;
  expiresAt?: string;
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
  const notStored = expected.purpose === "grant" ? "No grant was stored." : "No session was saved.";
  let permissions: PermissionEntry[];
  let expiresAt: string;
  try {
    if (typeof data.siwe !== "string" || typeof data.signature !== "string" ||
      typeof data.address !== "string" || !Number.isSafeInteger(data.chainId) ||
      typeof data.spaceId !== "string" || typeof data.delegationCid !== "string" ||
      !data.delegationHeader || typeof data.delegationHeader !== "object" ||
      typeof data.verificationMethod !== "string" ||
      data.verificationMethod.split("#")[0] !== sessionDid.split("#")[0]) throw new Error();
    const proof: VerifiedSessionProof = new NodeWasmBindings().validatePersistedSession({
      delegationHeader: data.delegationHeader as { Authorization: string },
      delegationCid: data.delegationCid, spaceId: data.spaceId,
      jwk: key, address: data.address, chainId: data.chainId as number,
      siwe: data.siwe, signature: data.signature,
    });
    if (!proof.verifiedRecap?.length || !proof.expiresAt || !Number.isFinite(Date.parse(proof.expiresAt))) throw new Error();
    // One entry per signed action, with its caveats. Dropping them would
    // record a restricted action as unrestricted.
    permissions = proof.verifiedRecap.map((entry) => {
      const service = entry.service.startsWith("tinycloud.") ? entry.service : `tinycloud.${entry.service}`;
      const actions = entry.actions.map((action) => action.includes("/") ? action : `${service}/${action}`);
      const caveats = plainCaveats(entry.caveats);
      return { service, space: entry.space, path: entry.path, actions, ...(caveats.length > 0 ? { caveats } : {}) };
    });
    expiresAt = proof.expiresAt;
  } catch (error) {
    if (/expir/i.test(error instanceof Error ? error.message : String(error))) {
      throw new CLIError("AUTH_EXPIRED", `The approved session has expired. ${notStored}`, ExitCode.AUTH_REQUIRED);
    }
    throw Object.assign(
      new CLIError("OPENKEY_PROOF_INVALID", `OpenKey did not return a complete, verifiable session proof. ${notStored}`, ExitCode.AUTH_REQUIRED),
      { cause: error },
    );
  }
  const signedExpiry = Date.parse(expiresAt);
  if (signedExpiry <= Date.now()) {
    throw new CLIError("AUTH_EXPIRED", `The approved session has expired. ${notStored}`, ExitCode.AUTH_REQUIRED);
  }
  if (expected.expiry !== undefined && signedExpiry > expiryLimit(expected.expiry)) {
    throw new CLIError("OPENKEY_EXPIRY_EXCEEDED", `The signed session outlives the requested --expiry. ${notStored}`, ExitCode.PERMISSION_DENIED);
  }
  const ownerDid = `did:pkh:eip155:${data.chainId}:${data.address}`;
  if (expected.expectedOwner && normalizePkhIdentifier(expected.expectedOwner) !== normalizePkhIdentifier(ownerDid)) {
    throw new CLIError("OPENKEY_OWNER_MISMATCH", `The approved signing identity differs from this profile's owner. ${notStored} Use a new profile for another account.`, ExitCode.PERMISSION_DENIED);
  }
  return { ownerDid, permissions, expiresAt };
}

/** Verify signed authority, and that it stays inside the requested manifest, before a scoped login saves anything. */
export function verifyScopedLogin(
  data: Record<string, unknown>,
  key: object,
  sessionDid: string,
  requested: PermissionEntry[],
  expected: SignedSessionExpectations = {},
): { session: Record<string, unknown> & SignedSession; legacyNested: PermissionEntry[] } {
  const notStored = expected.purpose === "grant" ? "No grant was stored." : "No scoped session was saved.";
  let signed: SignedSession;
  try {
    signed = verifySignedSession(data, key, sessionDid, expected);
  } catch (error) {
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
    if (
      requested.some(isRawCidRevocationPermission) &&
      /invalid ReCap resource URI/i.test(cause instanceof Error ? cause.message : String(cause ?? ""))
    ) {
      throw new CLIError(
        "RAW_RECAP_RESOURCE_UNSUPPORTED",
        "This WASM build cannot verify raw urn:cid ReCap resources.",
        ExitCode.PERMISSION_DENIED,
      );
    }
    throw error;
  }
  const spaceId = data.spaceId as string;
  for (const permission of requested) {
    if (isRawEncryptionPermission(permission) || isRawCidRevocationPermission(permission)) continue;
    if (normalizePkhIdentifier(ownerSpaceId(permission.space ?? "", signed.ownerDid)) !== normalizePkhIdentifier(spaceId)) {
      throw new CLIError("OPENKEY_SCOPE_MISMATCH", `The approved space differs from the requested space. ${notStored}`, ExitCode.PERMISSION_DENIED);
    }
  }
  // Old OpenKey signs requested decrypt inside the session space rather than
  // as a top-level network resource. It cannot decrypt on the node: retain
  // the proof, but omit the unusable nested resource from approved authority.
  const legacyNested: PermissionEntry[] = [];
  const approved: PermissionEntry[] = [];
  for (const permission of signed.permissions) {
    (isLegacyNestedDecrypt(permission, requested, signed.ownerDid, spaceId) ? legacyNested : approved).push(permission);
  }
  for (const permission of signed.permissions) {
    if (isVerifiedRawEncryptionPermission(permission) &&
      !rawEncryptionOwnerMatches(permission.path, signed.ownerDid)) {
      throw new CLIError("OPENKEY_SCOPE_MISMATCH", `OpenKey signed decrypt for a network not owned by the approving identity. ${notStored}`, ExitCode.PERMISSION_DENIED);
    }
  }
  // A signed action is inside the request when a requested one covers it: the
  // same action, unrestricted or with the same caveats (OpenKey may narrow).
  if (!scopeCovers(requested, approved, signed.ownerDid)) {
    throw new CLIError("OPENKEY_GRANT_BROADENED", `The signed grant contains authority beyond the requested ${expected.purpose === "grant" ? "grant" : "manifest"}. ${notStored}`, ExitCode.PERMISSION_DENIED);
  }
  // The SIWE proof stays intact for validation/diagnostics. Only effective,
  // requested authority is recorded as approved and compared on renewals.
  const session = withVerifiedAuthority({ ...data, jwk: key }, { ...signed, permissions: approved });
  return { session, legacyNested };
}
