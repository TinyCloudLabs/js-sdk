/**
 * Three-state registry verdict for an owner DID (TC-1443, TC-1444).
 *
 * A registry lookup has exactly three outcomes, and callers must never
 * collapse them:
 *
 * - `registered`: a verified owner record exists. `hosts: []` is a valid
 *   registered record with no usable hosts (for example a tombstone), not
 *   "no record".
 * - `unregistered`: the registry said there is no record and nothing
 *   remembered says otherwise. Only this state may route an owner to a
 *   new-user default.
 * - `unavailable`: anything else. Network errors, timeouts, non-200/404
 *   statuses, unrecognised or oversize bodies, subject mismatches, bad
 *   signatures, and records older than the remembered sequence all fail
 *   closed here.
 *
 * {@link classifyRegistryLookup} is a pure classifier over one registry
 * response. It performs no I/O; `resolveOwnerHosts` (`registry-policy.ts`)
 * does the lookup for the opt-in `fail-closed` registry policy. The
 * classifier's rules are written to be portable: the shared vectors in
 * `test-vectors/registry-verdict/` state them for other implementations.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { verifyMessage } from "viem";
import { pkhDid } from "./identity";
import { canonicalLocationPayload } from "./location";

export type RegistryVerdictStatus = "registered" | "unregistered" | "unavailable";

/** Which registry source produced a verdict. */
export type RegistryVerdictSource = "chain" | "chain-cache" | "offchain";

/** Which source listed a host. `hint` is an address hint not yet confirmed by a node record. */
export type RegistryHostSource = RegistryVerdictSource | "hint";

export interface RegistryHost {
  /** Node DID that must answer `/info` at these origins, when the record names one. */
  readonly nodeDid?: string;
  /**
   * HTTP(S) origins (`scheme://host[:port]`, no path, query, fragment or
   * userinfo). Not filtered for HTTPS, address class or node identity: host
   * selection applies that policy.
   */
  readonly urls: readonly string[];
  readonly source: RegistryHostSource;
  /** Expiry of the node record the origins came from, when it has one. */
  readonly expiresAt?: string;
}

export type RegistryUnavailableReason =
  /** The registry could not be reached (refused, DNS, TLS, redirect refused). */
  | "network-error"
  /** The lookup exceeded its time budget. */
  | "timeout"
  /** The registry answered with a status other than 200 or 404. */
  | "http-status"
  /** The body is not the registry's record or not-found response. */
  | "malformed-response"
  /** The body exceeds {@link REGISTRY_LOOKUP_MAX_BODY_BYTES}. */
  | "oversize-response"
  /** A record was returned for a different subject. */
  | "subject-mismatch"
  /** The record signature does not verify for its subject. */
  | "invalid-signature"
  /** The record's sequence is below the remembered sequence. */
  | "rollback"
  /** The registry said "not found" for a subject remembered as registered. */
  | "not-found-after-registered";

export interface RegisteredRegistryVerdict {
  readonly status: "registered";
  readonly subject: string;
  readonly source: RegistryVerdictSource;
  /** Sequence of the accepted record. Callers persist the maximum they have seen. */
  readonly sequence: number;
  /** Listed hosts in record order. Empty when the record lists no usable host. */
  readonly hosts: readonly RegistryHost[];
}

export interface UnregisteredRegistryVerdict {
  readonly status: "unregistered";
  readonly subject: string;
  readonly source: RegistryVerdictSource;
  readonly hosts: readonly [];
}

export interface UnavailableRegistryVerdict {
  readonly status: "unavailable";
  readonly subject: string;
  readonly source: RegistryVerdictSource;
  readonly reason: RegistryUnavailableReason;
  /** Human-readable detail for logs and errors. Not part of the contract. */
  readonly message: string;
  readonly hosts: readonly [];
}

export type RegistryVerdict =
  | RegisteredRegistryVerdict
  | UnregisteredRegistryVerdict
  | UnavailableRegistryVerdict;

/**
 * One observed registry lookup: an HTTP response, or the reason none arrived.
 * The I/O layer must cap the raw body while reading it (as
 * `fetchLocationRecord` does); `body` is that capped body decoded as UTF-8.
 */
