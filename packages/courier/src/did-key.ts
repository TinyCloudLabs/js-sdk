import { createPrivateKey, createPublicKey } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Multibase base58btc without the `z` prefix. */
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = '';
  while (value > 0n) { text = BASE58[Number(value % 58n)] + text; value /= 58n; }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return '1'.repeat(zeros) + text;
}

/** The `did:key` of an Ed25519 public key (multicodec 0xed01, base58btc), without any `#fragment`. */
export function ed25519DidKey(publicKey: Uint8Array): string {
  return `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), publicKey]))}`;
}

/** The 32 bytes of canonical unpadded base64url text (43 characters, unused bits zero), or undefined when the text is not exactly that. */
export function base64url32(text: unknown): Buffer | undefined {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : undefined;
}

/** The Ed25519 public key (32 bytes) of a 32-byte private seed. */
export function ed25519PublicKey(seed: Uint8Array): Buffer {
  // PKCS#8 wrapper of an Ed25519 seed; Node derives the public key from it.
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return Buffer.from(jwk.x as string, 'base64url');
}
