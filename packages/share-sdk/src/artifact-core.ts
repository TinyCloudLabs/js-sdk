/**
 * The few artifact helpers the browser bundles need (the pin verifier reads a version path). Kept
 * apart from `artifact.ts`, which is CLI and agent tooling and must stay out of those bundles.
 */
export const ARTIFACT_ROOT = "artifacts";

/** The artifact and version a stored KV path belongs to, if it is under a version directory. */
export function parseArtifactVersionPath(path: string): { readonly artifactId: string; readonly version: number; readonly file: string } | undefined {
  const match = /^artifacts\/([a-z0-9][a-z0-9_-]{2,62})\/versions\/([1-9][0-9]{0,14})\/([^/]+)$/.exec(path);
  if (match === null) return undefined;
  return { artifactId: match[1]!, version: Number(match[2]), file: match[3]! };
}