export type RegistryLookupResponse =
  | { readonly kind: "http"; readonly status: number; readonly body: string }
  | { readonly kind: "network-error" }
  | { readonly kind: "timeout" };

export interface ClassifyRegistryLookupOptions {
  /**
   * Highest record sequence previously accepted for this subject. Its
   * presence means the subject is known to be registered: a later not-found
   * or an older record is `unavailable`, never `unregistered`.
   */
  rememberedSequence?: number | null;
}

export type RegistryLookupInputErrorCode =
  | "invalid-subject"
  | "invalid-remembered-sequence";

/** The caller passed a lookup input that cannot be classified. */
export class RegistryLookupInputError extends TypeError {
  constructor(
    readonly code: RegistryLookupInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RegistryLookupInputError";
  }
}

/** Largest registry response body accepted, in UTF-8 bytes. */
export const REGISTRY_LOOKUP_MAX_BODY_BYTES = 64 * 1024;

/** The exact body of the location registry's 404 for a subject with no record. */
export const REGISTRY_NOT_FOUND_BODY = '{"error":"location record not found"}';

/** Deepest object/array nesting accepted in a registry response. */
const MAX_JSON_DEPTH = 32;
const JSON_SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};
/**
 * secp256k1 group order n. A literal, not noble's `secp256k1.CURVE.n`: viem
 * bundles its own noble copy, so importing sdk-core's would add a second
 * secp256k1 to the web bundle. The test pins it to noble's value.
 */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const IPV4_OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const DNS_LABEL = "[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const DNS_NAME = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})*$`);
const HOST_MULTIADDR =
  /^\/(ip4|ip6|dns|dns4|dns6)\/([^/]+)\/tcp\/([1-9][0-9]{0,4})\/(https|http|tls\/http)$/;
const RFC3339_DATE_TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-]([0-9]{2}):([0-9]{2}))$/;

/**
 * Classify one off-chain location registry v1 response for `subject`.
 *
 * Checks run in this order, and the first failure decides the reason:
 * transport (`network-error`, `timeout`); status other than 200 or 404
 * (`http-status`); body over 65536 UTF-8 bytes (`oversize-response`). A 404
 * is `unregistered` only if its body, with leading and trailing JSON
 * whitespace removed, is exactly {@link REGISTRY_NOT_FOUND_BODY} and no
 * sequence is remembered. A 200 must be strict JSON holding a valid v1
 * `record` (`malformed-response`) for exactly `subject`
 * (`subject-mismatch`) whose signature verifies (`invalid-signature`) and
 * whose sequence is not below the remembered one (`rollback`).
 *
 * A 404 is unauthenticated: its exact bytes are the only evidence that the
 * registry itself answered.
 *
 * @throws RegistryLookupInputError if `subject` is not a canonical
 * `did:pkh:eip155:<chainId>:<EIP-55 address>` or Ed25519 `did:key`, or
 * `rememberedSequence` is not a non-negative safe integer.
 */
