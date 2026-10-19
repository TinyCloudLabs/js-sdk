import { refuse, type HeldCredentialErrorCode } from "./errors";

const B64URL = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict unpadded, canonical base64url. */
export function decodeBase64Url(value: string, code: HeldCredentialErrorCode = "bad-presentation"): Uint8Array {
  if (!B64URL.test(value) || value.length % 4 === 1) refuse(code, "not unpadded base64url");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (encodeBase64Url(bytes) !== value) refuse(code, "non-canonical base64url");
  return bytes;
}

export function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) > 0x7f) return false;
  return true;
}

export function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string, code: HeldCredentialErrorCode = "bad-presentation"): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) refuse(code, "not hex");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deepest nesting `parseStrictJson` accepts. Held credentials are at most three levels deep. */
export const MAX_JSON_DEPTH = 8;

const JSON_LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * JSON parser that refuses duplicate object keys anywhere (JSON.parse silently keeps the last).
 * Objects have a null prototype, so a `__proto__` key is an ordinary key. Nesting deeper than
 * MAX_JSON_DEPTH is refused with `code`, so the recursion is bounded and no RangeError escapes.
 */
export function parseStrictJson(text: string, code: HeldCredentialErrorCode): Json {
  let i = 0;
  let depth = 0;
  const fail = (what: string): never => refuse(code, `invalid JSON: ${what}`);
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i += 1; };
  const string = (): string => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail("unterminated string");
    i += 1;
    try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail("bad string"); }
  };
  const value = (): Json => {
    ws();
    const c = text[i];
    if ((c === "{" || c === "[") && (depth += 1) > MAX_JSON_DEPTH) fail("nesting too deep");
    if (c === "{") {
      i += 1;
      const out: { [key: string]: Json } = Object.create(null);
      ws();
      if (text[i] === "}") { i += 1; depth -= 1; return out; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected key");
        const key = string();
        if (Object.prototype.hasOwnProperty.call(out, key)) fail("duplicate key");
        ws();
        if (text[i] !== ":") fail("expected colon");
        i += 1;
        out[key] = value();
        ws();
        if (text[i] === ",") { i += 1; continue; }
        if (text[i] === "}") { i += 1; depth -= 1; return out; }
        fail("expected , or }");
      }
    }
    if (c === "[") {
      i += 1;
      const out: Json[] = [];
      ws();
      if (text[i] === "]") { i += 1; depth -= 1; return out; }
      for (;;) {
        out.push(value());
        ws();
        if (text[i] === ",") { i += 1; continue; }
        if (text[i] === "]") { i += 1; depth -= 1; return out; }
        fail("expected , or ]");
      }
    }
    if (c === '"') return string();
    JSON_LITERAL.lastIndex = i;
    const literal = JSON_LITERAL.exec(text);
    if (!literal) return fail("unexpected token");
    i += literal[0].length;
    return JSON.parse(literal[0]) as Json;
  };
  const result = value();
  ws();
  if (i !== text.length) fail("trailing data");
  return result;
}
