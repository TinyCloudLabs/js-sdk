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
export function jwkThumbprint(jwk: unknown): string {
  if (!jwk || typeof jwk !== "object") refuse("identity", "JWKS entry is not a key object");
  const key = jwk as Record<string, unknown>;
  const members = typeof key.kty === "string" ? REQUIRED[key.kty] : undefined;
  if (!members) refuse("identity", `JWKS key type ${JSON.stringify(key.kty)} is not supported`);
  const canonical: Record<string, string> = {};
  for (const name of members) {
    const value = key[name];
    if (typeof value !== "string" || value === "") refuse("identity", `JWKS ${String(key.kty)} key has no ${name}`);
    canonical[name] = value;
  }
  let binary = "";
  for (const byte of sha256(utf8ToBytes(JSON.stringify(canonical)))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function servedThumbprints(jwks: unknown): Set<string> {
  const keys = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) refuse("identity", "OpenKey JWKS has no keys");
  return new Set(keys.map((k) => jwkThumbprint(k)));
}

/**
 * Checks an attested OpenKey `identity` against the keys `<issuer>/jwks` serves.
 * OpenKey quotes only the keys whose private half it proves it holds (openkey#706):
 * the identity must be non-empty, sorted, without duplicates, each key served.
 *
 * A served key the identity leaves out is unattested: relying parties that trust
 * `/jwks` accept tokens it signs, yet the quote does not cover it (e.g. a public
 * key written into OpenKey's key table without its private key). That refuses
 * (`unattested-keys`) unless `allowUnattestedKeys`, which is for diagnosing a
 * rotation only; then the keys are returned. A positive `excludedKeys` (the
 * response's `excluded_keys`, outside the key binding) also refuses: it can only
 * make the check stricter.
 */
export function checkOpenkeyIdentity(
  identity: string,
  issuer: string,
  jwks: unknown,
  options: { excludedKeys?: unknown; allowUnattestedKeys?: boolean } = {},
): { unattestedKeys: string[] } {
  const served = servedThumbprints(jwks);
  const prefix = `${issuer}#`;
  if (!identity.startsWith(prefix)) refuse("identity", `OpenKey identity is not for issuer ${issuer}`);
  const listed = identity.slice(prefix.length).split(",");
  if (listed.some((t) => !served.has(t))) refuse("identity", "OpenKey identity lists a key its JWKS does not serve");
  if (listed.join(",") !== [...new Set(listed)].sort().join(",")) refuse("identity", "OpenKey identity is not sorted and deduplicated");
  const unattestedKeys = [...served].filter((t) => !listed.includes(t)).sort();
  const excluded = typeof options.excludedKeys === "number" && options.excludedKeys > 0;
  if ((unattestedKeys.length > 0 || excluded) && !options.allowUnattestedKeys) {
    const which = unattestedKeys.length > 0 ? unattestedKeys.join(",") : `${String(options.excludedKeys)} per excluded_keys`;
    refuse("unattested-keys", `OpenKey serves keys its quote does not cover: ${which}; tokens they sign are not attested (--allow-unattested-keys only to diagnose a rotation)`);
  }
  return { unattestedKeys };
}