export async function classifyRegistryLookup(
  subject: string,
  response: RegistryLookupResponse,
  options: ClassifyRegistryLookupOptions = {},
): Promise<RegistryVerdict> {
  if (!isCanonicalSubject(subject)) {
    throw new RegistryLookupInputError(
      "invalid-subject",
      "subject must be did:pkh:eip155:<chainId>:<EIP-55 address> or an Ed25519 did:key",
    );
  }
  const remembered = options.rememberedSequence ?? null;
  if (
    remembered !== null &&
    (!Number.isSafeInteger(remembered) || remembered < 0)
  ) {
    throw new RegistryLookupInputError(
      "invalid-remembered-sequence",
      "rememberedSequence must be a non-negative safe integer",
    );
  }

  const unavailable = (
    reason: RegistryUnavailableReason,
    message: string,
  ): UnavailableRegistryVerdict => ({
    status: "unavailable",
    subject,
    source: "offchain",
    reason,
    message,
    hosts: [],
  });

  if (response.kind === "network-error") {
    return unavailable("network-error", "location registry could not be reached");
  }
  if (response.kind === "timeout") {
    return unavailable("timeout", "location registry lookup timed out");
  }
  if (response.status !== 200 && response.status !== 404) {
    return unavailable("http-status", `location registry returned HTTP ${response.status}`);
  }
  // Every UTF-16 unit encodes to at least one UTF-8 byte, so the length test
  // is sound and avoids encoding an oversize string.
  if (
    response.body.length > REGISTRY_LOOKUP_MAX_BODY_BYTES ||
    new TextEncoder().encode(response.body).byteLength > REGISTRY_LOOKUP_MAX_BODY_BYTES
  ) {
    return unavailable("oversize-response", "location registry response is too large");
  }

  if (response.status === 404) {
    // Linear-time trim: a regex anchored at `$` re-scans whitespace runs.
    const body = response.body;
    let start = 0;
    let end = body.length;
    while (start < end && " \t\n\r".includes(body[start])) start++;
    while (end > start && " \t\n\r".includes(body[end - 1])) end--;
    if (body.slice(start, end) !== REGISTRY_NOT_FOUND_BODY) {
      return unavailable(
        "malformed-response",
        "location registry 404 is not the registry's not-found response",
      );
    }
    if (remembered !== null) {
      return unavailable(
        "not-found-after-registered",
        `location registry has no record, but sequence ${remembered} was seen before`,
      );
    }
    return { status: "unregistered", subject, source: "offchain", hosts: [] };
  }

  let record: V1Record;
  try {
    record = parseRecordResponse(response.body);
  } catch (error) {
    return unavailable(
      "malformed-response",
      error instanceof Error ? error.message : "location registry response is invalid",
    );
  }
  if (record.subject !== subject) {
    return unavailable(
      "subject-mismatch",
      "location record subject does not match requested subject",
    );
  }
  if (!(await verifyRecordSignature(record))) {
    return unavailable("invalid-signature", "location record signature is invalid");
  }
  if (remembered !== null && record.sequence < remembered) {
    return unavailable(
      "rollback",
      `location record sequence ${record.sequence} is below remembered sequence ${remembered}`,
    );
  }

  const hosts: RegistryHost[] = [];
  for (const address of record.multiaddrs) {
    const origin = multiaddrOrigin(address);
    if (origin !== null) hosts.push({ urls: [origin], source: "offchain" });
  }
  return {
    status: "registered",
    subject,
    source: "offchain",
    sequence: record.sequence,
    hosts,
  };
}

interface V1Record {
  subject: string;
  multiaddrs: string[];
  updated_at: string;
  sequence: number;
  signature: string;
}

/** Canonical `did:pkh:eip155:<chainId>:<EIP-55 address>` or Ed25519 `did:key`. */
export function isCanonicalSubject(subject: unknown): subject is string {
  if (typeof subject !== "string") return false;
  const pkh = /^did:pkh:eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/.exec(subject);
  if (pkh !== null) {
    try {
      // pkhDid emits the canonical form: safe-integer chain ID, EIP-55 address.
      return pkhDid(pkh[2], Number(pkh[1])) === subject;
    } catch {
      return false;
    }
  }
  return ed25519KeyFromDidKey(subject) !== null;
}

/** The Ed25519 public key of a canonical `did:key:z…` (multicodec 0xed 0x01), else null. */
function ed25519KeyFromDidKey(did: string): Uint8Array | null {
  if (!did.startsWith("did:key:z")) return null;
  const identifier = did.slice("did:key:".length);
  let bytes: Uint8Array;
  try {
    bytes = bases.base58btc.decode(identifier);
  } catch {
    return null;
  }
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    return null;
  }
  return bytes.slice(2);
}

/** A JSON number restricted to an integer literal; its lexeme is kept exactly. */
class JsonInteger {
  constructor(readonly lexeme: string) {}
}

type JsonValue = string | boolean | null | JsonInteger | JsonValue[] | Map<string, JsonValue>;

