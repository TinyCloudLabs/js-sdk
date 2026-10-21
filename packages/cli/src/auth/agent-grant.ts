import { SiweMessage } from "siwe";
import { NodeWasmBindings, type PermissionEntry, type PortableDelegation } from "@tinycloud/node-sdk";
import { ed25519PublicKeyFromDidKey } from "@tinycloud/share-envelope";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import type { RequestedExpiry } from "./scoped-login.js";
import { isRawEncryptionPermission } from "../lib/raw-encryption.js";
import {
  CLOCK_SKEW_MS,
  expiryLimit,
  isRawCidRevocationPermission,
  ownerSpaceId,
  permissionsFromVerifiedRecap,
  scopeCovers,
} from "./scoped-login.js";

const NOT_STORED = "No grant was stored.";
const CAPABILITIES_SERVICE = "tinycloud.capabilities";
/** Domain that OpenKey's delegate endpoint signs every approval under, independent of the node host. */
const OPENKEY_APPROVAL_DOMAIN = "cli.tinycloud.xyz";

/** Ed25519 public key of the requester's session as a JWK. The private key never leaves the agent. */
export function requesterPublicJwk(sessionDid: string): { kty: "OKP"; crv: "Ed25519"; x: string } {
  let publicKey: Uint8Array;
  try {
    publicKey = ed25519PublicKeyFromDidKey(sessionDid.split("#")[0]!);
  } catch (error) {
    throw Object.assign(
      new CLIError("INVALID_AUTH_REQUEST", "The auth request's sessionDid is not an Ed25519 did:key.", ExitCode.USAGE_ERROR),
      { cause: error },
    );
  }
  return { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") };
}

export interface AgentApprovalExpectations {
  /** The requester's session DID, from the auth request artifact. */
  sessionDid: string;
  expectedOwner: string | undefined;
  expiry: RequestedExpiry;
  /** The requested permissions, after `grantRequestPermissions`. */
  requested: readonly PermissionEntry[];
  /** The requester host passed to OpenKey; the approval's domain must be its authority. */
  host: string;
}

export interface VerifiedAgentApproval {
  ownerDid: string;
  spaceId: string;
  permissions: PermissionEntry[];
  expiresAt: string;
}

function refuse(code: string, message: string, exit: ExitCode = ExitCode.PERMISSION_DENIED): CLIError {
  return new CLIError(code, `${message} ${NOT_STORED}`, exit);
}

/** Reason from a failed `SiweMessage.verify`, which rejects with a result object rather than an Error. */
function siweErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "error" in error && error.error && typeof error.error === "object" &&
    "type" in error.error && typeof error.error.type === "string") {
    return error.error.type;
  }
  return "";
}

/** Ability map for an approved ReCap, in the shape the WASM emitter renders. */
function recapAbilities(entries: readonly PermissionEntry[]): Record<string, Record<string, string[]>> {
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const entry of entries) {
    const service = entry.service.slice("tinycloud.".length);
    const paths = (abilities[service] ??= {});
    paths[entry.path] = [...new Set([...(paths[entry.path] ?? []), ...entry.actions])];
  }
  return abilities;
}

/**
 * The signed statement and resources must be exactly what the WASM emitter
 * renders for the approved ReCap: nothing added, nothing rewritten.
 */
function statementMatchesRecap(
  message: SiweMessage,
  spaceId: string,
  approved: readonly PermissionEntry[],
  sessionDid: string,
): boolean {
  const rendered = new SiweMessage(new NodeWasmBindings().prepareSession({
    abilities: recapAbilities(approved),
    address: message.address,
    chainId: message.chainId,
    domain: message.domain,
    spaceId,
    jwk: requesterPublicJwk(sessionDid),
    issuedAt: message.issuedAt!,
    expirationTime: message.expirationTime!,
  }).siwe);
  return (rendered.statement ?? "") === (message.statement ?? "") &&
    JSON.stringify(rendered.resources ?? []) === JSON.stringify(message.resources ?? []);
}


/**
 * Verify an OpenKey approval for an agent request before it is written to disk.
 * The approval must be signed by the pinned owner, issued to the requester's
 * session, expire within the cap, and cover no more than the requested scope.
 */
