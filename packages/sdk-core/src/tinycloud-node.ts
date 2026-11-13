const TEE_NODE_ORIGIN = "https://tee.node.tinycloud.xyz";
const PRODUCTION_NODE_ORIGINS = new Set([
  "https://node.tinycloud.xyz",
  TEE_NODE_ORIGIN,
]);

/** Exact equality plus the two production node names; callers retain their own normalization. */
export function sameTinyCloudNode(left: string, right: string): boolean {
  return left === right || (PRODUCTION_NODE_ORIGINS.has(left) && PRODUCTION_NODE_ORIGINS.has(right));
}

/**
 * Origin for an end-to-end-encrypted operation: either exact production name
 * maps to the origin whose TLS terminates inside the node's TEE, so no proxy
 * sees the request. Every other host, including lookalikes, is returned
 * unchanged. Callers never fall back from the result to the proxied name.
 */
export function endToEndNodeHost(host: string): string {
  return PRODUCTION_NODE_ORIGINS.has(host) ? TEE_NODE_ORIGIN : host;
}
