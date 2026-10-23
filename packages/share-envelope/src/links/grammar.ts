import { toBase64Url, utf8Bytes } from "../bytes.js";
import { isCanonicalRawCid } from "../cid.js";
import { canonicalize } from "../jcs.js";
import { FULL_LINK_PATH, LINK_ID_PATTERN, MAX_LINK_BODY_BYTES, MAX_LINK_REQUEST_BYTES, LINK_TYPE_SPECS, type LinkType } from "./constants.js";
import { LinkError } from "./errors.js";
import { decodeStrictBase64Url, linkTypeForPathLetter, type LinkRecord } from "./header.js";

export const LINK_FRAGMENT_VERSION = 4;

const SHORT_PATH = /^\/(s|c|l)\/([A-Za-z2-7]{26})$/;
const SHORT_FRAGMENT = /^#v=4&k=([A-Za-z0-9_-]{43})&c=(bafkrei[a-z2-7]{52})$/;
const FULL_FRAGMENT = /^#v=4&k=([A-Za-z0-9_-]{43})&r=([A-Za-z0-9_-]+)$/;
const REMOVED_FRAGMENT = /^#v=[23](&|$)/;
/** The create request's size cap: a full link carries the same record. */
const MAX_FULL_RECORD_JSON_BYTES = MAX_LINK_REQUEST_BYTES;

/**
 * The lowercase form of a link id, or `null` when it is not 26 base32
 * characters. Uppercase is accepted on input (a mail client may uppercase a
 * link) and lowercased; nothing else is.
 */
export function normalizeLinkId(id: string): string | null {
  return /^[A-Za-z2-7]{26}$/.test(id) ? id.toLowerCase() : null;
}

export interface ParsedShortLink {
  readonly form: "short";
  readonly origin: string;
  readonly pathType: LinkType;
  /** Lowercase id. */
  readonly id: string;
  /** The content key as written in the fragment (canonical base64url). */
  readonly k: string;
  readonly key: Uint8Array;
  /** The body CID as written in the fragment. */
  readonly c: string;
}

export interface ParsedFullLink {
  readonly form: "full";
  readonly origin: string;
  readonly k: string;
  readonly key: Uint8Array;
  /** The record the fragment carries; its shape is checked when the record is opened. */
  readonly record: unknown;
}

export type ParsedLink = ParsedShortLink | ParsedFullLink;

function canonicalHttpsOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.origin === origin;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== 32) throw new LinkError("invalid_argument", "a link key is 32 bytes");
}

/**
 * Parse a `#v=4` link under the strict grammar. The link must be the exact
 * `origin + pathname + search + hash` of its parsed URL, on a trusted origin,
 * with no query, in one of the two forms. Throws a `LinkError` whose code is
 * the contract's reason, including `removed_version` for `#v=2` and `#v=3`.
 */
export function parseLink(href: string, options: { readonly trustedOrigins: readonly string[] }): ParsedLink {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new LinkError("not_a_url");
  }
  if (url.protocol !== "https:") throw new LinkError("not_https");
  if (url.username !== "" || url.password !== "") throw new LinkError("userinfo");
  if (!options.trustedOrigins.includes(url.origin)) throw new LinkError("origin_not_trusted");
  if (href !== `${url.origin}${url.pathname}${url.search}${url.hash}`) throw new LinkError("not_canonical");
  if (url.search !== "") throw new LinkError("query_present");
  if (REMOVED_FRAGMENT.test(url.hash)) throw new LinkError("removed_version");
  const short = SHORT_PATH.exec(url.pathname);
  if (short === null && url.pathname !== FULL_LINK_PATH) throw new LinkError("path_grammar");
  if (short !== null) {
    const fragment = SHORT_FRAGMENT.exec(url.hash);
    if (fragment === null) throw new LinkError("fragment_grammar");
    const [, k = "", c = ""] = fragment;
    const key = decodeStrictBase64Url(k);
    if (key === null || key.length !== 32) throw new LinkError("key_noncanonical");
    if (!isCanonicalRawCid(c)) throw new LinkError("cid_grammar");
    const pathType = linkTypeForPathLetter(short[1] ?? "");
    if (pathType === undefined) throw new LinkError("path_grammar");
    return { form: "short", origin: url.origin, pathType, id: (short[2] ?? "").toLowerCase(), k, key, c };
  }
  const fragment = FULL_FRAGMENT.exec(url.hash);
  if (fragment === null) throw new LinkError("fragment_grammar");
  const [, k = "", r = ""] = fragment;
  const key = decodeStrictBase64Url(k);
  if (key === null || key.length !== 32) throw new LinkError("key_noncanonical");
  const raw = decodeStrictBase64Url(r);
  if (raw === null) throw new LinkError("record_encoding");
  if (raw.length > MAX_FULL_RECORD_JSON_BYTES) throw new LinkError("record_json");
  let text: string;
  let record: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    record = JSON.parse(text);
  } catch {
    throw new LinkError("record_json");
  }
  let canonical: string;
  try {
    canonical = canonicalize(record);
  } catch {
    throw new LinkError("record_not_canonical");
  }
  if (canonical !== text) throw new LinkError("record_not_canonical");
  return { form: "full", origin: url.origin, k, key, record };
}

/** Build a short link: `<origin>/<letter>/<id>#v=4&k=<k>&c=<c>`. The id must be lowercase. */
export function buildShortLink(input: { readonly origin: string; readonly type: LinkType; readonly id: string; readonly key: Uint8Array; readonly bodyCid: string }): string {
  if (!canonicalHttpsOrigin(input.origin)) throw new LinkError("invalid_argument", "the link origin is not a canonical https origin");
  if (!LINK_ID_PATTERN.test(input.id)) throw new LinkError("id_grammar");
  if (!isCanonicalRawCid(input.bodyCid)) throw new LinkError("body_cid_format");
  assertKey(input.key);
  return `${input.origin}/${LINK_TYPE_SPECS[input.type].pathLetter}/${input.id}#v=${LINK_FRAGMENT_VERSION}&k=${toBase64Url(input.key)}&c=${input.bodyCid}`;
}

/**
 * Build a full link: `<origin>/s/full#v=4&k=<k>&r=<r>`, where `r` is the
 * base64url of `JCS({body, header, signature})`. Only a `share` record has a
 * full form. The result is parsed back under the strict grammar before it is
 * returned.
 */
export function buildFullLink(input: { readonly origin: string; readonly key: Uint8Array; readonly record: LinkRecord }): string {
  if (!canonicalHttpsOrigin(input.origin)) throw new LinkError("invalid_argument", "the link origin is not a canonical https origin");
  assertKey(input.key);
  if (input.record.header.type !== "share") throw new LinkError("full_non_share");
  // A full link carries the body, so a body over the limit has no full link either.
  const body = decodeStrictBase64Url(input.record.body);
  if (body === null) throw new LinkError("body_encoding");
  if (body.length > MAX_LINK_BODY_BYTES) throw new LinkError("body_over_cap");
  const json = canonicalize(input.record);
  const link = `${input.origin}${FULL_LINK_PATH}#v=${LINK_FRAGMENT_VERSION}&k=${toBase64Url(input.key)}&r=${toBase64Url(utf8Bytes(json))}`;
  parseLink(link, { trustedOrigins: [input.origin] });
  return link;
}
