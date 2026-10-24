/**
 * Email-proof credential verifier for the courier hello path.
 *
 * Each check stops at its first failure and returns one VerifyFailure reason.
 * sdk error mapping:
 *  - VERIFICATION_FAILED -> 'bad-signature'. The sdk uses this one code for the issuer signature,
 *    disclosure digests, claims digest, profile/holder-binding fields, requirement, and status.
 *    The code does not say which one failed, so a bad disclosure or claims digest also reports
 *    'bad-signature'. Known limit: splitting it needs distinct sdk codes, not message matching.
 *  - HOLDER_MISMATCH -> 'holder-mismatch' (envelope-to-session binding).
 *  - REQUEST_EXPIRED -> 'expired' (validity window; the sdk also uses it for iat/nbf/exp mismatches).
 *  - any other thrown error -> 'bad-format'. This can hide a bug; treat it as a signal to investigate.
 *
 * Trust: the issuer key comes only from the pinned trust root (credential-pin.ts). No network I/O.
 */
import {
  CREDENTIAL_ACQUISITION_PROTOCOL,
  CREDENTIAL_FORMAT,
  CredentialError,
  canonicalDigest,
  createEmailCredentialRequirement,
  verifyIssuedCredential,
  type CredentialIssuerMetadata,
  type IssuedCredentialEnvelope,
} from '@tinycloud/sdk-core';
import { EMAIL_PROOF_PIN, issuerKeyFor, type CredentialPin } from './credential-pin.js';
import { bareDid } from './authority.js';
import { ed25519PublicKeyOfDidKey } from './did-key.js';
import { credentialDigest, verifyPossession } from './possession.js';

/** Credentials issued more than this long ago are refused. Matches the email requirement's maxAgeSeconds. */
const MAX_CREDENTIAL_AGE_MS = 3600 * 1000;

/** Replay ledger: `has(replayKey)` is true when the caller has already consumed this credential for this invite. */
export interface SeenCredentials {
  has(replayKey: string): boolean;
}

export interface VerifyEmailProofInput {
  /** The credential string exactly as the invitee sent it in hello. */
  credential?: string;
  /** Possession proof from the same hello (see signPossession). */
  possession: string;
  expectEmail: string;
  /** The courier DID the hello asks to pair (`artifactB.from.courier`). The credential's subject and the possession key must be this DID. */
  holderDid: string;
  inviteId: string;
  /** sha256 hex of the one-time key `x` (see oneTimeKeyHash). */
  oneTimeKeyHash: string;
  /** Unix milliseconds. Defaults to Date.now(). */
  now?: number;
  seenCredentials: SeenCredentials;
}

export type VerifyFailure =
  | 'no-credential'
  | 'bad-format'
  | 'issuer-not-pinned'
  | 'descriptor-mismatch'
  | 'from-the-future'
  | 'expired'
  | 'too-old'
  | 'address-mismatch'
  | 'bad-signature'
  | 'holder-mismatch'
  | 'bad-possession'
  | 'replayed';

export type VerifyEmailProofResult =
  | { ok: true; address: string; credentialId: string; issuedAt: string }
  | { ok: false; reason: VerifyFailure };

/** Thrown internally to stop at the first failed check; mapped to a VerifyFailure in verifyEmailProof. */
class VerifyRejection extends Error {
  constructor(readonly reason: VerifyFailure) {
    super(reason);
  }
}

