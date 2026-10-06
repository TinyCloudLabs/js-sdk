/**
 * `did:key` verification method fragment → the principal DID.
 */
export function principalOf(did: string): string {
  return did.split("#", 1)[0]!;
}

const METHOD = /^[a-z0-9]+$/u;
// DID method-specific-id: idchars ([A-Za-z0-9._-]) or %XX escapes, with `:`
// separators allowed; the final segment must be non-empty.
const IDCHAR = /^[A-Za-z0-9._-]$/u;

/**
 * Whether `value` is a well-formed DID the replica accepts as a `principal`
 * partition label: `did:` + a lowercase method name + a non-empty
 * method-specific-id whose segments (separated by `:`) consist of idchars or
 * valid `%XX` percent-escapes, and whose last segment is not empty. Shape
 * only — `principal` is an app-asserted label, never a credential.
 */
export function isPrincipalDid(value: string): boolean {
  if (typeof value !== "string" || !value.startsWith("did:")) return false;
  const rest = value.slice(4);
  const methodEnd = rest.indexOf(":");
  if (methodEnd <= 0) return false;
  if (!METHOD.test(rest.slice(0, methodEnd))) return false;
  const msid = rest.slice(methodEnd + 1);
  if (msid.length === 0) return false;
  const segments = msid.split(":");
  const last = segments[segments.length - 1]!;
  if (last.length === 0) return false;
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i += 1) {
      const c = segment[i]!;
      if (c === "%") {
        // A percent-escape needs exactly two hex digits.
        if (i + 2 >= segment.length || !/^[0-9a-fA-F]{2}$/u.test(segment.slice(i + 1, i + 3))) return false;
        i += 2;
      } else if (!IDCHAR.test(c)) {
        return false;
      }
    }
  }
  return true;
}
