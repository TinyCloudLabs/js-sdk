import { base58btc } from "multiformats/bases/base58";

/** Multicodec varint prefix for an ed25519 public key (0xed → varint ed 01). */
const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);
const PUBLIC_KEY_LENGTH = 32;

/** Encode a 32-byte ed25519 public key as a did:key (multibase base58btc). */
export function didKeyFromEd25519PublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) {
    throw new TypeError(
      `ed25519 public key must be ${PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`,
    );
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:${base58btc.encode(prefixed)}`;
}

/** Decode a did:key back to the raw 32-byte ed25519 public key. Throws on any other DID. */
export function ed25519PublicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:")) {
    throw new TypeError(`not a did:key: ${did}`);
  }
  const multibase = did.slice("did:key:".length);
  const prefixed = base58btc.decode(multibase);
  if (
    prefixed.length !== ED25519_MULTICODEC_PREFIX.length + PUBLIC_KEY_LENGTH ||
    prefixed[0] !== ED25519_MULTICODEC_PREFIX[0] ||
    prefixed[1] !== ED25519_MULTICODEC_PREFIX[1]
  ) {
    throw new TypeError("did:key does not encode an ed25519 public key");
  }
  return prefixed.slice(ED25519_MULTICODEC_PREFIX.length);
}
