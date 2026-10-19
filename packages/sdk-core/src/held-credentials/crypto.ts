import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { asciiBytes, bytesToHex } from "./encoding";

export { sha256, keccak_256 };

const Point = ed25519.ExtendedPoint;

/** True when `bytes` is a canonical, on-curve, non-small-order Ed25519 point (public key or signature R). */
export function isStrictEd25519Point(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  try {
    return !Point.fromHex(bytes, false).isSmallOrder(); // zip215 = false: canonical encodings only
  } catch {
    return false;
  }
}

/**
 * RFC 8032 strict verification, matching the node's dalek `verify_strict`: canonical S, canonical
 * encodings, and no small-order public key or R.
 */
export function verifyEd25519Strict(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || !isStrictEd25519Point(publicKey) || !isStrictEd25519Point(signature.subarray(0, 32))) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Lowercase `0x` + 40 hex address of the key that produced an EIP-191 `personal_sign` signature, or null. */
export function recoverEip191Address(message: string, signature: Uint8Array): string | null {
  if (signature.length !== 65) return null;
  const v = signature[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  try {
    const body = new TextEncoder().encode(message);
    const prefix = asciiBytes(`\x19Ethereum Signed Message:\n${body.length}`);
    const digest = keccak_256(Uint8Array.from([...prefix, ...body]));
    const publicKey = secp256k1.Signature.fromCompact(signature.subarray(0, 64)).addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(false);
    return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}
