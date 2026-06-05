/**
 * Canonical JSON serialization and content hashing for TinyCloud
 * encryption requests/responses.
 *
 * The node and SDK must agree byte-for-byte on the canonical form so
 * that body-hash bindings (`bodyHash`, `encryptedSymmetricKeyHash`,
 * `receiverPublicKeyHash`) verify on both sides.
 *
 * Canonical rules:
 * - Object keys are sorted lexicographically by code point.
 * - Strings are encoded with the JSON.stringify default (RFC 8259).
 * - Numbers are emitted via JSON.stringify; callers should restrict to
 *   integers or use string fields for high-precision values.
 * - `undefined` properties are dropped. `null` is preserved.
 * - Arrays preserve element order.
 *
 * Hashing uses SHA-256 supplied by the caller (via an `EncryptionCrypto`
 * binding) so this module stays platform-agnostic.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json | undefined };

/**
 * Produce the canonical JSON string for {@link value}. Object keys are
 * sorted, `undefined` properties are dropped, and primitive types are
 * encoded by `JSON.stringify`.
 */
export function canonicalize(value: Json | undefined): string {
  if (value === undefined) {
    return "";
  }
  return stringify(value);
}

function stringify(value: Json): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(stringify).join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = value[k];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${stringify(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(
        `canonicalize: unsupported value type ${typeof value}`,
      );
  }
}

const HEX = "0123456789abcdef";

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  }
  return out;
}

export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(hex[i * 2], 16);
    const lo = parseInt(hex[i * 2 + 1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new Error("invalid hex character");
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  // base64 (standard, not url-safe) so envelopes pass through JSON cleanly.
  // We avoid `btoa` to stay node-friendly without polyfills.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[(b0 >> 2) & 0x3f];
    out += chars[((b0 << 4) | (b1 >> 4)) & 0x3f];
    out += i + 1 < bytes.length ? chars[((b1 << 2) | (b2 >> 6)) & 0x3f] : "=";
    out += i + 2 < bytes.length ? chars[b2 & 0x3f] : "=";
  }
  return out;
}

export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  if (len % 4 !== 0) {
    throw new Error("invalid base64 input");
  }
  const padding =
    clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const outLen = (len / 4) * 3 - padding;
  const out = new Uint8Array(outLen);
  const lookup: Record<string, number> = {};
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) lookup[chars[i]] = i;

  let outIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const v0 = lookup[clean[i]] ?? 0;
    const v1 = lookup[clean[i + 1]] ?? 0;
    const v2 = clean[i + 2] === "=" ? 0 : (lookup[clean[i + 2]] ?? 0);
    const v3 = clean[i + 3] === "=" ? 0 : (lookup[clean[i + 3]] ?? 0);
    const b0 = (v0 << 2) | (v1 >> 4);
    const b1 = ((v1 & 0x0f) << 4) | (v2 >> 2);
    const b2 = ((v2 & 0x03) << 6) | v3;
    if (outIdx < outLen) out[outIdx++] = b0;
    if (outIdx < outLen) out[outIdx++] = b1;
    if (outIdx < outLen) out[outIdx++] = b2;
  }
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/**
 * Compute `hexEncode(sha256(canonicalize(value)))`. The SHA-256 binding
 * is injected so the module remains usable in both the WASM and pure-JS
 * paths.
 */
export function canonicalHashHex(
  sha256: (bytes: Uint8Array) => Uint8Array,
  value: Json,
): string {
  const canonical = canonicalize(value);
  return hexEncode(sha256(utf8Encode(canonical)));
}