/**
 * RFC 8259 JSON with three restrictions that keep classification identical
 * across parsers: duplicate object keys, numbers with a fraction or
 * exponent, and nesting deeper than {@link MAX_JSON_DEPTH} are rejected, as
 * are `\u` escapes of unpaired UTF-16 surrogates.
 */
function parseStrictJson(text: string): JsonValue {
  let i = 0;
  const fail = (what: string): never => {
    throw new SyntaxError(`location registry response is not strict JSON: ${what} at ${i}`);
  };
  const skipWhitespace = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const readHex4 = (): number => {
    const hex = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
    i += 4;
    return parseInt(hex, 16);
  };
  const parseString = (): string => {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        i++;
        return out;
      }
      if (code < 0x20) fail("control character in string");
      if (code === 0x5c) {
        const escape = text[i + 1];
        i += 2;
        if (escape !== undefined && Object.prototype.hasOwnProperty.call(JSON_SIMPLE_ESCAPES, escape)) {
          out += JSON_SIMPLE_ESCAPES[escape];
          continue;
        }
        if (escape !== "u") fail("bad escape");
        const unit = readHex4();
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (text[i] !== "\\" || text[i + 1] !== "u") fail("unpaired surrogate");
          i += 2;
          const low = readHex4();
          if (low < 0xdc00 || low > 0xdfff) fail("unpaired surrogate");
          out += String.fromCharCode(unit, low);
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          fail("unpaired surrogate");
        } else {
          out += String.fromCharCode(unit);
        }
        continue;
      }
      out += text[i];
      i++;
    }
  };
  const parseValue = (depth: number): JsonValue => {
    skipWhitespace();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth >= MAX_JSON_DEPTH) fail("nesting too deep");
      i++;
      skipWhitespace();
      const close = c === "{" ? "}" : "]";
      const object = new Map<string, JsonValue>();
      const array: JsonValue[] = [];
      if (text[i] === close) {
        i++;
        return c === "{" ? object : array;
      }
      for (;;) {
        if (c === "{") {
          skipWhitespace();
          if (text[i] !== '"') fail("expected key");
          const key = parseString();
          if (object.has(key)) fail("duplicate key");
          skipWhitespace();
          if (text[i] !== ":") fail("expected ':'");
          i++;
          object.set(key, parseValue(depth + 1));
        } else {
          array.push(parseValue(depth + 1));
        }
        skipWhitespace();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== close) fail(`expected ',' or '${close}'`);
        i++;
        return c === "{" ? object : array;
      }
    }
    if (c === '"') return parseString();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return value;
      }
    }
    const number = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
    number.lastIndex = i;
    const match = number.exec(text);
    if (match === null) return fail("unexpected token");
    if (match[2] !== undefined || match[3] !== undefined) fail("non-integer number");
    i += match[0].length;
    return new JsonInteger(match[0]);
  };

  const value = parseValue(0);
  skipWhitespace();
  if (i !== text.length) fail("trailing data");
  return value;
}

function parseRecordResponse(body: string): V1Record {
  const root = parseStrictJson(body);
  const record = root instanceof Map ? root.get("record") : undefined;
  if (!(record instanceof Map)) {
    throw new SyntaxError("location registry response has no record object");
  }
  const version = record.get("version");
  const subject = record.get("subject");
  const multiaddrs = record.get("multiaddrs");
  const updatedAt = record.get("updated_at");
  const sequence = record.get("sequence");
  const signature = record.get("signature");
  if (!(version instanceof JsonInteger) || version.lexeme !== "1") {
    throw new SyntaxError("record.version must be the integer 1");
  }
  if (typeof subject !== "string") {
    throw new SyntaxError("record.subject must be a string");
  }
  if (
    !Array.isArray(multiaddrs) ||
    !multiaddrs.every((entry): entry is string => typeof entry === "string" && entry.length > 0)
  ) {
    throw new SyntaxError("record.multiaddrs must be an array of non-empty strings");
  }
  if (typeof updatedAt !== "string" || !isRfc3339DateTime(updatedAt)) {
    throw new SyntaxError("record.updated_at must be an RFC 3339 date-time");
  }
  if (
    !(sequence instanceof JsonInteger) ||
    !/^(0|[1-9][0-9]*)$/.test(sequence.lexeme) ||
    !Number.isSafeInteger(Number(sequence.lexeme))
  ) {
    throw new SyntaxError("record.sequence must be a non-negative safe integer");
  }
  if (typeof signature !== "string" || signature.length === 0) {
    throw new SyntaxError("record.signature must be a non-empty string");
  }
  return {
    subject,
    multiaddrs,
    updated_at: updatedAt,
    sequence: Number(sequence.lexeme),
    signature,
  };
}

