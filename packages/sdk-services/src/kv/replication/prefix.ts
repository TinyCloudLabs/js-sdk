/** Shared prefix boundary and configuration rules; no runtime dependencies. */
export function kvPrefixCovers(prefix: string, key: string): boolean {
  return prefix === "/" || key.startsWith(prefix);
}

/** Replication scopes are `/` or non-empty, slash-terminated folder paths. */
export function assertFolderPrefix(prefix: unknown): asserts prefix is string {
  const validFolder = typeof prefix === "string" &&
    prefix.length > 0 &&
    !prefix.startsWith("/") &&
    !prefix.includes("//") &&
    prefix.endsWith("/");
  if (prefix !== "/" && !validFolder) {
    const folderHint = typeof prefix === "string"
      ? prefix.replace(/^\/+/, "").replace(/\/+$/, "")
      : "";
    const suggestion = folderHint.length > 0 && !folderHint.includes("//")
      ? ` Use ${JSON.stringify(`${folderHint}/`)}.`
      : ' Use "/" or a slash-terminated folder path such as "notes/".';
    throw new TypeError(`Replication prefix must be "/" or a non-empty slash-terminated folder path without empty segments.${suggestion}`);
  }
}