function reject(reason: VerifyFailure): never {
  throw new VerifyRejection(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function decodeObject(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!isRecord(parsed)) reject('bad-format');
  return parsed;
}

/**
 * The single `email` disclosure value. Each disclosure is base64url(JSON [salt, name, value]).
 * Unsigned here on purpose: the sdk verifies every disclosure against the signed `_sd` digests.
 */
function disclosedEmail(disclosures: readonly string[]): string {
  const emails: string[] = [];
  for (const disclosure of disclosures) {
    const item: unknown = JSON.parse(Buffer.from(disclosure, 'base64url').toString('utf8'));
    if (!Array.isArray(item) || item.length !== 3) reject('bad-format');
    const [, name, value]: unknown[] = item;
    if (name === 'email') {
      if (typeof value !== 'string') reject('bad-format');
      emails.push(value);
    }
  }
  const [email, ...others] = emails;
  if (email === undefined || others.length > 0) reject('bad-format');
  return email;
}

function failureOf(error: unknown): VerifyFailure {
  if (error instanceof VerifyRejection) return error.reason;
  if (error instanceof CredentialError) {
    if (error.code === 'VERIFICATION_FAILED') return 'bad-signature';
    if (error.code === 'HOLDER_MISMATCH') return 'holder-mismatch';
    if (error.code === 'REQUEST_EXPIRED') return 'expired';
  }
  return 'bad-format';
}

/**
 * Verifies an email-proof credential and the holder's possession proof. Pure: performs no network I/O.
 * The issuer key comes only from the pin; the descriptor digest and issuer identity are checked against it.
 * Records nothing: the caller marks the replay key consumed after a successful verification.
 */
export function verifyEmailProof(input: VerifyEmailProofInput): Promise<VerifyEmailProofResult> {
  return verifyEmailProofWithPin(input, EMAIL_PROOF_PIN);
}

/**
 * verifyEmailProof against an explicit trust root. Internal: tests use it with a test issuer key.
 * Not re-exported from index.ts; production code must call verifyEmailProof.
 */
export async function verifyEmailProofWithPin(
  input: VerifyEmailProofInput,
  pin: CredentialPin,
): Promise<VerifyEmailProofResult> {
  const { credential, possession, expectEmail, inviteId, oneTimeKeyHash, seenCredentials } = input;
  if (!credential) return { ok: false, reason: 'no-credential' };
  const nowMs = input.now ?? Date.now();
  try {
    if (typeof input.holderDid !== 'string') reject('holder-mismatch');
    const holder = bareDid(input.holderDid);
    const [jwt = '', ...rest] = credential.split('~');
    const disclosures = rest.filter(Boolean);
    const jwtParts = jwt.split('.');
    if (jwtParts.length !== 3) reject('bad-format');
    const header = decodeObject(jwtParts[0] ?? '');
    const payload = decodeObject(jwtParts[1] ?? '');

    const kid = header.kid;
    const issuerKey = typeof kid === 'string' ? issuerKeyFor(kid, pin) : null;
    if (typeof kid !== 'string' || issuerKey === null || payload.iss !== pin.issuerDid) reject('issuer-not-pinned');
    if (payload.descriptorDigest !== pin.descriptorDigest) reject('descriptor-mismatch');

    const { iat, nbf, exp, jti, sub, vct } = payload;
    if (typeof iat !== 'number' || typeof nbf !== 'number' || typeof exp !== 'number') reject('bad-format');
    if (typeof jti !== 'string' || typeof sub !== 'string' || typeof vct !== 'string') reject('bad-format');
    const issuedMs = iat * 1000;
    if (issuedMs > nowMs) reject('from-the-future');
    if (exp * 1000 <= nowMs) reject('expired');
    if (nowMs - issuedMs > MAX_CREDENTIAL_AGE_MS) reject('too-old');

    const email = disclosedEmail(disclosures);
    if (normalizeEmail(email) !== normalizeEmail(expectEmail)) reject('address-mismatch');

    try {
      ed25519PublicKeyOfDidKey(sub);
    } catch {
      reject('holder-mismatch');
    }
    if (bareDid(sub) !== holder) reject('holder-mismatch');

    const claims = { email };
    const envelope = {
      type: 'OpenCredentialsIssuedCredential',
      version: 1,
      protocol: CREDENTIAL_ACQUISITION_PROTOCOL,
      profile: { id: pin.descriptor.profile, version: 1 },
      credentialType: { id: pin.descriptor.format.vct, version: 1 },
      schema: pin.descriptor.format.vct,
      format: CREDENTIAL_FORMAT,
      issuerDid: pin.issuerDid,
      issuerKid: kid,
      subjectDid: sub,
      holderDid: holder,
      claims,
      claimsDigest: await canonicalDigest(claims),
      descriptorDigest: pin.descriptorDigest,
      credentialId: jti,
      issuedAt: new Date(issuedMs).toISOString(),
      notBefore: new Date(nbf * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
      // The pinned descriptor declares status.method 'none': there is no status list to consult.
      status: { method: 'none', freshnessSeconds: pin.descriptor.status.freshnessSeconds },
      credential,
    } satisfies IssuedCredentialEnvelope;

    // The pin is the only issuer key source: metadata is built from it, never fetched.
    const issuerMetadata = {
      type: 'OpenCredentialsIssuerMetadata',
      version: 1,
      origin: pin.descriptor.issuer.origin,
      issuerDid: pin.issuerDid,
      keys: [{ kid, alg: 'EdDSA', jwk: issuerKey, validFrom: pin.validFrom, validUntil: pin.validUntil }],
      cache: { maxAgeSeconds: 300, etag: 'pinned' },
    } satisfies CredentialIssuerMetadata;

    const verified = await verifyIssuedCredential({
      envelope,
      descriptor: pin.descriptor,
      descriptorDigest: pin.descriptorDigest,
      requirement: createEmailCredentialRequirement({
        email,
        profile: { id: pin.descriptor.profile, version: 1 },
        credentialType: { id: pin.descriptor.format.vct, version: 1 },
      }),
      holderDid: holder,
      issuerMetadata,
      now: new Date(nowMs),
      checkStatus: async () => true,
    });

    const possessionResult = verifyPossession(
      possession,
      { inviteId, oneTimeKeyHash, credentialDigest: credentialDigest(credential) },
      holder,
      nowMs,
    );
    if (!possessionResult.ok) reject('bad-possession');

    if (seenCredentials.has(`${verified.credentialId}:${inviteId}`)) reject('replayed');

    return { ok: true, address: normalizeEmail(email), credentialId: verified.credentialId, issuedAt: verified.issuedAt };
  } catch (error) {
    return { ok: false, reason: failureOf(error) };
  }
}
