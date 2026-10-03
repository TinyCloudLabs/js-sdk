/**
 * The SIWE with `caveat` as the note-bene of every ReCap action, or only of
 * actions on resources whose URI ends with `resourceSuffix`, for signing in
 * tests (prepareSession emits only unrestricted `[{}]` caveats).
 */
export function withRecapCaveat(siwe: string, caveat: Record<string, unknown>, resourceSuffix?: string): string {
  const encoded = siwe.match(/urn:recap:([A-Za-z0-9_-]+)/)?.[1];
  if (encoded === undefined) throw new Error("SIWE has no ReCap resource");
  const recap = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown[]>> };
  const resources = Object.keys(recap.att).filter((resource) => resourceSuffix === undefined || resource.endsWith(resourceSuffix));
  if (resources.length === 0) throw new Error(`SIWE has no ReCap resource ending with ${resourceSuffix}`);
  for (const resource of resources) {
    const abilities = recap.att[resource]!;
    for (const action of Object.keys(abilities)) abilities[action] = [caveat];
  }
  return siwe.replace(encoded, Buffer.from(JSON.stringify(recap)).toString("base64url"));
}
