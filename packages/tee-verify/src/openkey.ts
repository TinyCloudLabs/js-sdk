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

/**
 * OpenKey's attested identity (openkey docs/tee-overview.md, TC-3842):
 * `<issuer>#<thumbprints>`, the deduplicated, sorted thumbprints of every key
 * in the issuer's JWKS, joined with ",".
 */
export function openkeyIdentity(issuer: string, jwks: unknown): string {
  const keys = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) refuse("identity", "OpenKey JWKS has no keys");
  const thumbprints = [...new Set(keys.map((k) => jwkThumbprint(k as Record<string, unknown>)))].sort();
  return `${issuer}#${thumbprints.join(",")}`;
}
