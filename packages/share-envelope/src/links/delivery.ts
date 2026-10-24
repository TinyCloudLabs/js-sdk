import { verifyEd25519Strict } from "./ed25519-strict.js";
import { buildShortLink, parseLink } from "./grammar.js";
import { decodeStrictBase64Url, linkIssuerPublicKey } from "./header.js";

const KEY_PARAMETER = /[#&]k=([A-Za-z0-9_-]{43})(?:&|$)/;

/** The share origins a delivery link is on by default: the production share origin. */
export const DEFAULT_SHARE_ORIGINS: readonly string[] = ["https://share.tinycloud.xyz"];

/**
 * The body CID (`c`) of a short share link, or `undefined` for any other string: the full form, another link type,
 * another fragment version, a query, a non-canonical spelling, an id that is not lowercase, or a link on an origin
 * that is not one of `trustedOrigins`.
 */
export function shortShareLinkCid(href: string, options: { readonly trustedOrigins: readonly string[] }): string | undefined {
  try {
    const parsed = parseLink(href, { trustedOrigins: options.trustedOrigins });
    if (parsed.form !== "short" || parsed.pathType !== "share") return undefined;
    return href === buildShortLink({ origin: parsed.origin, type: "share", id: parsed.id, key: parsed.key, bodyCid: parsed.c }) ? parsed.c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Throws unless `signature` is, in its one canonical base64url spelling, an Ed25519 signature of `message` by the
 * `did:key` signer under the strict rule of the links contract (`S < L`, canonical and prime-order `A` and `R`).
 */
export function assertDidKeySignature(signerDid: string, message: Uint8Array, signature: string): void {
  const bytes = decodeStrictBase64Url(signature);
  if (bytes === null) throw new Error("share delivery value is not canonical base64url");
  const key = linkIssuerPublicKey(signerDid);
  if (key === null || !verifyEd25519Strict(key, message, bytes)) throw new Error("v3 share delivery admission signature is invalid");
}

/** `text` with every occurrence of `href`, and of the key in its `k=` parameter, replaced. */
export function redactLink(text: string, href: string): string {
  const key = KEY_PARAMETER.exec(href)?.[1];
  const withoutLink = text.split(href).join("[share link]");
  return key === undefined ? withoutLink : withoutLink.split(key).join("[key]");
}
