import { ed25519 } from "@noble/curves/ed25519";

const { ExtendedPoint } = ed25519;
const GROUP_ORDER = ed25519.CURVE.n;
const FIELD_PRIME = ed25519.CURVE.Fp.ORDER;

export type Ed25519KeyProblem = "noncanonical" | "invalid" | "weak";

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i] ?? 0);
  return n;
}

type Decoded = { readonly point: InstanceType<typeof ExtendedPoint> } | { readonly problem: "noncanonical" | "invalid" };

/** Decode a point, rejecting `y >= p` and a set sign bit on `x = 0`. */
function decodePoint(bytes: Uint8Array): Decoded {
  if (bytes.length !== 32) return { problem: "invalid" };
  const word = littleEndian(bytes);
  const y = word & ((1n << 255n) - 1n);
  if (y >= FIELD_PRIME) return { problem: "noncanonical" };
  let point: InstanceType<typeof ExtendedPoint>;
  try {
    point = ExtendedPoint.fromHex(bytes, false);
  } catch {
    return { problem: "invalid" };
  }
  if (point.toAffine().x === 0n && (word >> 255n) === 1n) return { problem: "noncanonical" };
  return { point };
}

/** A point is usable iff it has order exactly the group order: not the identity, not small order, no torsion component. */
function hasPrimeOrder(point: InstanceType<typeof ExtendedPoint>): boolean {
  return !point.equals(ExtendedPoint.ZERO) && point.isTorsionFree();
}

/** `null` when the 32 bytes are a usable Ed25519 public key; otherwise the reason. */
export function ed25519KeyProblem(publicKey: Uint8Array): Ed25519KeyProblem | null {
  const decoded = decodePoint(publicKey);
  if ("problem" in decoded) return decoded.problem;
  return hasPrimeOrder(decoded.point) ? null : "weak";
}

/**
 * The verification rule of the links contract, the same in every
 * implementation: `S < L`; canonical encodings of `A` and `R`; `A` and `R` of
 * order exactly `L`; then the equation. With `A` and `R` of prime order the
 * cofactored and cofactorless equations agree.
 */
export function verifyEd25519Strict(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (littleEndian(signature.subarray(32)) >= GROUP_ORDER) return false;
  const a = decodePoint(publicKey);
  const r = decodePoint(signature.subarray(0, 32));
  if ("problem" in a || "problem" in r || !hasPrimeOrder(a.point) || !hasPrimeOrder(r.point)) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
