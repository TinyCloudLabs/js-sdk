/** The public members of each asymmetric JWK key type (RFC 7518 §6.2.1, §6.3.1; RFC 8037 §2). */
const PUBLIC_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  OKP: ["kty", "crv", "x"],
  EC: ["kty", "crv", "x", "y"],
  RSA: ["kty", "n", "e"],
};

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * The public key of `jwk`: only the standard public members of its key type, plus `kid` when it is a string, are
 * copied, so private members and anything else (`alg`, `use`, unknown fields) are dropped. Use it for every JWK that
 * leaves the device.
 *
 * Throws for a key type without a public form (`oct`, unknown) or a missing public member.
 */
export function publicJwk(jwk: unknown): Record<string, string> {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw new TypeError("A JWK must be an object");
  }
  const source: Partial<Record<string, unknown>> = jwk;
  const kty = hasOwn(source, "kty") ? source.kty : undefined;
  const members = typeof kty === "string" && hasOwn(PUBLIC_MEMBERS, kty) ? PUBLIC_MEMBERS[kty] : undefined;
  if (!members) {
    throw new TypeError(`JWK key type ${JSON.stringify(kty)} has no public form`);
  }
  const result: Record<string, string> = {};
  for (const member of members) {
    const value = hasOwn(source, member) ? source[member] : undefined;
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`JWK is missing its public "${member}" member`);
    }
    result[member] = value;
  }
  if (hasOwn(source, "kid") && typeof source.kid === "string") result.kid = source.kid;
  return result;
}
