/** Published replica selector semantics: exact key plus descendants by segment. */
export function kvPrefixCovers(prefix: string, key: string): boolean {
  if (prefix === "") return true;
  if (prefix.endsWith("/")) return key.startsWith(prefix);
  return key === prefix || key.startsWith(`${prefix}/`);
}

/** LIST returns its exact path plus descendants below its slash-terminated path. */
export function listRangeCovers(path: string, key: string): boolean {
  return key === path || key.startsWith(path.endsWith("/") ? path : `${path}/`);
}

/** Whether replicating this space/prefix can copy encrypted secret material to disk. */
export function requiresSecretsOptIn(space: string, prefix: string): boolean {
  if (space === "secrets" || space.endsWith(":secrets")) return true;
  return prefix.split("/", 1)[0] === "vault";
}
