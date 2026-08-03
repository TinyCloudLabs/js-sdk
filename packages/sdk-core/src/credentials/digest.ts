import { jcsCanonicalize } from "../policy/jcs";

export function encodeBase64Url(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new TypeError("value is not canonical base64url");
  const bytes = typeof atob === "function"
    ? Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (c) => c.charCodeAt(0))
    : new Uint8Array(Buffer.from(value, "base64url"));
  if (encodeBase64Url(bytes) !== value) throw new TypeError("value is not canonical base64url");
  return bytes;
}

export async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Base64Url(jcsCanonicalize(value));
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
