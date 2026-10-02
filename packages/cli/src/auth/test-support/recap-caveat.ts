/**
 * The SIWE with `caveat` as the note-bene of every ReCap action, for signing
 * in tests (prepareSession emits only unrestricted `[{}]` caveats).
 */
export function withRecapCaveat(siwe: string, caveat: Record<string, unknown>): string {
  const encoded = siwe.match(/urn:recap:([A-Za-z0-9_-]+)/)?.[1];
  if (encoded === undefined) throw new Error("SIWE has no ReCap resource");
  const recap = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown[]>> };
  for (const abilities of Object.values(recap.att)) {
    for (const action of Object.keys(abilities)) abilities[action] = [caveat];
  }
  return siwe.replace(encoded, Buffer.from(JSON.stringify(recap)).toString("base64url"));
}
