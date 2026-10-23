import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalDigest } from '@tinycloud/sdk-core';
import { verifyEmailProof, verifyEmailProofWithPin } from '../dist/verify-email-proof.js';
import { EMAIL_PROOF_PIN } from '../dist/credential-pin.js';
import { signPossession, oneTimeKeyHash } from '../dist/possession.js';
import { ed25519DidKey } from '../dist/did-key.js';

const NOW_MS = Date.UTC(2026, 4, 1, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const INVITE_ID = 'invite-1';
const ONE_TIME_KEY_X = 'otk-x-value';
const EMAIL = 'alice@example.com';

function b64u(value) {
  return Buffer.from(value).toString('base64url');
}

function generateEd25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicJwk, privateJwk: privateKey.export({ format: 'jwk' }) };
}

const issuer = generateEd25519();
const otherIssuer = generateEd25519();
const holder = generateEd25519();
const otherHolder = generateEd25519();
const holderDid = ed25519DidKey(holder.publicJwk.x);

// Test trust root: golden descriptor and identity, but the issuer key is one this test controls.
// Only verifyEmailProofWithPin accepts it. The production verifyEmailProof always uses EMAIL_PROOF_PIN.
const TEST_PIN = {
  ...EMAIL_PROOF_PIN,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: issuer.publicJwk.x },
};

function mint(overrides = {}) {
  const {
    signer = issuer.privateKey,
    kid = TEST_PIN.kid,
    iss = TEST_PIN.issuerDid,
    sub = holderDid,
    email = EMAIL,
    jti = 'cred-1',
    iat = NOW_S - 60,
    nbf = iat,
    exp = iat + 3600,
    extraPayload = {},
  } = overrides;
  const disclosure = b64u(JSON.stringify(['salt-1', 'email', email]));
  const digest = b64u(createHash('sha256').update(disclosure).digest());
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'vc+sd-jwt', kid }));
  const payload = b64u(JSON.stringify({
    iss,
    sub,
    jti,
    iat,
    nbf,
    exp,
    vct: TEST_PIN.descriptor.format.vct,
    profile: TEST_PIN.descriptor.profile,
    profileVersion: 1,
    descriptorDigest: TEST_PIN.descriptorDigest,
    _sd_alg: 'sha-256',
    _sd: [digest],
    holderBinding: { did: sub, signingDomain: 'tinycloud.credentials/holder-binding/v1' },
    ...extraPayload,
  }));
  const signature = b64u(nodeSign(null, Buffer.from(`${header}.${payload}`), signer));
  return `${header}.${payload}.${signature}~${disclosure}~`;
}

function possessionFor(credential, { key = holder.privateJwk, inviteId = INVITE_ID, now = NOW_MS } = {}) {
  return signPossession({ inviteId, oneTimeKeyX: ONE_TIME_KEY_X, credential }, key, now);
}

function verifyArgs(overrides = {}) {
  const credential = overrides.credential ?? mint();
  return {
    credential,
    possession: possessionFor(credential),
    expectEmail: EMAIL,
    holderDid,
    inviteId: INVITE_ID,
    oneTimeKeyHash: oneTimeKeyHash(ONE_TIME_KEY_X),
    now: NOW_MS,
    seenCredentials: new Set(),
    ...overrides,
  };
}

test('golden descriptor digest matches the pinned descriptorDigest', async () => {
  assert.equal(await canonicalDigest(EMAIL_PROOF_PIN.descriptor), EMAIL_PROOF_PIN.descriptorDigest);
});

test('valid credential and possession verify and return the normalized address', async () => {
  const result = await verifyEmailProofWithPin(verifyArgs(), TEST_PIN);
  assert.deepEqual(result, {
    ok: true,
    address: EMAIL,
    credentialId: 'cred-1',
    issuedAt: new Date((NOW_S - 60) * 1000).toISOString(),
  });
});

test('expected address is compared trimmed and case-insensitively', async () => {
  const result = await verifyEmailProofWithPin(verifyArgs({ expectEmail: '  Alice@Example.COM ' }), TEST_PIN);
  assert.equal(result.ok, true);
  assert.equal(result.address, EMAIL);
});

test('absent or empty credential is no-credential', async () => {
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential: undefined }), TEST_PIN), { ok: false, reason: 'no-credential' });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential: '' }), TEST_PIN), { ok: false, reason: 'no-credential' });
});

test('malformed credential is bad-format', async () => {
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential: 'not-a-jwt' }), TEST_PIN), { ok: false, reason: 'bad-format' });
});

test('credential whose kid is not the pinned kid is issuer-not-pinned', async () => {
  const credential = mint({ kid: 'did:web:evil.example#k1' });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'issuer-not-pinned' });
});

