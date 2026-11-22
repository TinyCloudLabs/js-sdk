import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";
import { refuse } from "./errors.js";

/** RFC 7638 required members per key type, in lexicographic order. */
const REQUIRED: Record<string, readonly string[]> = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  RSA: ["e", "kty", "n"],
  oct: ["k", "kty"],
};

/** RFC 7638 SHA-256 JWK thumbprint, base64url without padding (as jose `calculateJwkThumbprint(jwk, "sha256")`). */
export function jwkThumbprint(jwk: Record<string, unknown>): string {
  const members = typeof jwk.kty === "string" ? REQUIRED[jwk.kty] : undefined;
  if (!members) refuse("identity", `JWKS key type ${JSON.stringify(jwk.kty)} is not supported`);
  const canonical: Record<string, string> = {};
  for (const name of members) {
    const value = jwk[name];
    if (typeof value !== "string" || value === "") refuse("identity", `JWKS ${String(jwk.kty)} key has no ${name}`);
    canonical[name] = value;
  }
  let binary = "";
  for (const byte of sha256(utf8ToBytes(JSON.stringify(canonical)))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function servedThumbprints(jwks: unknown): Set<string> {
  const keys = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) refuse("identity", "OpenKey JWKS has no keys");
  return new Set(keys.map((k) => jwkThumbprint(k as Record<string, unknown>)));
}

/**
 * Checks an attested OpenKey `identity` against the keys `<issuer>/jwks` serves.
 * OpenKey quotes only the keys whose private half it proves it holds (openkey#706),
 * so the identity may list a subset: non-empty, sorted, without duplicates, each
 * one served. Returns the served keys it leaves out: unproven, so tokens they
 * sign are not covered by the quote. The response's `excluded_keys` count is
 * outside the key binding, so it is not used.
 */
export function checkOpenkeyIdentity(identity: string, issuer: string, jwks: unknown): { unprovenKeys: string[] } {
  const served = servedThumbprints(jwks);
  const prefix = `${issuer}#`;
  if (!identity.startsWith(prefix)) refuse("identity", `OpenKey identity is not for issuer ${issuer}`);
  const listed = identity.slice(prefix.length).split(",");
  if (listed.some((t) => !served.has(t))) refuse("identity", "OpenKey identity lists a key its JWKS does not serve");
  if (listed.join(",") !== [...new Set(listed)].sort().join(",")) refuse("identity", "OpenKey identity is not sorted and deduplicated");
  return { unprovenKeys: [...served].filter((t) => !listed.includes(t)).sort() };
}
