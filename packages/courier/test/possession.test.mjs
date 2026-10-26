import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { ed25519DidKey } from '../dist/did-key.js';
import {
  credentialDigest,
  oneTimeKeyHash,
  possessionPayload,
  signPossession,
  verifyPossession,
  POSSESSION_MAX_AGE_MS,
} from '../dist/possession.js';

const INVITE_ID = 'abcdefghijklmnopqrstuvwxyz';
const CREDENTIAL = 'eyJhbGciOiJFZERTQSJ9.payload.sig~disclosure';
const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);

function holder() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { jwk, did: ed25519DidKey(jwk.x) };
}

const oneTimeX = randomBytes(32).toString('base64url');
const expected = () => ({
  inviteId: INVITE_ID,
  oneTimeKeyHash: oneTimeKeyHash(oneTimeX),
  credentialDigest: credentialDigest(CREDENTIAL),
});

test('possession round trip verifies with the holder DID and returns the claims', () => {
  const h = holder();
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, NOW);
  const result = verifyPossession(sig, expected(), h.did, NOW + 1000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, { ...expected(), iat: Math.floor(NOW / 1000) });
});

test('possession verifies when the holder DID carries an SDK-style #fragment', () => {
  const h = holder();
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, NOW);
  assert.equal(verifyPossession(sig, expected(), `${h.did}#${h.did.slice(8)}`, NOW).ok, true);
});

test('a changed signed field breaks the signature', () => {
  const h = holder();
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, NOW);
  const [payloadB64, sigB64] = sig.split('.');
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const forgedId = 'zyxwvutsrqponmlkjihgfedcba';
  const forgedPayload = possessionPayload({ ...claims, inviteId: forgedId });
  const forged = `${Buffer.from(forgedPayload, 'utf8').toString('base64url')}.${sigB64}`;
  const result = verifyPossession(forged, { ...expected(), inviteId: forgedId }, h.did, NOW);
  assert.deepEqual(result, { ok: false, reason: 'bad-signature' });
});

test('a proof for a different credential or one-time key fails the claim check', () => {
  const h = holder();
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, NOW);
  const otherCred = verifyPossession(sig, { ...expected(), credentialDigest: credentialDigest('other') }, h.did, NOW);
  assert.deepEqual(otherCred, { ok: false, reason: 'claims-mismatch' });
  const otherKey = verifyPossession(sig, { ...expected(), oneTimeKeyHash: oneTimeKeyHash('other') }, h.did, NOW);
  assert.deepEqual(otherKey, { ok: false, reason: 'claims-mismatch' });
});

test('a proof older than 10 minutes is rejected as stale', () => {
  const h = holder();
  const iatMs = NOW - POSSESSION_MAX_AGE_MS - 1000;
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, iatMs);
  assert.deepEqual(verifyPossession(sig, expected(), h.did, NOW), { ok: false, reason: 'stale' });
});

test('a proof 9 minutes old is still accepted', () => {
  const h = holder();
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, NOW - 9 * 60 * 1000);
  assert.equal(verifyPossession(sig, expected(), h.did, NOW).ok, true);
});

test('a proof issued more than a minute in the future is rejected', () => {
  const h = holder();
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, NOW + 5 * 60 * 1000);
  assert.deepEqual(verifyPossession(sig, expected(), h.did, NOW), { ok: false, reason: 'future' });
});

test('a proof signed by a different key fails the signature check', () => {
  const signer = holder();
  const other = holder();
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, signer.jwk, NOW);
  assert.deepEqual(verifyPossession(sig, expected(), other.did, NOW), { ok: false, reason: 'bad-signature' });
});

test('malformed, oversize, and non-did:key inputs are rejected without throwing', () => {
  const h = holder();
  assert.deepEqual(verifyPossession('no-dot-here', expected(), h.did, NOW), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyPossession('a'.repeat(2049), expected(), h.did, NOW), { ok: false, reason: 'too-large' });
  const sig = signPossession({ inviteId: INVITE_ID, oneTimeKeyX: oneTimeX, credential: CREDENTIAL }, h.jwk, NOW);
  assert.deepEqual(verifyPossession(sig, expected(), 'did:web:example.com', NOW), { ok: false, reason: 'bad-holder' });
});