test('production verifyEmailProof rejects a credential whose kid is not pinned as issuer-not-pinned', async () => {
  const credential = mint({ kid: 'did:web:evil.example#k1' });
  assert.deepEqual(await verifyEmailProof(verifyArgs({ credential })), { ok: false, reason: 'issuer-not-pinned' });
});

test('production verifyEmailProof rejects a test-key credential under the pinned kid as bad-signature', async () => {
  // The pin is looked up by kid, so a credential under the pinned kid reaches the signature check
  // and fails there. It is not reported as issuer-not-pinned.
  const credential = mint();
  assert.deepEqual(await verifyEmailProof(verifyArgs({ credential })), { ok: false, reason: 'bad-signature' });
});

test('production verifyEmailProof ignores a pin smuggled into its input', async () => {
  const credential = mint();
  const result = await verifyEmailProof({ ...verifyArgs({ credential }), pin: TEST_PIN });
  assert.deepEqual(result, { ok: false, reason: 'bad-signature' });
});

test('signature by a different key under the pinned kid is bad-signature', async () => {
  const credential = mint({ signer: otherIssuer.privateKey });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'bad-signature' });
});

test('disclosure not covered by the signed _sd digests is bad-signature (documented sdk-code limit)', async () => {
  // The sdk reports this as VERIFICATION_FAILED, which maps to bad-signature. See the module header.
  const credential = mint({ extraPayload: { _sd: ['not-the-digest'] } });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'bad-signature' });
});

test('descriptor digest mismatch is descriptor-mismatch', async () => {
  const credential = mint({ extraPayload: { descriptorDigest: 'not-the-digest' } });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'descriptor-mismatch' });
});

test('credential past exp is expired', async () => {
  const credential = mint({ iat: NOW_S - 120, exp: NOW_S - 1 });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'expired' });
});

test('credential issued more than one hour ago is too-old even when exp is in the future', async () => {
  const credential = mint({ iat: NOW_S - 3601, exp: NOW_S + 3600 });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'too-old' });
});

test('credential issued in the future is from-the-future', async () => {
  const credential = mint({ iat: NOW_S + 60 });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'from-the-future' });
});

test('disclosed email differing from expectEmail is address-mismatch', async () => {
  assert.deepEqual(
    await verifyEmailProofWithPin(verifyArgs({ expectEmail: 'bob@example.com' }), TEST_PIN),
    { ok: false, reason: 'address-mismatch' },
  );
});

test('subject that is not a did:key is holder-mismatch', async () => {
  const credential = mint({ sub: 'did:web:example.com' });
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ credential }), TEST_PIN), { ok: false, reason: 'holder-mismatch' });
});

test('possession signed by a different holder key is bad-possession', async () => {
  const args = verifyArgs();
  args.possession = possessionFor(args.credential, { key: otherHolder.privateJwk });
  assert.deepEqual(await verifyEmailProofWithPin(args, TEST_PIN), { ok: false, reason: 'bad-possession' });
});

test('possession bound to a different invite is bad-possession', async () => {
  const args = verifyArgs();
  args.possession = possessionFor(args.credential, { inviteId: 'invite-other' });
  assert.deepEqual(await verifyEmailProofWithPin(args, TEST_PIN), { ok: false, reason: 'bad-possession' });
});

test('credential already seen for this invite is replayed', async () => {
  const result = await verifyEmailProofWithPin(verifyArgs({ seenCredentials: new Set([`cred-1:${INVITE_ID}`]) }), TEST_PIN);
  assert.deepEqual(result, { ok: false, reason: 'replayed' });
});

test('replay key is scoped to the invite', async () => {
  const result = await verifyEmailProofWithPin(verifyArgs({ seenCredentials: new Set(['cred-1:invite-other']) }), TEST_PIN);
  assert.equal(result.ok, true);
});

test('verification performs no network I/O', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('network disabled in test');
  };
  try {
    const result = await verifyEmailProofWithPin(verifyArgs(), TEST_PIN);
    assert.equal(result.ok, true);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a credential and possession for another holder than the hello names are holder-mismatch', async () => {
  const result = await verifyEmailProofWithPin(verifyArgs({ holderDid: ed25519DidKey(otherHolder.publicJwk.x) }), TEST_PIN);
  assert.deepEqual(result, { ok: false, reason: 'holder-mismatch' });
});

test('a holder DID with a key fragment still matches its bare did:key', async () => {
  const result = await verifyEmailProofWithPin(verifyArgs({ holderDid: `${holderDid}#${holderDid.slice('did:key:'.length)}` }), TEST_PIN);
  assert.equal(result.ok, true);
});

test('a missing holder DID is a reason code, not a thrown error', async () => {
  assert.deepEqual(await verifyEmailProofWithPin(verifyArgs({ holderDid: undefined }), TEST_PIN), { ok: false, reason: 'holder-mismatch' });
});
