import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";

import { fromBase64Url, toBase64Url } from "./bytes.js";
import { computeCid } from "./cid.js";
import { canonicalize } from "./jcs.js";
import { isCanonicalHttpsOrigin } from "./schema.js";

/**
 * Share link codec (blueprint §2.1):
 *
 *   ${origin}/s/${cid}#k=${base64url(key32)}
 *
 * The CID addresses the SEALED BLOB (`seal` in aead.ts: version byte ||
 * nonce || ciphertext+tag), so the link plus the fetched blob is everything a
 * recipient needs — the nonce rides inside the CID-verified blob.
 *
 * The AEAD key rides in the URL FRAGMENT only. Fragments are never sent in
 * HTTP requests, so the registry, CDNs, and any server that sees the URL
 * without its fragment learn nothing that decrypts the envelope. The fragment
 * must never leave the client (no logging, no postMessage to other origins).
 */

const KEY_LENGTH = 32;

export interface ShareUrlParts {
  origin: string;
  /** CIDv1/raw/sha2-256 of the sealed blob. */
  ciphertextCid: string;
  key32: Uint8Array;
}

export interface ParseShareUrlOptions {
  /** If given, the URL's origin must equal this canonical https origin exactly. */
  expectedOrigin?: string;
}

export interface InlineShareUrlParts {
  readonly origin: string;
  /** The complete sealed envelope blob. It is kept in the fragment only. */
  readonly ciphertext: Uint8Array;
  /** The AES key that opens the sealed envelope. Omit only for policy-safe public envelopes. */
  readonly key32?: Uint8Array;
}

export interface ParsedInlineShareUrl {
  readonly kind: "inline";
  readonly ciphertextCid: string;
  readonly ciphertext: Uint8Array;
  readonly key32?: Uint8Array;
}

const INLINE_PREFIX = "#v=2&p=";
const MAX_INLINE_BYTES = 256 * 1024;

function assertCanonicalCid(cidString: string): void {
  const cid = CID.parse(cidString); // throws on garbage
  if (
    cid.version !== 1 ||
    cid.code !== raw.code ||
    cid.multihash.code !== 0x12 || // sha2-256 (0x12) only, at the link layer too
    cid.toString() !== cidString
  ) {
    throw new TypeError(`not a canonical CIDv1 raw sha2-256 base32 CID: ${cidString}`);
  }
}

export function encodeShareUrl({ origin, ciphertextCid, key32 }: ShareUrlParts): string {
  if (key32.length !== KEY_LENGTH) {
    throw new TypeError(`key must be ${KEY_LENGTH} bytes, got ${key32.length}`);
  }
  assertCanonicalCid(ciphertextCid);
  if (!isCanonicalHttpsOrigin(origin)) {
    throw new TypeError(`origin must be a canonical https origin, got ${origin}`);
  }
  return `${origin}/s/${ciphertextCid}#k=${toBase64Url(key32)}`;
}

