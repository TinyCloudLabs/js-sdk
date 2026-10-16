import { parseNetworkId, parseScopedDecryptResource } from "@tinycloud/node-sdk";
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
  try {
    if (path.includes("/kv/")) {
      parseScopedDecryptResource(path);
      return path;
    }
    const network = parseNetworkId(path);
    return `urn:tinycloud:encryption:${canonicalOwnerDid(network.ownerDid)}:${network.name}`;
  } catch {
    return path;
  }
}

/** Only a network owned by the signer may appear as a raw decrypt grant. */
export function rawEncryptionOwnerMatches(path: string, ownerDid: string): boolean {
  try {
    const networkId = path.includes("/kv/")
      ? parseScopedDecryptResource(path).networkId
      : parseNetworkId(path).networkId;
    return canonicalOwnerDid(parseNetworkId(networkId).ownerDid) === canonicalOwnerDid(ownerDid);
  } catch {
    return false;
  }
}
