/** Exact-key or trailing-slash-prefix coverage, matching sdk-core containment. */
export function kvPrefixCovers(prefix: string, key: string): boolean {
  if (prefix === "" || prefix === "/") return true;
  if (prefix.endsWith("/")) return key.startsWith(prefix);
  return key === prefix;
}

/** Whether replicating this space/prefix can copy encrypted secret material to disk. */
export function requiresSecretsOptIn(space: string, prefix: string): boolean {
  if (space === "secrets" || space.endsWith(":secrets")) return true;
  return prefix.split("/", 1)[0] === "vault";
}
