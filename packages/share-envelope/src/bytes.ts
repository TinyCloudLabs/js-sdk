import { base64url as mfBase64url } from "multiformats/bases/base64";

/** Encode bytes as unpadded base64url (RFC 4648 §5, no multibase prefix). */
export function toBase64Url(bytes: Uint8Array): string {
  return mfBase64url.baseEncode(bytes);
}

/**
 * STRICT decode of unpadded base64url into bytes. Throws on characters
 * outside the alphabet, impossible lengths, non-zero trailing bits, and any
 * padded or otherwise non-canonical form: the input must re-encode to itself
 * byte-for-byte. (multiformats' baseDecode alone tolerates trailing `=`.)
 */
export function fromBase64Url(text: string): Uint8Array {
  const bytes = mfBase64url.baseDecode(text);
  if (mfBase64url.baseEncode(bytes) !== text) {
    // Deliberately does not echo the input — it may be key material.
    throw new TypeError("non-canonical base64url input");
  }
  return bytes;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
