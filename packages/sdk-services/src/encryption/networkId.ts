/**
 * TinyCloud encryption network identifiers.
 *
 * A network id is `urn:tinycloud:encryption:<ownerDid>:<network>` where
 * `ownerDid` is the owner's DID and `network` is a
 * non-empty label drawn from `[a-z0-9][a-z0-9-]*`.
 *
 * The embedded owner DID is the root authority for the network: any
 * delegation chain ending in a `tinycloud.encryption/decrypt` grant on
 * the network must root at this owner DID.
 */

const URN_PREFIX = "urn:tinycloud:encryption:";
const NETWORK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const PKH_EIP155_DID_RE = /^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/;

export interface ParsedNetworkId {
  /** The full URN string. */
  networkId: string;
  /** Owner DID embedded in the URN (the network's root authority). */
  ownerDid: string;
  /** Network label (the suffix after the owner DID). */
  name: string;
}

export class NetworkIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkIdError";
  }
}

/**
 * Parse a network id string into its owner DID and name components.
 *
 * Throws {@link NetworkIdError} when the input does not match
 * `urn:tinycloud:encryption:<did>:<name>`, when the embedded DID is
 * malformed, or when the network name fails {@link NETWORK_NAME_RE}.
 */
export function parseNetworkId(networkId: string): ParsedNetworkId {
  if (typeof networkId !== "string" || networkId.length === 0) {
    throw new NetworkIdError("networkId must be a non-empty string");
  }
  if (!networkId.startsWith(URN_PREFIX)) {
    throw new NetworkIdError(
      `networkId must start with ${URN_PREFIX} (got ${JSON.stringify(networkId)})`,
    );
  }
  const body = networkId.slice(URN_PREFIX.length);
  // `body` = "<ownerDid>:<network>"
  // ownerDid contains ':' (e.g. did:key:z6Mk...), so we split on the LAST colon
  // and treat the suffix as the network name.
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === body.length - 1) {
    throw new NetworkIdError(
      `networkId missing ownerDid or name segment (got ${JSON.stringify(networkId)})`,
    );
  }
  const ownerDid = body.slice(0, lastColon);
  const name = body.slice(lastColon + 1);

  if (!ownerDid.startsWith("did:")) {
    throw new NetworkIdError(
      `networkId ownerDid must be a DID (got ${JSON.stringify(ownerDid)})`,
    );
  }
  // Minimal DID shape: did:<method>:<id> — three colon-separated segments,
  // each non-empty.
  const didParts = ownerDid.split(":");
  if (didParts.length < 3 || didParts.some((p) => p.length === 0)) {
    throw new NetworkIdError(
      `networkId ownerDid is not a well-formed DID (got ${JSON.stringify(ownerDid)})`,
    );
  }
  if (!NETWORK_NAME_RE.test(name)) {
    throw new NetworkIdError(
      `networkId name ${JSON.stringify(name)} must match ${NETWORK_NAME_RE.source}`,
    );
  }
  return { networkId, ownerDid, name };
}

export interface ParsedEncryptionResource extends ParsedNetworkId {
  /** Named-key path, if the resource is scoped below a network. */
  keyPath?: string;
}

/**
 * Parse a network-root or named-key encryption resource.
 *
 * A trailing slash on keyPath denotes a prefix grant; empty and traversal
 * segments are rejected so resource matching cannot escape the named path.
 */
export function parseEncryptionResource(
  resource: string,
): ParsedEncryptionResource {
  const networkSeparator = resource.lastIndexOf(":");
  const nameAndPath = resource.slice(networkSeparator + 1);
  const pathSeparator = nameAndPath.indexOf("/");
  const name =
    pathSeparator === -1
      ? nameAndPath
      : nameAndPath.slice(0, pathSeparator);
  const networkId =
    pathSeparator === -1
      ? resource
      : `${resource.slice(0, networkSeparator + 1)}${name}`;
  const parsed = parseNetworkId(networkId);
  if (pathSeparator === -1) return parsed;

  const keyPath = nameAndPath.slice(pathSeparator + 1);
  const segments = keyPath.split("/");
  const prefix = keyPath.endsWith("/");
  if (
    keyPath.length === 0 ||
    /[\u0000-\u001f\u007f\\]/.test(keyPath) ||
    segments.some(
      (segment, index) =>
        segment === "." ||
        segment === ".." ||
        (segment.length === 0 && !(prefix && index === segments.length - 1)),
    )
  ) {
    throw new NetworkIdError(
      `encryption resource has an invalid keyPath (got ${JSON.stringify(resource)})`,
    );
  }
  return { ...parsed, keyPath };
}

/**
 * Construct a network id URN from an owner DID and a network name.
 * Validates inputs and throws {@link NetworkIdError} on bad shape.
 */
export function buildNetworkId(ownerDid: string, name: string): string {
  if (typeof ownerDid !== "string" || !ownerDid.startsWith("did:")) {
    throw new NetworkIdError("ownerDid must be a DID");
  }
  if (typeof name !== "string" || !NETWORK_NAME_RE.test(name)) {
    throw new NetworkIdError(
      `network name ${JSON.stringify(name)} must match ${NETWORK_NAME_RE.source}`,
    );
  }
  const networkId = `${URN_PREFIX}${ownerDid}:${name}`;
  // Re-validate the composed result so the same error path triggers
  // for caller inputs that compose into a malformed URN.
  parseNetworkId(networkId);
  return networkId;
}

/**
 * Returns true when {@link networkId} is a syntactically valid network URN.
 */
export function isNetworkId(networkId: unknown): networkId is string {
  if (typeof networkId !== "string") {
    return false;
  }
  try {
    parseNetworkId(networkId);
    return true;
  } catch {
    return false;
  }
}

function parsePkhOwnerDid(ownerDid: string):
  | { chainId: string; address: string }
  | null {
  const match = ownerDid.match(PKH_EIP155_DID_RE);
  if (!match) return null;
  return {
    chainId: match[1],
    address: match[2].toLowerCase(),
  };
}

/**
 * Compare owner DIDs as network principals. For `did:pkh:eip155`, EVM
 * address casing is not part of principal identity; other DID methods
 * remain exact string matches.
 */
export function ownerDidMatches(a: string, b: string): boolean {
  const aPkh = parsePkhOwnerDid(a);
  const bPkh = parsePkhOwnerDid(b);
  if (aPkh && bPkh) {
    return aPkh.chainId === bPkh.chainId && aPkh.address === bPkh.address;
  }
  return a === b;
}

/**
 * Resolve the discovery key used to look up a network's descriptor under
 * an owner's public account-space.
 *
 * Format: `.well-known/encryption/network/<name>`.
 */
export function networkDiscoveryKey(name: string): string {
  if (!NETWORK_NAME_RE.test(name)) {
    throw new NetworkIdError(
      `network name ${JSON.stringify(name)} must match ${NETWORK_NAME_RE.source}`,
    );
  }
  return `.well-known/encryption/network/${name}`;
}

export const ENCRYPTION_NETWORK_URN_PREFIX = URN_PREFIX;
export const NETWORK_NAME_PATTERN = NETWORK_NAME_RE;
