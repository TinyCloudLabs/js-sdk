import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
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
    if (!ed25519.verify(signature, message, publicKey, { zip215: false })) return false;
    // noble's check is cofactored (it multiplies the difference by 8), which accepts a mixed-order R
    // that dalek's `verify_strict` refuses. Also require the exact, cofactorless equation
    // [S]B == R + [k]A with k = H(R || A || M) mod L.
    const R = Point.fromHex(signature.subarray(0, 32), false);
    const A = Point.fromHex(publicKey, false);
    const S = bytesToNumberLE(signature.subarray(32));
    const k = bytesToNumberLE(sha512(Uint8Array.from([...signature.subarray(0, 32), ...publicKey, ...message]))) % ed25519.CURVE.n;
    return Point.BASE.multiplyUnsafe(S).equals(R.add(A.multiply(k)));
  } catch {
    return false;
  }
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let out = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) out = (out << 8n) | BigInt(bytes[i]!);
  return out;
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
