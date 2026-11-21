const TEE_NODE_ORIGIN = "https://tee.node.tinycloud.xyz";
const PRODUCTION_NODE_ORIGINS = new Set([
  "https://node.tinycloud.xyz",
  TEE_NODE_ORIGIN,
]);

/** Exact equality plus the two production node names; callers retain their own normalization. */
export function sameTinyCloudNode(left: string, right: string): boolean {
  return left === right || (PRODUCTION_NODE_ORIGINS.has(left) && PRODUCTION_NODE_ORIGINS.has(right));
}

/** The origin of `value` when it is https (or loopback http) with no credentials, path, query or fragment. */
function nodeOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
  return url.origin;
}

/**
 * True when `origin` is an exact origin of a known TinyCloud node: one of the
 * production nodes or one of the recipient-configured `trusted` origins.
 * Lookalikes, credentials, paths and non-https schemes (loopback http aside,
 * and only when the recipient configured it) are never known.
 */
export function isKnownTinyCloudNode(origin: string, trusted: readonly (string | null | undefined)[] = []): boolean {
  const exact = nodeOrigin(origin);
  if (exact === undefined) return false;
  return PRODUCTION_NODE_ORIGINS.has(exact) || trusted.some((entry) => typeof entry === "string" && nodeOrigin(entry) === exact);
}

/**
 * Origin for an end-to-end-encrypted operation: either exact production name
 * maps to the origin whose TLS terminates inside the node's TEE. Every other
 * host, including lookalikes, is returned unchanged. Callers never fall back
 * from the result to the other production name.
 */
export function endToEndNodeHost(host: string): string {
  return PRODUCTION_NODE_ORIGINS.has(host) ? TEE_NODE_ORIGIN : host;
}
