import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import type { ProfileConfig } from "../config/types.js";
import {
  buildSpaceUri,
  canonicalizeAddress,
  makePkhSpaceId,
  parsePkhDid,
  parseSpaceUri,
} from "@tinycloud/node-sdk";

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
 *  - undefined          → undefined (caller falls back to node.spaceId)
 *  - "tinycloud:..."    → returned verbatim
 *  - bare name          → tinycloud:pkh:eip155:<chain>:<address>:<name>
 */
export async function resolveSpaceUri(
  input: string | undefined,
  profileName: string,
): Promise<string | undefined> {
  if (!input) return undefined;
  if (input.startsWith("tinycloud:")) {
    const parsed = parseSpaceUri(input);
    if (!parsed) {
      throw new CLIError(
        "INVALID_SPACE",
        `Invalid --space "${input}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
        ExitCode.USAGE_ERROR,
      );
    }
    return buildSpaceUri(parsed.owner, parsed.name);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new CLIError(
      "INVALID_SPACE",
      `Invalid --space "${input}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
      ExitCode.USAGE_ERROR,
    );
  }

  const profile = await ProfileManager.getProfile(profileName);
  const session = (await ProfileManager.getSession(profileName)) as Record<string, unknown> | null;

  const address = resolveAddress(profile, session);
  const chainId = resolveChainId(profile, session);
  return makePkhSpaceId(address, chainId, input);
}
