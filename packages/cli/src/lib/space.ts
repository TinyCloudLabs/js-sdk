import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import type { ProfileConfig } from "../config/types.js";

interface ParsedPkhDid {
  address: string;
  chainId: number;
}

function canonicalizeAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.startsWith("0x")
    ? `0x${trimmed.slice(2).toLowerCase()}`
    : trimmed.toLowerCase();
}

function parsePkhDid(did: string): ParsedPkhDid | null {
  const match = did.match(/^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
  if (!match) return null;
  return {
    chainId: Number(match[1]),
    address: canonicalizeAddress(match[2]),
  };
}

function makePkhSpaceId(address: string, chainId: number, name: string): string {
  return `tinycloud:pkh:eip155:${chainId}:${canonicalizeAddress(address)}:${name}`;
}

function parseSpaceUri(input: string): { owner: string; name: string } | null {
  if (!input.startsWith("tinycloud:")) return null;
  const parts = input.split(":");
  if (parts.length < 3) return null;
  const name = parts.at(-1);
  if (!name) return null;
  return {
    owner: parts.slice(1, -1).join(":"),
    name,
  };
}

function buildSpaceUri(owner: string, name: string): string {
  return `tinycloud:${owner}:${name}`;
}

/**
 * Resolve the active profile's Ethereum address. Source priority matches
 * what TinyCloudNode.signIn / restoreSession actually populates:
 *   1) session.address (set by both local-key and OpenKey auth flows)
 *   2) profile.address (local-key auth only)
 *   3) the address segment of profile.ownerDid (did:pkh:eip155:<chain>:<addr>)
 */
function resolveAddress(profile: ProfileConfig, session: Record<string, unknown> | null): string {
  const sessAddr = session?.address;
  if (typeof sessAddr === "string" && sessAddr.length > 0) {
    return canonicalizeAddress(sessAddr);
  }

  if (profile.address) return canonicalizeAddress(profile.address);

  if (profile.ownerDid) {
    const pkh = parsePkhDid(profile.ownerDid);
    if (pkh) return pkh.address;
  }

  throw new CLIError(
    "ADDRESS_UNKNOWN",
    `Cannot determine Ethereum address for profile "${profile.name}". Run \`tc auth login\` to refresh the session.`,
    ExitCode.AUTH_REQUIRED,
  );
}

function resolveChainId(profile: ProfileConfig, session: Record<string, unknown> | null): number {
  const sessChain = session?.chainId;
  if (typeof sessChain === "number" && Number.isFinite(sessChain)) return sessChain;
  return profile.chainId;
}

/**
 * Resolve a --space CLI argument into a full TinyCloud space URI.
 *
 * Precedence: explicit `input` > profile `defaultSpace` > primary space.
 *
 *  - input given        → resolved (URI verbatim, or bare name → owner space)
 *  - input omitted, but profile has a defaultSpace → that name, resolved
 *  - input omitted, no defaultSpace → undefined (caller falls back to node.spaceId)
 *  - "tinycloud:..."    → returned verbatim
 *  - bare name          → tinycloud:pkh:eip155:<chain>:<address>:<name>
 */
export async function resolveSpaceUri(
  input: string | undefined,
  profileName: string,
): Promise<string | undefined> {
  const profile = await ProfileManager.getProfile(profileName);

  // Explicit --space overrides; otherwise fall back to the profile default.
  // When neither is set, return undefined so the caller routes to the primary space.
  const effective = input || profile.defaultSpace;
  if (!effective) return undefined;

  if (effective.startsWith("tinycloud:")) {
    const parsed = parseSpaceUri(effective);
    if (!parsed) {
      throw new CLIError(
        "INVALID_SPACE",
        `Invalid space "${effective}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
        ExitCode.USAGE_ERROR,
      );
    }
    return buildSpaceUri(parsed.owner, parsed.name);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(effective)) {
    throw new CLIError(
      "INVALID_SPACE",
      `Invalid space "${effective}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
      ExitCode.USAGE_ERROR,
    );
  }

  const session = (await ProfileManager.getSession(profileName)) as Record<string, unknown> | null;

  const address = resolveAddress(profile, session);
  const chainId = resolveChainId(profile, session);
  return makePkhSpaceId(address, chainId, effective);
}
