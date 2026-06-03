/**
 * TinyCloud encryption network identifiers.
 *
 * A network id is `urn:tinycloud:encryption:<principal>:<network>` where
 * `principal` is a DID (typically `did:key:...`) and `network` is a
 * non-empty label drawn from `[a-z0-9][a-z0-9-]*`.
 *
 * The embedded principal is the root authority for the network: any
 * delegation chain ending in a `tinycloud.encryption/decrypt` grant on
 * the network must root at this principal.
 */

const URN_PREFIX = "urn:tinycloud:encryption:";
const NETWORK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ParsedNetworkId {
  /** The full URN string. */
  networkId: string;
  /** Principal DID embedded in the URN (the network's root authority). */
  principal: string;
  /** Network label (the suffix after the principal). */
  name: string;
}

export class NetworkIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkIdError";
  }
}

/**
 * Parse a network id string into its principal and name components.
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
  // `body` = "<principal>:<network>"
  // principal contains ':' (e.g. did:key:z6Mk...), so we split on the LAST colon
  // and treat the suffix as the network name.
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === body.length - 1) {
    throw new NetworkIdError(
      `networkId missing principal or name segment (got ${JSON.stringify(networkId)})`,
    );
  }
  const principal = body.slice(0, lastColon);
  const name = body.slice(lastColon + 1);

  if (!principal.startsWith("did:")) {
    throw new NetworkIdError(
      `networkId principal must be a DID (got ${JSON.stringify(principal)})`,
    );
  }
  // Minimal DID shape: did:<method>:<id> — three colon-separated segments,
  // each non-empty.
  const didParts = principal.split(":");
  if (didParts.length < 3 || didParts.some((p) => p.length === 0)) {
    throw new NetworkIdError(
      `networkId principal is not a well-formed DID (got ${JSON.stringify(principal)})`,
    );
  }
  if (!NETWORK_NAME_RE.test(name)) {
    throw new NetworkIdError(
      `networkId name ${JSON.stringify(name)} must match ${NETWORK_NAME_RE.source}`,
    );
  }
  return { networkId, principal, name };
}

/**
 * Construct a network id URN from a principal DID and a network name.
 * Validates inputs and throws {@link NetworkIdError} on bad shape.
 */
export function buildNetworkId(principal: string, name: string): string {
  if (typeof principal !== "string" || !principal.startsWith("did:")) {
    throw new NetworkIdError("principal must be a DID");
  }
  if (typeof name !== "string" || !NETWORK_NAME_RE.test(name)) {
    throw new NetworkIdError(
      `network name ${JSON.stringify(name)} must match ${NETWORK_NAME_RE.source}`,
    );
  }
  const networkId = `${URN_PREFIX}${principal}:${name}`;
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

/**
 * Resolve the discovery key used to look up a network's descriptor under
 * a principal's public account-space.
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
