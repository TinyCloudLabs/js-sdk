import { CourierError } from './errors.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Multicodec varint prefix for an ed25519 public key.
const ED25519_PUB = Uint8Array.of(0xed, 0x01);

/** Bitcoin-alphabet base58 encoding; leading zero bytes become leading '1' characters. */
export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

function base58btcDecode(text: string): Buffer {
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new CourierError('bad-did', 'did:key contains a character outside base58btc.');
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  const zeros = text.length - text.replace(/^1+/, '').length;
  return Buffer.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/** True for a bare did:key (no `#` fragment) that really is an ed25519 key. The one strict check the grant record parser and the owner-facing texts share. */
export function isEd25519DidKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('#')) return false;
  try {
    ed25519PublicKeyOfDidKey(value);
    return true;
  } catch {
    return false;
  }
}

/** How an owner-facing text names a peer's courier: the DID only if it is a real ed25519 did:key, never text the peer chose. */
export const courierPhrase = (did: string): string => (isEd25519DidKey(did) ? `courier ${did}` : 'a courier in an unrecognised format');

/** did:key for an ed25519 public key given as the JWK `x` value (base64url, 32 bytes). */
export function ed25519DidKey(xBase64url: string): string {
  const x = Buffer.from(xBase64url, 'base64url');
  if (x.length !== 32) {
    throw new CourierError('key-generation', 'ed25519 public key must be 32 bytes.');
  }
  const multicodec = new Uint8Array(ED25519_PUB.length + x.length);
  multicodec.set(ED25519_PUB, 0);
  multicodec.set(x, ED25519_PUB.length);
  return `did:key:z${base58btc(multicodec)}`;
}

/** Inverse of ed25519DidKey: the 32-byte ed25519 public key carried by a did:key. */
export function ed25519PublicKeyOfDidKey(did: string): Buffer {
  // SDK-derived DIDs carry a `#<key-id>` fragment; the key itself is in the bare DID.
  const bare = did.split('#')[0];
  if (!bare.startsWith('did:key:z')) throw new CourierError('bad-did', 'Holder DID must be a did:key with base58btc (z) encoding.');
  const bytes = base58btcDecode(bare.slice('did:key:z'.length));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new CourierError('bad-did', 'Holder DID is not an ed25519 did:key.');
  }
  return bytes.subarray(2);
}
