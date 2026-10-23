/**
 * Short-link transport for sealed-inline shares (TC-1737), published as the
 * `@tinycloud/share-envelope/short-link` subpath so it stays out of the root
 * entry (and the browser SDK bundles that import it):
 *
 *   ${origin}/s/${id}#v=3&k=${base64url(key32)}&c=${cid}
 *
 * The short-link service stores ONLY the sealed envelope bytes under `id`.
 * The key `k` and the CID `c` of the sealed bytes stay in the fragment, so
 * the service never holds anything that decrypts the envelope, and the link
 * itself pins the bytes the service returns.
 */
import { fromBase64Url, toBase64Url } from "./bytes.js";
import { computeCid } from "./cid.js";
import { assertCanonicalCid, KEY_LENGTH, MAX_INLINE_BYTES, parseSealedInlineShareUrl, type ParseShareUrlOptions } from "./link.js";
import { isCanonicalHttpsOrigin } from "./schema.js";

export const SHORT_LINK_ID_PATTERN = /^[a-z2-7]{26}$/;

export interface ParsedShortShareUrl {
  readonly kind: "short";
  readonly origin: string;
  readonly id: string;
  /** Canonical base64url of the 32-byte key, exactly as it appears in the fragment. */
  readonly k: string;
  readonly key32: Uint8Array;
  readonly ciphertextCid: string;
}

/** The inline payload a short link resolves to: the same object `/s/inline#v=2&p=` carries. */
export interface InlineSharePayload {
  readonly v: 2;
  readonly c: string;
  readonly cid: string;
  readonly k: string;
}

function assertShortLinkId(id: string): void {
  if (!SHORT_LINK_ID_PATTERN.test(id)) throw new TypeError("short link id must be 26 lowercase base32 characters");
}

/**
 * Parse only the canonical short-link form; anything else is refused, never normalized. The one exception is the
 * id's letter case: ids are case-insensitive base32 (a mail client or a reader may upper-case them), so `id` is
 * returned lowercased.
 */
export function parseShortShareUrl(url: string, options: ParseShareUrlOptions = {}): ParsedShortShareUrl {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new TypeError("short share URL is not a URL"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new TypeError("short share URL must be canonical HTTPS without userinfo");
  if (!isCanonicalHttpsOrigin(parsed.origin) || (options.expectedOrigin !== undefined && parsed.origin !== options.expectedOrigin)) throw new TypeError("short share URL origin is not trusted");
  if (parsed.search !== "") throw new TypeError("short share URL must not have a query string");
  const match = /^\/s\/([A-Za-z2-7]{26})$/.exec(parsed.pathname);
  if (match === null) throw new TypeError("not a short share URL path");
  const id = match[1]!.toLowerCase();
  const fragment = /^#v=3&k=([A-Za-z0-9_-]{43})&c=([a-z2-7]+)$/.exec(parsed.hash);
  if (fragment === null) throw new TypeError("short share URL fragment is not canonical");
  const k = fragment[1]!;
  const ciphertextCid = fragment[2]!;
  if (url !== `${parsed.origin}${parsed.pathname}${parsed.hash}`) throw new TypeError("short share URL is not lexically canonical");
  let key32: Uint8Array;
  try { key32 = fromBase64Url(k); } catch { throw new TypeError("short share URL key is not canonical base64url"); }
  if (key32.byteLength !== KEY_LENGTH) throw new TypeError("short share URL key must be 32 bytes");
  try { assertCanonicalCid(ciphertextCid); } catch { throw new TypeError("short share URL CID is not canonical"); }
  return { kind: "short", origin: parsed.origin, id, k, key32, ciphertextCid };
}

/**
 * The short link for a sealed-inline link whose sealed bytes the short-link
 * service stored under `id`. Same origin, same key, same CID; the sealed bytes
 * leave the URL.
 */
export async function splitInlineToShort(inlineUrl: string, id: string): Promise<string> {
  assertShortLinkId(id);
  const inline = await parseSealedInlineShareUrl(inlineUrl);
  const origin = new URL(inlineUrl).origin;
  return `${origin}/s/${id}#v=3&k=${toBase64Url(inline.key32)}&c=${inline.ciphertextCid}`;
}

/**
 * Rebuild the inline payload from a short link and the sealed bytes the
 * service returned for its id. The bytes must hash to the link's own CID: the
 * service is trusted for availability only, never for integrity.
 */
export async function rebuildInlineFromShort(shortUrl: string, ciphertextB64Url: string): Promise<InlineSharePayload> {
  const short = parseShortShareUrl(shortUrl);
  let ciphertext: Uint8Array;
  try { ciphertext = fromBase64Url(ciphertextB64Url); } catch { throw new TypeError("short link ciphertext is not canonical base64url"); }
  if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_INLINE_BYTES) throw new TypeError("short link ciphertext is outside the allowed size");
  if (await computeCid(ciphertext) !== short.ciphertextCid) throw new TypeError("short link ciphertext does not match the link's CID");
  return { v: 2, c: ciphertextB64Url, cid: short.ciphertextCid, k: short.k };
}
