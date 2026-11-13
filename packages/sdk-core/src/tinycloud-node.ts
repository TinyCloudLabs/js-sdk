const PRODUCTION_NODE_ORIGINS = new Set([
  "https://node.tinycloud.xyz",
  "https://tee.node.tinycloud.xyz",
]);

/** Match the two production node names; retain normalized exact matching elsewhere. */
export function sameTinyCloudNode(left: string, right: string): boolean {
  try {
    const normalize = (value: string): string => {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "") return "";
      url.hash = "";
      url.search = "";
      url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString().replace(/\/+$/, "");
    };
    const a = normalize(left);
    const b = normalize(right);
    return a !== "" && (a === b || (PRODUCTION_NODE_ORIGINS.has(a) && PRODUCTION_NODE_ORIGINS.has(b)));
  } catch {
    return false;
  }
}
