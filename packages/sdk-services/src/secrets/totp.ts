/**
 * TOTP (RFC 6238) seed parsing and code generation.
 *
 * Published as `@tinycloud/sdk-services/secrets/totp` and deliberately not
 * exported from the package root, so the root and worker bundles do not carry
 * it. Everything here is local computation: a seed never leaves the caller.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha1 } from "@noble/hashes/sha1";
import { sha256, sha512 } from "@noble/hashes/sha2";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParams {
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number;
  /** Seconds each code stays valid. */
  period: number;
}

export interface ParsedTotpSeed extends TotpParams {
  issuer?: string;
  label?: string;
}

export type TotpParseFailure =
  | "empty"
  | "invalid_base32"
  | "too_short"
  | "not_totp"
  | "missing_secret"
  | "invalid_period"
  | "invalid_digits"
  | "invalid_algorithm";

export type TotpParseResult =
  | { ok: true; data: ParsedTotpSeed }
  | { ok: false; reason: TotpParseFailure; message: string };

const MIN_BASE32_CHARS = 8;
const OTPAUTH_PREFIX = "otpauth://";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function fail(reason: TotpParseFailure, message: string): TotpParseResult {
  return { ok: false, reason, message };
}

/** RFC 4648 base32; spaces, dashes, lowercase and `=` padding are tolerated. */
function decodeBase32(input: string): Uint8Array | "invalid" | "short" {
  const text = input.replace(/[\s=-]+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return "invalid";
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (text.length < MIN_BASE32_CHARS) return "short";
  return Uint8Array.from(out);
}

function parsePositiveInt(text: string): number | undefined {
  return /^\d{1,9}$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
}

function parseAlgorithm(text: string): TotpAlgorithm | undefined {
  const upper = text.toUpperCase();
  return upper === "SHA1" || upper === "SHA256" || upper === "SHA512"
    ? upper
    : undefined;
}

function decodeUriPart(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Parse an `otpauth://totp/...` URI, or a bare base32 seed as the fallback.
 * Failure messages never include the seed.
 */
export function parseTotpSeed(input: string): TotpParseResult {
  const text = input.trim();
  if (text === "") return fail("empty", "Enter a TOTP seed or otpauth:// link.");

  if (!text.toLowerCase().startsWith(OTPAUTH_PREFIX)) {
    return fromSecret(text, {});
  }

  const rest = text.slice(OTPAUTH_PREFIX.length);
  const queryStart = rest.indexOf("?");
  const head = queryStart < 0 ? rest : rest.slice(0, queryStart);
  const query = new URLSearchParams(queryStart < 0 ? "" : rest.slice(queryStart + 1));
  const slash = head.indexOf("/");
  const kind = (slash < 0 ? head : head.slice(0, slash)).toLowerCase();
  if (kind !== "totp") {
    return fail("not_totp", "Only time-based (totp) otpauth links are supported.");
  }

  const secret = query.get("secret");
  if (secret === null || secret.trim() === "") {
    return fail("missing_secret", "The otpauth link has no secret.");
  }

  const rawLabel = slash < 0 ? "" : decodeUriPart(head.slice(slash + 1));
  const colon = rawLabel.indexOf(":");
  const labelIssuer = colon < 0 ? undefined : rawLabel.slice(0, colon).trim();
  const label = (colon < 0 ? rawLabel : rawLabel.slice(colon + 1)).trim();
  const issuer = query.get("issuer")?.trim() || labelIssuer || undefined;

  const periodText = query.get("period");
  const digitsText = query.get("digits");
  const algorithmText = query.get("algorithm");
  const period = periodText === null ? 30 : parsePositiveInt(periodText);
  if (period === undefined || period > 3600) {
    return fail("invalid_period", "The otpauth period must be 1 to 3600 seconds.");
  }
  const digits = digitsText === null ? 6 : parsePositiveInt(digitsText);
  if (digits === undefined || digits < 6 || digits > 8) {
    return fail("invalid_digits", "The otpauth digits must be 6, 7 or 8.");
  }
  const algorithm = algorithmText === null ? "SHA1" : parseAlgorithm(algorithmText);
  if (algorithm === undefined) {
    return fail("invalid_algorithm", "The otpauth algorithm must be SHA1, SHA256 or SHA512.");
  }

  return fromSecret(secret, {
    period,
    digits,
    algorithm,
    ...(issuer === undefined ? {} : { issuer }),
    ...(label === "" ? {} : { label }),
  });
}

function fromSecret(
  secretText: string,
  rest: Partial<Omit<ParsedTotpSeed, "secret">>,
): TotpParseResult {
  const secret = decodeBase32(secretText);
  if (secret === "invalid") {
    return fail("invalid_base32", "The seed is not valid base32 (letters A-Z and digits 2-7).");
  }
  if (secret === "short") {
    return fail("too_short", "The seed is too short to be a TOTP seed.");
  }
  return {
    ok: true,
    data: { algorithm: "SHA1", digits: 6, period: 30, ...rest, secret },
  };
}

/** Seconds until the current code changes: `period` right at a boundary, then counting down. */
export function totpSecondsRemaining(period: number, nowMs: number): number {
  return period - (Math.floor(nowMs / 1000) % period);
}

/** The code for `nowMs` (epoch milliseconds), zero-padded to `digits`. */
export function generateTotp(params: TotpParams, nowMs: number): string {
  const counter = Math.floor(nowMs / 1000 / params.period);
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter % 2 ** 32);

  const hash =
    params.algorithm === "SHA256"
      ? sha256
      : params.algorithm === "SHA512"
        ? sha512
        : sha1;
  const digest = hmac(hash, params.secret, message);
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
}
