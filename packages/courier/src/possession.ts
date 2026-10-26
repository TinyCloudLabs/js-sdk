import { createHash, createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { ed25519PublicKeyOfDidKey } from './did-key.js';
import { POSSESSION_MAX_BYTES } from './invite-schema.js';

/** A possession proof older than this is rejected; so is one from further in the future than FUTURE_SKEW_MS. */
export const POSSESSION_MAX_AGE_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;

const CLAIM_KEYS = ['credentialDigest', 'iat', 'inviteId', 'oneTimeKeyHash'] as const;

export interface PossessionClaims {
  inviteId: string;
  oneTimeKeyHash: string;
  credentialDigest: string;
  /** Unix seconds. */
  iat: number;
}

export type PossessionExpected = Omit<PossessionClaims, 'iat'>;

export type PossessionResult =
  | { ok: true; claims: PossessionClaims }
  | { ok: false; reason: 'too-large' | 'malformed' | 'payload-mismatch' | 'claims-mismatch' | 'stale' | 'future' | 'bad-holder' | 'bad-signature' };

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 (hex) of the one-time key's public `x` exactly as it appears in the JWK. */
export function oneTimeKeyHash(oneTimeKeyX: string): string {
  return sha256Hex(oneTimeKeyX);
}

/** sha256 (hex) of the credential string exactly as the invitee sends it in hello. */
export function credentialDigest(credential: string): string {
  return sha256Hex(credential);
}

/** Canonical JSON of the four signed claims; the exact bytes that are signed. */
export function possessionPayload(claims: PossessionClaims): string {
  return canonicalJson({
    credentialDigest: claims.credentialDigest,
    iat: claims.iat,
    inviteId: claims.inviteId,
    oneTimeKeyHash: claims.oneTimeKeyHash,
  });
}

/**
 * Join side: sign a possession proof with the invitee's courier key (Ed25519 JWK with `d`).
 * Output is `base64url(payload).base64url(signature)`.
 */
export function signPossession(
  input: { inviteId: string; oneTimeKeyX: string; credential: string },
  courierJwk: Record<string, unknown>,
  now: number = Date.now(),
): string {
  const payload = possessionPayload({
    inviteId: input.inviteId,
    oneTimeKeyHash: oneTimeKeyHash(input.oneTimeKeyX),
    credentialDigest: credentialDigest(input.credential),
    iat: Math.floor(now / 1000),
  });
  const key = createPrivateKey({ key: courierJwk as JsonWebKey, format: 'jwk' });
  const signature = sign(null, Buffer.from(payload, 'utf8'), key);
  const out = `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature.toString('base64url')}`;
  if (Buffer.byteLength(out) > POSSESSION_MAX_BYTES) {
    throw new Error('possession proof exceeds POSSESSION_MAX_BYTES');
  }
  return out;
}

/**
 * Pure verification (no network). Checks, in order: size, two-part shape, canonical payload with exactly the
 * four claims, claims equal to `expected`, iat freshness, then the Ed25519 signature by `holderDid`.
 */
export function verifyPossession(
  sigString: string,
  expected: PossessionExpected,
  holderDid: string,
  now: number = Date.now(),
): PossessionResult {
  if (Buffer.byteLength(sigString) > POSSESSION_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const parts = sigString.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;

  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' };
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((k, i) => k !== CLAIM_KEYS[i])) return { ok: false, reason: 'malformed' };
  // Signed bytes must be the canonical form, so an equivalent re-serialization cannot pass.
  if (canonicalJson(record) !== payload) return { ok: false, reason: 'payload-mismatch' };

  const { inviteId, oneTimeKeyHash: hash, credentialDigest: digest, iat } = record;
  if (typeof inviteId !== 'string' || typeof hash !== 'string' || typeof digest !== 'string'
    || typeof iat !== 'number' || !Number.isInteger(iat)) {
    return { ok: false, reason: 'malformed' };
  }
  const claims: PossessionClaims = { inviteId, oneTimeKeyHash: hash, credentialDigest: digest, iat };
  if (inviteId !== expected.inviteId || hash !== expected.oneTimeKeyHash || digest !== expected.credentialDigest) {
    return { ok: false, reason: 'claims-mismatch' };
  }

  const age = now - iat * 1000;
  if (age > POSSESSION_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  if (age < -FUTURE_SKEW_MS) return { ok: false, reason: 'future' };

  let publicKey;
  try {
    const x = ed25519PublicKeyOfDidKey(holderDid);
    publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') }, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'bad-holder' };
  }
  const valid = verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(sigB64, 'base64url'));
  return valid ? { ok: true, claims } : { ok: false, reason: 'bad-signature' };
}
