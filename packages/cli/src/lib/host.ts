import { CLI_NAME } from "@tinycloud/operations/cli-name";
import {
  discoverLocalTinyCloudNode,
  type LocalNodeIdentityStore,
} from "@tinycloud/sdk-core";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode, OPENKEY_SPACE_SETUP_RETRY_HINT } from "../config/constants.js";
import { resolveProfilePosture, type CLIContext, type ProfileConfig } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { resolveSpaceUri } from "./space.js";

/**
 * Trust-on-first-use pin store persisted in the profile's profile.json
 * (`pinnedLocalNodeDids`). A missing profile (e.g. during `tc init`) reads
 * as no pin and skips persisting — discovery still works, TOFU just stays
 * in-memory for that invocation.
 */
export function profileLocalNodeIdentityStore(
  profileName: string,
): LocalNodeIdentityStore {
  return {
    get: async (url) => {
      const profile = await ProfileManager.getProfile(profileName).catch(
        () => null,
      );
      return profile?.pinnedLocalNodeDids?.[url];
    },
    set: async (url, nodeDid) => {
      if (!await ProfileManager.profileExists(profileName)) return;
      await ProfileManager.updateProfile(profileName, (profile) => ({
        ...profile,
        pinnedLocalNodeDids: {
          ...profile.pinnedLocalNodeDids,
          [url]: nodeDid,
        },
      }));
    },
  };
}

/**
 * Probe for a configured or registered local TinyCloud node using the profile's discovery
 * knobs and profile-persisted DID pins. Returns the verified local node URL,
 * or null when discovery is disabled, nothing local is running, or the local
 * node fails identity verification — callers fall back to their normal host.
 */
export interface LocalDiscovery {
  readonly host: string | null;
  /** True when probing waits for a stored session that did not verify locally. */
  readonly deferred: boolean;
}

export async function discoverLocalNodeHost(
  profileName: string,
  options: { readonly awaitStoredSession: boolean },
): Promise<LocalDiscovery> {
  const profile = await ProfileManager.getProfile(profileName).catch(() => null);
  if (profile?.autoDiscoverLocalNode === false) return { host: null, deferred: false };
  if (!profile?.localNodeUrl && !profile?.localLinkName) return { host: null, deferred: false };
  if (options.awaitStoredSession) {
    // sdk.ts imports ProfileManager, so load its verifier lazily to avoid a module cycle.
    const { storedSessionVerifiesLocally } = await import("./sdk.js");
    if (!await storedSessionVerifiesLocally(profileName)) return { host: null, deferred: true };
  }
  const discovered = await discoverLocalTinyCloudNode({
    localNodeUrl: profile?.localNodeUrl,
    localLinkName: profile?.localLinkName,
    expectedNodeDid: profile?.expectedNodeDid,
    identityStore: profileLocalNodeIdentityStore(profileName),
  });
  return { host: discovered?.url ?? null, deferred: false };
}

/** Runs discovery `resolveContext` deferred, for a flow that replaces the refused session. A caller that chose another host keeps it. */
export async function completeDeferredLocalDiscovery(ctx: CLIContext): Promise<void> {
  const deferred = ctx.localDiscovery;
  if (deferred === undefined) return;
  delete ctx.localDiscovery;
  if (ctx.host !== deferred.deferredFrom) return;
  const discovered = await discoverLocalNodeHost(ctx.profile, { awaitStoredSession: false });
  if (discovered.host !== null) ctx.host = discovered.host;
}

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
 *
 * A `delegate-session` profile is NEVER the root authority, even when its stored
 * ownerDid/session.address is the SPACE OWNER's address (a delegate legitimately
 * knows whose space it accesses). Short-circuiting on posture prevents handing a
 * delegate the owner hint ("run tc space host"), which only the owner can do.
 */
export async function isRootAuthority(
  spaceUri: string,
  profileName: string,
): Promise<boolean> {
  const profile = await ProfileManager.getProfile(profileName);
  if (resolveProfilePosture(profile) === "delegate-session") return false;
  const ownerAddr = ownerAddressFromSpaceUri(spaceUri);
  if (!ownerAddr) return false;
  const selfAddr = await resolveLocalAddress(profile, profileName);
  return selfAddr !== null && selfAddr === ownerAddr;
}

/**
 * The space an operation with no `--space` targets: the stored session's own
 * space (the node's primary space), else the profile's recorded one.
 */
async function primarySpaceUri(profileName: string): Promise<string | undefined> {
  const session = await ProfileManager.getSession(profileName) as Record<string, unknown> | null;
  if (typeof session?.spaceId === "string" && session.spaceId !== "") return session.spaceId;
  const profile = await ProfileManager.getProfile(profileName);
  return typeof profile.spaceId === "string" && profile.spaceId !== "" ? profile.spaceId : undefined;
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
  requestedSpaceUri: string | undefined,
  profileName: string,
): Promise<CLIError | null> {
  const status = error.meta?.status;
  const isUnhosted = status === 404 && /space not found/i.test(error.message);
  if (!isUnhosted) return null;

  // No resolved space URI: the operation targeted the primary space. OpenKey
  // hosts it in the background after approval, so it can be unhosted right
  // after the first sign-in (TC-1608).
  const spaceUri = requestedSpaceUri ?? await primarySpaceUri(profileName);
  if (!spaceUri) return null;

  const spaceName = spaceNameFromUri(spaceUri);
  const owner = await isRootAuthority(spaceUri, profileName);
  // `tc space host` signs a host delegation, which an OpenKey session cannot
  // (TinyCloudNode.hostOwnedSpace needs a signer). OpenKey hosts the space itself.
  const openKeyOwner = owner && resolveProfilePosture(await ProfileManager.getProfile(profileName)) === "owner-openkey";
  const hint = openKeyOwner
    ? `OpenKey is still setting up your space. ${OPENKEY_SPACE_SETUP_RETRY_HINT}`
    : owner
    ? [
        "You are the owner. Host it once:",
        `  ${CLI_NAME} space host ${spaceName}`,
        "Then retry.",
      ].join("\n")
    : [
        "You are a delegate and CANNOT host this space — only its owner can.",
        "Emit a host request:",
        `  ${CLI_NAME} space host-request ${spaceName} --emit ./host-request.json`,
        `Send it to the owner; they run \`${CLI_NAME} space host\` and confirm. Then retry.`,
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
