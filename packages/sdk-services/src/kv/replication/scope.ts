/** Folder containment: `/` contains the whole space; other prefixes are folders. */
export function kvPrefixCovers(prefix: string, key: string): boolean {
  return prefix === "/" || key.startsWith(prefix);
}

/** LIST returns its exact path plus descendants below its slash-terminated path. */
export function listRangeCovers(path: string, key: string): boolean {
  return path === "" || key === path || key.startsWith(path.endsWith("/") ? path : `${path}/`);
}

/** Whether replicating this space/prefix can copy encrypted secret material to disk. */
export function requiresSecretsOptIn(space: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (space === "secrets" || space.endsWith(":secrets")) return true;
  return prefix.split("/", 1)[0] === "vault";
}
