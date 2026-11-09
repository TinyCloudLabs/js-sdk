import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { base64Decode, base64Encode, canonicalize, utf8Encode } from "./canonical";
import { parseEncryptionResource } from "./networkId";

export const KEY_WRAP_V2_ALG = "x25519-hkdf-aes256gcm/v2" as const;
const MAGIC = utf8Encode("TCW2");
const INFO = utf8Encode("tinycloud.encryption.key-wrap/v2");
const MAX_HEADER = 65536;

export interface KeyWrapContext {
  purpose: "network-key" | "receiver-key";
  networkId: string;
  keyPath: string;
  keyVersion: number;
  metadata: Record<string, string>;
}

export interface KeyWrapV2Header extends KeyWrapContext {
  v: 2;
  alg: typeof KEY_WRAP_V2_ALG;
  kdf: "hkdf-sha256";
  aead: "aes-256-gcm";
  salt: string;
  ephemeralPublicKey: string;
  recipientPublicKey: string;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function decode32(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Error("Invalid key wrap encoding");
  const decoded = base64Decode(value);
  if (decoded.length !== 32 || base64Encode(decoded) !== value) throw new Error("Invalid key wrap encoding");
  return decoded;
}

/** ES2020-compatible UTF-16 well-formedness check without replacement or allocation. */
function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateContext(context: KeyWrapContext): void {
  if ((context.purpose !== "network-key" && context.purpose !== "receiver-key") ||
      typeof context.networkId !== "string" || typeof context.keyPath !== "string" ||
      !isWellFormed(context.networkId) || !isWellFormed(context.keyPath) ||
      !Number.isSafeInteger(context.keyVersion) || context.keyVersion <= 0 ||
      !context.metadata || typeof context.metadata !== "object" || Array.isArray(context.metadata) ||
      Object.entries(context.metadata).some(([key, value]) => !isWellFormed(key) || typeof value !== "string" || !isWellFormed(value))) {
    throw new Error("Invalid key wrap context");
  }
  if (context.networkId !== "") {
    const resource = parseEncryptionResource(context.keyPath === "" ? context.networkId : `${context.networkId}/${context.keyPath}`);
    if (resource.networkId !== context.networkId || (resource.keyPath ?? "") !== context.keyPath || context.keyPath.endsWith("/")) {
      throw new Error("Invalid key wrap resource");
    }
  }
}

export function isKeyWrapV2(wrapped: Uint8Array): boolean {
  return wrapped.length >= 4 && MAGIC.every((byte, index) => wrapped[index] === byte);
}

/** Parse the closed canonical header. Authentication occurs when the node or recipient opens it. */
export function readKeyWrapV2(wrapped: Uint8Array): {
  header: KeyWrapV2Header; aad: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array;
} {
  if (!isKeyWrapV2(wrapped) || wrapped.length < 8) throw new Error("Invalid v2 key wrap frame");
  const length = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength).getUint32(4);
  if (length === 0 || length > MAX_HEADER || wrapped.length < 8 + length + 12 + 16) throw new Error("Invalid v2 key wrap length");
  const bytes = wrapped.subarray(8, 8 + length);
  const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as KeyWrapV2Header;
  const fields = ["v", "alg", "kdf", "aead", "salt", "ephemeralPublicKey", "recipientPublicKey", "purpose", "networkId", "keyPath", "keyVersion", "metadata"].sort();
  if (!header || typeof header !== "object" || Array.isArray(header) ||
      Object.keys(header).sort().join(",") !== fields.join(",") ||
      header.v !== 2 || header.alg !== KEY_WRAP_V2_ALG || header.kdf !== "hkdf-sha256" || header.aead !== "aes-256-gcm") {
    throw new Error("Invalid v2 key wrap header");
  }
  validateContext(header);
  decode32(header.salt); decode32(header.ephemeralPublicKey); decode32(header.recipientPublicKey);
  if (!equal(bytes, utf8Encode(canonicalize({ ...header })))) throw new Error("Non-canonical v2 key wrap header");
  const end = 8 + length;
  return { header, aad: wrapped.subarray(0, end), nonce: wrapped.subarray(end, end + 12), ciphertext: wrapped.subarray(end + 12) };
}

