/**
 * Per-request receiver key generation.
 *
 * The receiver key pair is generated for a single decrypt request: the
 * SDK sends `receiverPublicKey` to the node so the node can rewrap the
 * symmetric key; the matching private key never leaves the SDK.
 *
 * Two derivation modes are supported:
 *
 * 1. **Random** — `crypto.randomBytes(32)` seeds a fresh x25519 pair.
 *    This is the default for one-of-one flows.
 *
 * 2. **Signed-context** — the caller provides a signer that signs a
 *    deterministic context message (network id + nonce + invocation
 *    intent). The signature bytes are SHA-256'd into the seed. This is
 *    useful when callers want the receiver key to be reproducible by
 *    the same session signer (e.g. for delegated reads where the
 *    signer is the only stable secret).
 */

import { utf8Encode } from "./canonical";
import type {
  EncryptionCrypto,
  ReceiverKeyPair,
  ReceiverKeySigner,
} from "./types";

export interface RandomReceiverKeyInput {
  crypto: EncryptionCrypto;
}

export function generateRandomReceiverKey(
  input: RandomReceiverKeyInput,
): ReceiverKeyPair {
  const seed = input.crypto.randomBytes(32);
  return input.crypto.x25519FromSeed(seed);
}

export interface SignedReceiverKeyInput {
  crypto: EncryptionCrypto;
  signer: ReceiverKeySigner;
  networkId: string;
  /** Optional extra context (e.g. invocation nonce) folded into the message. */
  context?: string;
}

/**
 * Deterministic receiver-key derivation: signs a context string with
 * the supplied signer, then SHA-256s the signature bytes into the
 * x25519 seed.
 *
 * The context message is:
 *   `tinycloud.encryption.receiver-key/v1:<networkId>:<context>`
 *
 * Callers MUST include unique context (e.g. a fresh nonce) on every
 * request unless they explicitly want reproducibility.
 */
export async function deriveSignedReceiverKey(
  input: SignedReceiverKeyInput,
): Promise<ReceiverKeyPair> {
  const message = `tinycloud.encryption.receiver-key/v1:${input.networkId}:${input.context ?? ""}`;
  const sig = await input.signer.signMessage(message);
  // Treat the signature as opaque bytes; sha256 collapses to a 32-byte seed.
  const sigBytes = utf8Encode(sig);
  const seed = input.crypto.sha256(sigBytes);
  return input.crypto.x25519FromSeed(seed);
}
