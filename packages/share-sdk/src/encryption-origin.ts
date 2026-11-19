// The production node's two names, as in `endToEndNodeHost` (@tinycloud/sdk-core),
// which share-sdk does not depend on (TC-2923).
const TEE_NODE_ORIGIN = "https://tee.node.tinycloud.xyz";
const PRODUCTION_NODE_ORIGINS = new Set(["https://node.tinycloud.xyz", TEE_NODE_ORIGIN]);

/**
 * Encryption-network traffic (descriptor, network admin, decrypt, and the
 * node identity those use) for the production node goes only to the origin
 * whose TLS terminates inside the node's TEE. Every other origin is unchanged.
 */
export function encryptionNodeOrigin(nodeOrigin: string): string {
  return PRODUCTION_NODE_ORIGINS.has(nodeOrigin) ? TEE_NODE_ORIGIN : nodeOrigin;
}