export function assertKeyWrapContext(header: KeyWrapV2Header, expected: KeyWrapContext): void {
  validateContext(expected);
  for (const field of ["purpose", "networkId", "keyPath", "keyVersion"] as const) {
    if (header[field] !== expected[field]) throw new Error("Key wrap context mismatch");
  }
  if (canonicalize(header.metadata) !== canonicalize(expected.metadata)) throw new Error("Key wrap metadata mismatch");
}

function deriveKey(secret: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array, salt: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secret, ephemeral);
  if (shared.every(byte => byte === 0)) throw new Error("Invalid key agreement");
  try { return hkdf(sha256, shared, salt, concat(INFO, ephemeral, recipient), 32); }
  finally { shared.fill(0); }
}

export function sealKeyV2(recipientPublicKey: Uint8Array, plaintext: Uint8Array, context: KeyWrapContext): Uint8Array {
  validateContext(context);
  if (recipientPublicKey.length !== 32) throw new Error("Invalid recipient public key");
  const secret = randomBytes(32);
  const ephemeral = x25519.getPublicKey(secret);
  const salt = randomBytes(32);
  const header: KeyWrapV2Header = {
    ...context, v: 2, alg: KEY_WRAP_V2_ALG, kdf: "hkdf-sha256", aead: "aes-256-gcm",
    salt: base64Encode(salt), ephemeralPublicKey: base64Encode(ephemeral), recipientPublicKey: base64Encode(recipientPublicKey),
  };
  const bytes = utf8Encode(canonicalize({ ...header }));
  if (bytes.length > MAX_HEADER) throw new Error("Key wrap header too large");
  const prefix = new Uint8Array(8);
  prefix.set(MAGIC);
  new DataView(prefix.buffer).setUint32(4, bytes.length);
  const aad = concat(prefix, bytes);
  const nonce = randomBytes(12);
  // The info always orders the ephemeral key before the recipient key.
  let key: Uint8Array | undefined;
  try {
    const shared = x25519.getSharedSecret(secret, recipientPublicKey);
    try {
      if (shared.every(byte => byte === 0)) throw new Error("Invalid key agreement");
      key = hkdf(sha256, shared, salt, concat(INFO, ephemeral, recipientPublicKey), 32);
    }
    finally { shared.fill(0); }
    return concat(aad, nonce, gcm(key, nonce, aad).encrypt(plaintext));
  } finally { secret.fill(0); key?.fill(0); }
}

export function openKeyV2(recipientPrivateKey: Uint8Array, wrapped: Uint8Array, expected: KeyWrapContext): Uint8Array {
  const { header, aad, nonce, ciphertext } = readKeyWrapV2(wrapped);
  assertKeyWrapContext(header, expected);
  const recipient = x25519.getPublicKey(recipientPrivateKey);
  if (!equal(recipient, decode32(header.recipientPublicKey))) throw new Error("Key wrap recipient mismatch");
  const key = deriveKey(recipientPrivateKey, decode32(header.ephemeralPublicKey), recipient, decode32(header.salt));
  try { return gcm(key, nonce, aad).decrypt(ciphertext); }
  finally { key.fill(0); }
}

/** Match the declared algorithm without falling back after a TCW2 marker. */
export function assertKeyWrapAlgorithm(wrapped: Uint8Array, alg: string, requireV2 = false): void {
  if (alg !== "x25519-aes256gcm/v1" && alg !== KEY_WRAP_V2_ALG) throw new Error("Unsupported key wrap algorithm");
  if (requireV2 && alg !== KEY_WRAP_V2_ALG) throw new Error("V2 network key wrap required");
  if (isKeyWrapV2(wrapped) !== (alg === KEY_WRAP_V2_ALG)) throw new Error("Key wrap algorithm mismatch");
  if (alg === KEY_WRAP_V2_ALG) readKeyWrapV2(wrapped);
}

export type ColumnFormat = "encrypted" | "legacy-plaintext";

/** Stored format, not input bytes, determines whether a column is plaintext. */
export function decryptColumn(
  decrypt: (key: Uint8Array, ciphertext: Uint8Array) => Uint8Array,
  key: Uint8Array, blob: Uint8Array, expectedFormat: ColumnFormat, strictEncryption = false,
): Uint8Array {
  if (expectedFormat === "legacy-plaintext") {
    if (strictEncryption) throw new Error("Legacy plaintext is disabled");
    return blob;
  }
  if (expectedFormat !== "encrypted" || blob.length < 1 + 12 + 16 || blob[0] !== 1) throw new Error("Invalid encrypted column frame");
  return decrypt(key, blob.subarray(1));
}
