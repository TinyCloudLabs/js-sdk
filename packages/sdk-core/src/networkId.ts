import {
  buildNetworkId,
  parseNetworkId,
  type ParsedNetworkId,
} from "@tinycloud/sdk-services";

import { canonicalizeDid } from "./identity";

export interface CanonicalParsedNetworkId extends ParsedNetworkId {
  /** Owner DID canonicalized with TinyCloud identity rules. */
  ownerDid: string;
}

/**
 * Canonicalize a TinyCloud encryption network id.
 *
 * Network ids embed an owner DID. For `did:pkh:eip155` owners, address casing
 * can vary between SIWE/session tokens and delegated network resources. This
 * helper parses the network id, canonicalizes the owner DID, and rebuilds the
 * URN so comparisons can use one stable representation.
 */
export function canonicalizeNetworkId(networkId: string): string {
  const parsed = parseNetworkId(networkId);
  return buildNetworkId(canonicalizeDid(parsed.ownerDid), parsed.name);
}

export function parseCanonicalNetworkId(
  networkId: string,
): CanonicalParsedNetworkId {
  const canonical = canonicalizeNetworkId(networkId);
  return parseNetworkId(canonical) as CanonicalParsedNetworkId;
}
