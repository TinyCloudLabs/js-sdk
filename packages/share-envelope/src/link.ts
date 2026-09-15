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

/**
 * Node Policy/v3 delivery transport. The complete sealed envelope and its
 * key stay in the fragment, so neither reaches HTTP request logs.
 */
export interface SealedInlineShareUrlParts {
  readonly origin: string;
  /** The complete `version || nonce || ciphertext+tag` sealed envelope. */
  readonly ciphertext: Uint8Array;
  /** The 32-byte AES-256-GCM key that opens `ciphertext`. */
  readonly key32: Uint8Array;
}

export interface ParsedSealedInlineShareUrl {
  readonly kind: "inline";
  readonly ciphertextCid: string;
  readonly ciphertext: Uint8Array;
  readonly key32: Uint8Array;
}

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

/**
 * Encode the Node Policy/v3 sealed-inline delivery URL exactly. This is used
 * when no registry/blob resolver is present: the recipient gets the sealed
 * authorization envelope and its fragment-only key directly in the invite.
 */
export async function encodeSealedInlineShareUrl(parts: SealedInlineShareUrlParts): Promise<string> {
  if (!isCanonicalHttpsOrigin(parts.origin)) throw new TypeError("origin must be a canonical https origin");
  if (parts.ciphertext.byteLength === 0 || parts.ciphertext.byteLength > MAX_INLINE_BYTES) throw new RangeError("inline ciphertext is outside the allowed size");
  if (parts.key32.byteLength !== KEY_LENGTH) throw new TypeError("inline key must be 32 bytes");
  const ciphertextCid = await computeCid(parts.ciphertext);
  const payload = canonicalize({
    v: 2,
    c: toBase64Url(parts.ciphertext),
    cid: ciphertextCid,
    k: toBase64Url(parts.key32),
  });
  const payloadBytes = new TextEncoder().encode(payload);
  if (payloadBytes.byteLength > MAX_INLINE_BYTES * 2) throw new RangeError("inline URL is too large");
  return `${parts.origin}/s/inline#v=2&p=${toBase64Url(payloadBytes)}`;
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

/** Parse only Node's sealed-inline `/s/inline#v=2&p=…` form. */
export async function parseSealedInlineShareUrl(
  url: string,
  options: ParseShareUrlOptions = {},
): Promise<ParsedSealedInlineShareUrl> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new TypeError("sealed inline share URL must be canonical HTTPS without userinfo");
  if (!isCanonicalHttpsOrigin(parsed.origin) || (options.expectedOrigin !== undefined && parsed.origin !== options.expectedOrigin)) throw new TypeError("sealed inline share URL origin is not trusted");
  if (parsed.pathname !== "/s/inline" || parsed.search !== "") throw new TypeError("not a Node sealed-inline share URL");
  if (url !== `${parsed.origin}/s/inline${parsed.hash}`) throw new TypeError("sealed inline share URL is not lexically canonical");
  const prefix = "#v=2&p=";
  if (!parsed.hash.startsWith(prefix)) throw new TypeError("sealed inline URL is missing its canonical fragment");
  const encoded = parsed.hash.slice(prefix.length);
  if (encoded.length === 0 || parsed.hash !== `${prefix}${encoded}`) throw new TypeError("sealed inline URL fragment is not canonical");
  let payloadBytes: Uint8Array;
  try { payloadBytes = fromBase64Url(encoded); } catch { throw new TypeError("sealed inline payload is not canonical base64url"); }
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_INLINE_BYTES * 2) throw new TypeError("sealed inline payload is too large");
  const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  let value: unknown;
  try { value = JSON.parse(payloadText) as unknown; } catch { throw new TypeError("sealed inline payload is not valid JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value) || canonicalize(value) !== payloadText) throw new TypeError("sealed inline payload is not canonical JSON");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || record.v !== 2 || typeof record.c !== "string" || typeof record.cid !== "string" || typeof record.k !== "string") throw new TypeError("sealed inline payload has invalid fields");
  let ciphertext: Uint8Array;
  let key32: Uint8Array;
  try {
    ciphertext = fromBase64Url(record.c);
    key32 = fromBase64Url(record.k);
  } catch {
    throw new TypeError("sealed inline payload has invalid base64url material");
  }
  if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_INLINE_BYTES) throw new TypeError("sealed inline ciphertext is outside the allowed size");
  if (key32.byteLength !== KEY_LENGTH) throw new TypeError("sealed inline key must be 32 bytes");
  assertCanonicalCid(record.cid);
  if (await computeCid(ciphertext) !== record.cid) throw new TypeError("sealed inline ciphertext does not match its CID");
  return { kind: "inline", ciphertextCid: record.cid, ciphertext, key32 };
}
