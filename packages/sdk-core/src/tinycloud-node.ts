const PRODUCTION_NODE_ORIGINS = new Set([
  "https://node.tinycloud.xyz",
  "https://tee.node.tinycloud.xyz",
]);

/** Exact equality plus the two production node names; callers retain their own normalization. */
export function sameTinyCloudNode(left: string, right: string): boolean {
  return left === right || (PRODUCTION_NODE_ORIGINS.has(left) && PRODUCTION_NODE_ORIGINS.has(right));
}
