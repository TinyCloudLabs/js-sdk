export { kvPrefixCovers } from "./prefix";

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
