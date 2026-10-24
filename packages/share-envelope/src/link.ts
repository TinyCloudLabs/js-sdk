import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";

import { fromBase64Url, toBase64Url } from "./bytes.js";
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

export const KEY_LENGTH = 32;

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

export function assertCanonicalCid(cidString: string): void {
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
