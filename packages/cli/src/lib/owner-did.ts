import { ensureEip55 } from "@tinycloud/node-sdk-wasm";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

/** The network owner identity in the EIP-55 spelling expected by the node. */
export function canonicalOwnerDid(did: string, label = "--owner"): string {
  const match = /^did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(did);
  if (!match) {
    throw new CLIError("INVALID_ARGUMENT", `${label} "${did}" is not a did:pkh:eip155:CHAIN:ADDRESS identity.`, ExitCode.USAGE_ERROR);
  }
  return `did:pkh:eip155:${match[1]}:${ensureEip55(match[2]!)}`;
}

/**
 * A raw network URN with its owner in EIP-55 spelling, the form the SDK
 * invokes with; a grant for a differently cased URN is never selected.
 */
export function canonicalNetworkUrn(path: string): string {
  const match = /^urn:tinycloud:encryption:(did:pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40}):([^:]*)$/.exec(path);
  return match ? `urn:tinycloud:encryption:${canonicalOwnerDid(match[1]!)}:${match[2]}` : path;
}

/** Only a network owned by the signer may appear as a raw decrypt grant. */
export function rawEncryptionOwnerMatches(path: string, ownerDid: string): boolean {
  const match = /^urn:tinycloud:encryption:(did:pkh:eip155:.+):([a-z0-9][a-z0-9-]*)$/.exec(path);
  if (!match) return false;
  try {
    return canonicalOwnerDid(match[1]!) === canonicalOwnerDid(ownerDid);
  } catch {
    return false;
  }
}
