import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import type { ProfileConfig } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { resolveSpaceUri } from "./space.js";

/** Minimal shape of a kv/sql service error this module inspects. */
interface ServiceErrorLike {
  code: string;
  message: string;
  meta?: { status?: number } & Record<string, unknown>;
}

/**
 * Host-request artifact: a delegate's ASK that the owner host a space.
 *
 * `tc space host-request --emit` writes this; the human relays it to the
 * owner, who runs `tc space host <name>`. It is NOT a delegation and grants
 * nothing — it only names the space (and its resolved owner DID) so the owner
 * knows what to host.
 */
export interface HostRequestArtifact {
  kind: "tinycloud.host.request";
  version: 1;
  requestId: string;
  createdAt: string;
  /** The space short name the owner should host (`tc space host <name>`). */
  spaceName: string;
  /** Fully-resolved owner space URI the host action targets. */
  spaceId: string;
  /** The owner principal expected to perform the host (root authority). */
  ownerDid: string;
  /** The delegate that is asking (audit / who to grant to afterwards). */
  requesterDid: string;
  /** TinyCloud node the space must be hosted on. */
  host: string;
}

function canonicalizeAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.startsWith("0x")
    ? `0x${trimmed.slice(2).toLowerCase()}`
    : trimmed.toLowerCase();
}

/**
 * Resolve the active profile's Ethereum address with no network call.
 * Mirrors the source priority in lib/space.ts (session.address → profile.address
 * → ownerDid pkh address); returns null when none can be determined.
 */
async function resolveLocalAddress(
  profile: ProfileConfig,
  profileName: string,
): Promise<string | null> {
  const session = (await ProfileManager.getSession(profileName)) as
    | Record<string, unknown>
    | null;
  const sessAddr = session?.address;
  if (typeof sessAddr === "string" && sessAddr.length > 0) {
    return canonicalizeAddress(sessAddr);
  }
  if (profile.address) return canonicalizeAddress(profile.address);
  if (profile.ownerDid) {
    const match = profile.ownerDid.match(/^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})$/);
    if (match) return canonicalizeAddress(match[1]);
  }
  return null;
}

/** Extract the owner address segment from a `tinycloud:pkh:eip155:<chain>:<addr>:<name>` URI. */
function ownerAddressFromSpaceUri(spaceUri: string): string | null {
  const match = spaceUri.match(/^tinycloud:pkh:eip155:\d+:(0x[a-fA-F0-9]{40}):/);
  return match ? canonicalizeAddress(match[1]) : null;
}

/**
 * Owner principal of a `tinycloud:pkh:eip155:<chain>:<addr>:<name>` space URI,
 * as a `did:pkh:eip155:<chain>:<addr>`. Returns null for non-pkh URIs.
 */
export function ownerDidFromSpaceUri(spaceUri: string): string | null {
  const match = spaceUri.match(/^tinycloud:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40}):/);
  if (!match) return null;
  return `did:pkh:eip155:${match[1]}:${canonicalizeAddress(match[2])}`;
}

/**
 * Decide LOCALLY (no network) whether the active profile is the root authority
 * (owner) of a resolved space URI. True iff the profile's own address equals
 * the owner address baked into the space DID. Only the root authority may host
 * a space — a delegate's key never matches, so this is the same branch key the
 * server enforces cryptographically, computed client-side for actionable hints.
 */
export async function isRootAuthority(
  spaceUri: string,
  profileName: string,
): Promise<boolean> {
  const profile = await ProfileManager.getProfile(profileName);
  const ownerAddr = ownerAddressFromSpaceUri(spaceUri);
  if (!ownerAddr) return false;
  const selfAddr = await resolveLocalAddress(profile, profileName);
  return selfAddr !== null && selfAddr === ownerAddr;
}

/** Last `:`-delimited segment of a space URI is its short name. */
export function spaceNameFromUri(spaceUri: string): string {
  return spaceUri.slice(spaceUri.lastIndexOf(":") + 1);
}

/**
 * Detect the EXACT unhosted-space condition and, only then, return an
 * identity-aware SPACE_NOT_HOSTED CLIError. Returns null for every other
 * failure (wrong db/table/path, permission, network) so the caller throws the
 * original error untouched — we never mislabel a non-host problem as a host one.
 *
 * The unhosted condition is a 404 whose message says "Space not found" (the
 * server's wording for an un-hosted space; a missing db/table inside a hosted
 * space returns a different body). The hint branches on is_root_authority,
 * computed locally from the profile address + space DID (no network).
 */
export async function unhostedSpaceError(
  error: ServiceErrorLike,
  spaceUri: string | undefined,
  profileName: string,
): Promise<CLIError | null> {
  // Without a resolved space URI the op targeted the primary space, which is
  // auto-hosted at sign-in — this branch can't be an unhosted-space problem.
  if (!spaceUri) return null;

  const status = error.meta?.status;
  const isUnhosted = status === 404 && /space not found/i.test(error.message);
  if (!isUnhosted) return null;

  const spaceName = spaceNameFromUri(spaceUri);
  const owner = await isRootAuthority(spaceUri, profileName);
  const hint = owner
    ? [
        "You are the owner. Host it once:",
        `  tc space host ${spaceName}`,
        "Then retry.",
      ].join("\n")
    : [
        "You are a delegate and CANNOT host this space — only its owner can.",
        "Emit a host request:",
        `  tc space host-request ${spaceName} --emit ./host-request.json`,
        "Send it to the owner; they run `tc space host` and confirm. Then retry.",
      ].join("\n");

  const message = owner
    ? `Space '${spaceName}' (${spaceUri}) is not hosted.`
    : `Space '${spaceName}' (owner ${ownerDidFromSpaceUri(spaceUri) ?? spaceUri}) is not hosted.`;

  return new CLIError("SPACE_NOT_HOSTED", message, ExitCode.ERROR, { hint });
}

/**
 * Resolve a `--space`-style name/URI to its full owner space URI for hosting.
 * Unlike the kv/sql path, hosting always needs a concrete space, so this never
 * returns undefined — a bare name resolves against the active profile's address.
 */
export async function resolveHostSpace(
  name: string,
  profileName: string,
): Promise<string> {
  const resolved = await resolveSpaceUri(name, profileName);
  if (!resolved) {
    // Unreachable in practice: resolveSpaceUri only returns undefined when its
    // input is empty AND no default space is set; host-request requires a name.
    throw new Error(`Could not resolve a space for "${name}".`);
  }
  return resolved;
}