export async function verifyAgentApproval(
  data: Record<string, unknown>,
  expected: AgentApprovalExpectations,
): Promise<VerifiedAgentApproval> {
  const sessionDid = expected.sessionDid.split("#")[0]!;
  if (typeof data.siwe !== "string" || typeof data.signature !== "string" ||
    typeof data.address !== "string" || !Number.isSafeInteger(data.chainId) ||
    typeof data.spaceId !== "string" || typeof data.delegationCid !== "string" ||
    !data.delegationHeader || typeof data.delegationHeader !== "object" ||
    typeof data.verificationMethod !== "string" ||
    data.verificationMethod.split("#")[0] !== sessionDid) {
    throw refuse("OPENKEY_PROOF_INVALID", "OpenKey did not return a complete approval for this agent.", ExitCode.AUTH_REQUIRED);
  }
  if (expected.expectedOwner === undefined) {
    throw refuse("OPENKEY_OWNER_MISMATCH", "This profile has no pinned owner to approve against.");
  }

  let message: SiweMessage;
  try {
    message = new SiweMessage(data.siwe);
    await message.verify({ signature: data.signature });
  } catch (error) {
    if (/expir/i.test(siweErrorText(error))) {
      throw refuse("AUTH_EXPIRED", "The approval has expired.", ExitCode.AUTH_REQUIRED);
    }
    throw Object.assign(
      refuse("OPENKEY_PROOF_INVALID", "The approval signature does not verify against its message.", ExitCode.AUTH_REQUIRED),
      { cause: error },
    );
  }

  const ownerDid = `did:pkh:eip155:${data.chainId}:${data.address}`;
  if (normalizePkhIdentifier(expected.expectedOwner) !== normalizePkhIdentifier(ownerDid)) {
    throw refuse("OPENKEY_OWNER_MISMATCH", "The approving identity differs from this profile's owner. Use a new profile for another account.");
  }
  if (message.address.toLowerCase() !== data.address.toLowerCase() || message.chainId !== data.chainId) {
    throw refuse("OPENKEY_PROOF_INVALID", "The approval's signer does not match its owner.", ExitCode.AUTH_REQUIRED);
  }
  if (message.uri.split("#")[0] !== sessionDid) {
    throw refuse("OPENKEY_AUDIENCE_MISMATCH", "The approval was issued to a different session than this auth request.");
  }
  if (message.domain !== OPENKEY_APPROVAL_DOMAIN) {
    throw refuse("OPENKEY_AUDIENCE_MISMATCH", "The approval was not issued by OpenKey's approval domain.");
  }

  const now = Date.now();
  const expiresMs = Date.parse(message.expirationTime ?? "");
  if (!Number.isFinite(expiresMs)) {
    throw refuse("OPENKEY_PROOF_INVALID", "The approval has no expiry.", ExitCode.AUTH_REQUIRED);
  }
  if (expiresMs <= now) {
    throw refuse("AUTH_EXPIRED", "The approval has expired.", ExitCode.AUTH_REQUIRED);
  }
  if (expiresMs > expiryLimit(expected.expiry)) {
    throw refuse("OPENKEY_EXPIRY_EXCEEDED", "The approval outlives the grant's expiry cap.");
  }
  const issuedMs = Date.parse(message.issuedAt ?? "");
  if (!Number.isFinite(issuedMs) || issuedMs > now + CLOCK_SKEW_MS) {
    throw refuse("OPENKEY_PROOF_INVALID", "The approval's issue time is invalid.", ExitCode.AUTH_REQUIRED);
  }
  if (message.notBefore !== undefined && Date.parse(message.notBefore) > now + CLOCK_SKEW_MS) {
    throw refuse("OPENKEY_PROOF_INVALID", "The approval is not yet valid.", ExitCode.AUTH_REQUIRED);
  }
  if ((message.resources ?? []).some((resource) => !resource.startsWith("urn:recap:"))) {
    throw refuse("OPENKEY_PROOF_INVALID", "The approval names a resource outside its ReCap.", ExitCode.AUTH_REQUIRED);
  }

  let approved: PermissionEntry[];
  try {
    approved = permissionsFromVerifiedRecap(new NodeWasmBindings().parseVerifiedRecapFromSiwe(data.siwe));
  } catch (error) {
    throw Object.assign(
      refuse("OPENKEY_PROOF_INVALID", "The approval's ReCap could not be read.", ExitCode.AUTH_REQUIRED),
      { cause: error },
    );
  }
  if (approved.length === 0) {
    throw refuse("OPENKEY_PROOF_INVALID", "The approval grants no authority.", ExitCode.AUTH_REQUIRED);
  }
  for (const permission of [...approved, ...expected.requested]) {
    if (permission.service === CAPABILITIES_SERVICE) continue;
    if (normalizePkhIdentifier(ownerSpaceId(permission.space ?? "", ownerDid)) !== normalizePkhIdentifier(data.spaceId)) {
      throw refuse("OPENKEY_SCOPE_MISMATCH", "The approved space differs from the requested space.");
    }
  }
  if (!scopeCovers(expected.requested, approved, ownerDid)) {
    throw refuse("OPENKEY_GRANT_BROADENED", "The approval contains authority beyond the requested grant.");
  }
  if (!statementMatchesRecap(message, data.spaceId, approved, expected.sessionDid)) {
    throw refuse("OPENKEY_PROOF_INVALID", "The approval's statement or resources do not match its ReCap.", ExitCode.AUTH_REQUIRED);
  }
  return { ownerDid, spaceId: data.spaceId, permissions: approved, expiresAt: message.expirationTime! };
}

/** Portable delegation built from an approval that `verifyAgentApproval` accepted. */
export function portableFromAgentApproval(
  data: Record<string, unknown>,
  verified: VerifiedAgentApproval,
  host: string,
): PortableDelegation {
  const effective = verified.permissions;
  // The headline resource is a requested data entry, not capabilities/read.
  const spaced = effective.filter((permission) =>
    !isRawEncryptionPermission(permission) && !isRawCidRevocationPermission(permission)
  );
  const primary = spaced.find((permission) => permission.service !== CAPABILITIES_SERVICE) ?? spaced[0] ?? effective[0]!;
  const resources = effective.map((permission) => ({
    service: permission.service.slice("tinycloud.".length),
    space: verified.spaceId,
    path: permission.path,
    actions: [...permission.actions],
    ...(permission.caveats === undefined ? {} : { caveats: structuredClone(permission.caveats) }),
  }));
  const ownerParts = verified.ownerDid.split(":");
  return {
    cid: data.delegationCid as string,
    delegationHeader: data.delegationHeader as { Authorization: string },
    spaceId: verified.spaceId,
    path: primary.path,
    actions: [...primary.actions],
    resources,
    expiry: new Date(verified.expiresAt),
    delegateDID: data.verificationMethod as string,
    ownerAddress: ownerParts[4]!,
    chainId: Number(ownerParts[3]),
    host,
    siweProof: { siwe: data.siwe as string, signature: data.signature as string },
  };
}

/** Every auth grant on an OpenKey owner profile is approved in OpenKey, whatever it requests. */
export function requiresAgentApproval(authMethod: string | undefined): boolean {
  return authMethod === "openkey";
}