function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (match[8] === "Z" || (Number(match[9]) <= 23 && Number(match[10]) <= 59))
  );
}

/**
 * Verify the record signature over the v1 signed bytes
 * ({@link canonicalLocationPayload}).
 *
 * - did:pkh: EIP-191 personal_sign by the subject's address (EOA only).
 *   `0x` + 130 hex digits (either case) = r ‖ s ‖ v with 1 ≤ r < n,
 *   1 ≤ s ≤ n/2 (low-s) and v ∈ {0, 1, 27, 28}.
 * - did:key: Ed25519 over the UTF-8 bytes with RFC 8032 encodings: A and R
 *   canonical (y < p), S < L, A not of small order; the group equation is
 *   cofactored. Exactly 86 unpadded base64url characters; the final 4 bits
 *   are ignored.
 */
async function verifyRecordSignature(record: V1Record): Promise<boolean> {
  const payload = canonicalLocationPayload({
    version: 1,
    subject: record.subject,
    multiaddrs: record.multiaddrs,
    updated_at: record.updated_at,
    sequence: record.sequence,
  });
  const { signature } = record;

  if (record.subject.startsWith("did:pkh:")) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
    const r = BigInt(`0x${signature.slice(2, 66)}`);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = parseInt(signature.slice(130), 16);
    if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_N / 2n) return false;
    if (v !== 0 && v !== 1 && v !== 27 && v !== 28) return false;
    const address = record.subject.slice(record.subject.lastIndexOf(":") + 1);
    try {
      return await verifyMessage({
        address: address as `0x${string}`,
        message: payload,
        signature: signature as `0x${string}`,
      });
    } catch {
      return false;
    }
  }

  const publicKey = ed25519KeyFromDidKey(record.subject);
  if (publicKey === null || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const bytes = new Uint8Array(64);
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (const char of signature) {
    buffer = ((buffer << 6) | BASE64URL.indexOf(char)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[length++] = (buffer >> bits) & 0xff;
    }
  }
  try {
    return ed25519.verify(bytes, new TextEncoder().encode(payload), publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * The HTTP(S) origin of a plain host multiaddr, else null:
 * `/{ip4,ip6,dns,dns4,dns6}/<host>/tcp/<1-65535>/{http,https,tls/http}`.
 * Any other shape (extra components, SNI, paths, zones, missing tcp or
 * scheme, port 0) is not an HTTP host.
 */
function multiaddrOrigin(address: string): string | null {
  const match = HOST_MULTIADDR.exec(address);
  if (match === null) return null;
  const [, protocol, host, portText, transport] = match;
  const port = Number(portText);
  if (port > 65535) return null;
  let authority: string;
  if (protocol === "ip4") {
    if (!IPV4.test(host)) return null;
    authority = host;
  } else if (protocol === "ip6") {
    if (!/^[0-9A-Fa-f:.]+$/.test(host) || !host.includes(":")) return null;
    authority = `[${host}]`;
  } else {
    // A last label that is a decimal or 0x-hex number makes a WHATWG URL
    // parser read the whole name as IPv4.
    if (
      host.length > 253 ||
      !DNS_NAME.test(host) ||
      /^(0[xX][0-9a-fA-F]*|[0-9]+)$/.test(host.slice(host.lastIndexOf(".") + 1))
    ) {
      return null;
    }
    authority = host;
  }
  const scheme = transport === "http" ? "http" : "https";
  try {
    return new URL(`${scheme}://${authority}:${port}`).origin;
  } catch {
    return null;
  }
}