export function parseShareUrl(
  url: string,
  options: ParseShareUrlOptions = {},
): { ciphertextCid: string; key32: Uint8Array } {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new TypeError(`share URL must be https, got ${parsed.protocol}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("share URL must not carry userinfo");
  }
  // The key must never appear anywhere a server would see it — reject ANY
  // query string rather than guessing at intent.
  if (parsed.search !== "") {
    throw new TypeError("share URL must not have a query string");
  }
  if (options.expectedOrigin !== undefined) {
    if (!isCanonicalHttpsOrigin(options.expectedOrigin)) {
      throw new TypeError(
        `expectedOrigin must be a canonical https origin, got ${options.expectedOrigin}`,
      );
    }
    if (parsed.origin !== options.expectedOrigin) {
      throw new TypeError(
        `share URL origin ${parsed.origin} does not match expected ${options.expectedOrigin}`,
      );
    }
  }
  const match = /^\/s\/([a-z2-7]+)$/.exec(parsed.pathname);
  if (!match || match[1] === undefined) {
    throw new TypeError(`not a share URL path: ${parsed.pathname}`);
  }
  const ciphertextCid = match[1];
  assertCanonicalCid(ciphertextCid);
  if (!parsed.hash.startsWith("#k=")) {
    throw new TypeError("share URL is missing the #k= key fragment");
  }
  // fromBase64Url is a STRICT decode: it throws on padding, characters
  // outside the base64url alphabet, impossible lengths, and non-zero
  // trailing bits — not just an alphabet regex.
  const key32 = fromBase64Url(parsed.hash.slice("#k=".length));
  if (key32.length !== KEY_LENGTH) {
    throw new TypeError(`fragment key must be ${KEY_LENGTH} bytes, got ${key32.length}`);
  }
  return { ciphertextCid, key32 };
}

/**
 * Encode an explicit v2 inline fallback. The entire payload is in the
 * fragment, so it is never sent in an HTTP request. The payload is canonical
 * JSON and contains only sealed bytes, their CID, and (when encrypted) the
 * envelope key; callers must never place recipient or holder material here.
 */
export async function encodeInlineShareUrl(parts: InlineShareUrlParts): Promise<string> {
  if (!isCanonicalHttpsOrigin(parts.origin)) throw new TypeError("origin must be a canonical https origin");
  if (parts.ciphertext.byteLength === 0 || parts.ciphertext.byteLength > MAX_INLINE_BYTES) throw new RangeError("inline ciphertext is outside the allowed size");
  if (parts.key32 !== undefined && parts.key32.length !== KEY_LENGTH) throw new TypeError("inline key must be 32 bytes");
  const ciphertextCid = await computeCid(parts.ciphertext);
  const payload = canonicalize({
    v: 2,
    c: toBase64Url(parts.ciphertext),
    cid: ciphertextCid,
    ...(parts.key32 === undefined ? {} : { k: toBase64Url(parts.key32) }),
  });
  const payloadBytes = new TextEncoder().encode(payload);
  if (payloadBytes.byteLength > MAX_INLINE_BYTES * 2) throw new RangeError("inline URL is too large");
  return `${parts.origin}/s/inline${INLINE_PREFIX}${toBase64Url(payloadBytes)}`;
}

export function parseInlineShareUrl(url: string, options: ParseShareUrlOptions = {}): ParsedInlineShareUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "") throw new TypeError("inline share URL must be canonical HTTPS without query or userinfo");
  if (!isCanonicalHttpsOrigin(parsed.origin) || (options.expectedOrigin !== undefined && parsed.origin !== options.expectedOrigin)) throw new TypeError("inline share URL origin is not trusted");
  if (parsed.pathname !== "/s/inline" || !parsed.hash.startsWith(INLINE_PREFIX)) throw new TypeError("not an inline v2 share URL");
  let payloadBytes: Uint8Array;
  try { payloadBytes = fromBase64Url(parsed.hash.slice(INLINE_PREFIX.length)); } catch { throw new TypeError("inline payload is not canonical base64url"); }
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_INLINE_BYTES * 2) throw new TypeError("inline payload is too large");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)) as unknown; } catch { throw new TypeError("inline payload is not valid JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("inline payload must be an object");
  if (canonicalize(value) !== new TextDecoder("utf-8").decode(payloadBytes)) throw new TypeError("inline payload is not canonical JSON");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => key === "v" || key === "c" || key === "cid" || key === "k") || record.v !== 2 || typeof record.c !== "string" || typeof record.cid !== "string") throw new TypeError("inline payload has invalid fields");
  let ciphertext: Uint8Array;
  try { ciphertext = fromBase64Url(record.c); } catch { throw new TypeError("inline ciphertext is not canonical base64url"); }
  if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_INLINE_BYTES) throw new TypeError("inline ciphertext is outside the allowed size");
  assertCanonicalCid(record.cid);
  if (record.k !== undefined && typeof record.k !== "string") throw new TypeError("inline key must be base64url");
  let key32: Uint8Array | undefined;
  try { key32 = record.k === undefined ? undefined : fromBase64Url(record.k); } catch { throw new TypeError("inline key is not canonical base64url"); }
  if (key32 !== undefined && key32.length !== KEY_LENGTH) throw new TypeError("inline key must be 32 bytes");
  return { kind: "inline", ciphertextCid: record.cid, ciphertext, ...(key32 === undefined ? {} : { key32 }) };
}

export function parseCompactOrInlineShareUrl(url: string, options: ParseShareUrlOptions = {}):
  | { readonly kind: "compact"; readonly ciphertextCid: string; readonly key32: Uint8Array }
  | ParsedInlineShareUrl {
  if (new URL(url).pathname === "/s/inline") return parseInlineShareUrl(url, options);
  return { kind: "compact", ...parseShareUrl(url, options) };
}
