import { utf8Bytes } from "./bytes.js";
import { computeCid } from "./cid.js";

/**
 * Fixed protocol-label AAD, authenticated on every envelope
 * (blueprint §2.1: "versioned protocol label").
 */
export const ENVELOPE_AAD_LABEL = "tinycloud-share-envelope-v1";

/**
 * Version byte of the sealed-blob wire format (see `seal`). Bump only with a
 * new format; verifiers must reject unknown versions.
 */
export const SEALED_BLOB_VERSION = 0x01;

const AAD = utf8Bytes(ENVELOPE_AAD_LABEL);
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12; // 96-bit nonce, the AES-GCM standard size.
const TAG_LENGTH = 16; // AES-GCM authentication tag appended to the ciphertext.
const HEADER_LENGTH = 1; // the version byte

export interface EncryptedEnvelope {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

function assertKey(key32: Uint8Array): void {
  if (key32.length !== KEY_LENGTH) {
    throw new TypeError(`key must be ${KEY_LENGTH} bytes, got ${key32.length}`);
  }
}

async function importAesKey(
  key32: Uint8Array,
  usage: KeyUsage,
): Promise<CryptoKey> {
  assertKey(key32);
  return globalThis.crypto.subtle.importKey(
    "raw",
    key32 as BufferSource,
    "AES-GCM",
    false,
    [usage],
  );
}

/** Generate a fresh random 32-byte AES-256-GCM key. */
export function generateKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
}

export interface SealedEnvelope {
  /** The canonical stored block: `version(0x01) || nonce(12) || ciphertext+tag`. */
  blob: Uint8Array;
  /** CIDv1/raw/sha2-256 of `blob` — the CID that goes in the share link. */
  cid: string;
}

/**
 * Seal envelope plaintext into the ONE canonical stored-block format:
 *
 *   blob = version byte (0x01) || nonce (12 bytes) || AES-256-GCM ciphertext
 *          (which includes the trailing 16-byte auth tag)
 *
 * The returned CID is computed over the WHOLE blob, so a recipient holding
 * only the link (CID + key) can fetch the blob, verify the CID, and recover
 * the nonce from the blob itself. This is the only format the public
 * packaging path (and the share link) addresses; `encryptEnvelope` /
 * `decryptEnvelope` are the low-level pieces.
 */
export async function seal(
  plaintextBytes: Uint8Array,
  key32: Uint8Array,
): Promise<SealedEnvelope> {
  const { nonce, ciphertext } = await encryptEnvelope(plaintextBytes, key32);
  const blob = new Uint8Array(HEADER_LENGTH + nonce.length + ciphertext.length);
  blob[0] = SEALED_BLOB_VERSION;
  blob.set(nonce, HEADER_LENGTH);
  blob.set(ciphertext, HEADER_LENGTH + nonce.length);
  return { blob, cid: await computeCid(blob) };
}

/**
 * Open a sealed blob produced by `seal`: check the version byte, split
 * `nonce || ciphertext`, and decrypt. Throws on unknown version, truncated
 * blobs, and any AEAD failure (wrong key / tampering).
 */
export async function open(
  blob: Uint8Array,
  key32: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH) {
    throw new TypeError(`sealed blob too short: ${blob.length} bytes`);
  }
  if (blob[0] !== SEALED_BLOB_VERSION) {
    throw new TypeError(`unknown sealed blob version: ${blob[0]}`);
  }
  const nonce = blob.subarray(HEADER_LENGTH, HEADER_LENGTH + NONCE_LENGTH);
  const ciphertext = blob.subarray(HEADER_LENGTH + NONCE_LENGTH);
  return decryptEnvelope(nonce, ciphertext, key32);
}

/**
 * Encrypt envelope plaintext with AES-256-GCM under a fresh random 96-bit
 * nonce, authenticating the fixed protocol-label AAD.
 *
 * Low-level: the nonce is NOT carried by the share link. Public packaging
 * must go through `seal`, which binds `nonce || ciphertext` into one
 * CID-addressed blob.
 */
export async function encryptEnvelope(
  plaintextBytes: Uint8Array,
  key32: Uint8Array,
): Promise<EncryptedEnvelope> {
  const key = await importAesKey(key32, "encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: AAD as BufferSource },
      key,
      plaintextBytes as BufferSource,
    ),
  );
  return { nonce, ciphertext };
}

/**
 * Decrypt an AES-256-GCM envelope. Throws (Web Crypto `OperationError`) if the
 * key is wrong, the AAD does not match, or the ciphertext was tampered with.
 */
export async function decryptEnvelope(
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  key32: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== NONCE_LENGTH) {
    throw new TypeError(`nonce must be ${NONCE_LENGTH} bytes, got ${nonce.length}`);
  }
  const key = await importAesKey(key32, "decrypt");
  return new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: AAD as BufferSource },
      key,
      ciphertext as BufferSource,
    ),
  );
}
