import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EMAIL_PROOF_PROFILE, EMAIL_PROOF_CREDENTIAL_TYPE, requestEmailProofCode } from '@tinycloud/node-sdk/credentials';
import { completeAgentShareReceive } from '@tinycloud/node-sdk/share-receive';
import { createEmailCredentialRequirement, credentialRequirementDigest } from '@tinycloud/sdk-core';
import { ShareReceiveError } from '@tinycloud/share-sdk';
import { receiveEmailInvitation } from '../dist/email-invitation.js';
import { PREFIX } from '../dist/keys.js';
import { saveProfile } from '../dist/profile.js';
import { ADDRESS, HOST, ISSUER_DID, LINK, OWNER, SPACE, identity, invitationBody, shareConfigResponse } from './support/email-invitation-fixture.mjs';
import { generateHolderKey, makeWitness } from './support/witness-stub.mjs';

const freshHome = () => mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'courier-otp-test-'));
const pendingFiles = (home) => readdirSync(join(home, 'credentials')).filter((file) => file.startsWith('pending-'));
const pendingFileFor = (requestId) => `pending-${createHash('sha256').update(requestId).digest('hex')}.json`;
const SHARE_ID = 'c'.repeat(32);
const RECIPIENT_OWNER = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';

/** profile.json and friends are written through the real store, which resolves the home from COURIER_HOME. */
function withHome(home, run) {
  const previous = process.env.COURIER_HOME;
  process.env.COURIER_HOME = home;
  try { return run(); } finally { if (previous === undefined) delete process.env.COURIER_HOME; else process.env.COURIER_HOME = previous; }
}

const REAL_PROFILE = { id: DEFAULT_EMAIL_PROOF_PROFILE, version: 1 };
const REAL_REQUIREMENT = {
  profile: REAL_PROFILE, credentialType: EMAIL_PROOF_CREDENTIAL_TYPE,
  requirementDigest: await credentialRequirementDigest(createEmailCredentialRequirement({ email: ADDRESS, profile: REAL_PROFILE, credentialType: EMAIL_PROOF_CREDENTIAL_TYPE })),
};

/** The signed envelope fields the recipient can read before it enters a code. */
function envelopeFor(body, over = {}) {
  return {
    version: 3, shareId: SHARE_ID,
    recipientMatcher: { kind: 'exactEmail', value: ADDRESS },
    resource: { kind: 'exact', path: `${PREFIX}/to/invite-${body.id}/envelope/${SHARE_ID}.json` },
    target: { origin: HOST, nodeAudience: 'did:key:z6MkNode', spaceId: SPACE },
    policy: { ownerDid: ISSUER_DID, schema: 'xyz.tinycloud.policy/policy/v2', credentialRequirement: REAL_REQUIREMENT },
    expiry: body.expiresAt,
    ...over,
  };
}

/**
 * receiveEmailInvitation with the REAL pending store, the REAL witness request, the REAL witness rejection of a wrong
 * code (the stub witness) and the REAL profile/join-state files. Only what the stub cannot pass is stood in: resolving
 * the Share link, the decrypt, and opening the node (the grant check needs a node).
 */
function setup({ maxAttempts, outcome, body = invitationBody(), envelope, bodyOver, profileOver, nodeError } = {}) {
  const home = freshHome();
  const holder = generateHolderKey();
  const witness = makeWitness({ maxAttempts });
  const calls = { complete: [], order: [] };
  const signed = typeof envelope === 'function' ? envelope(body, holder.bare) : envelope ?? envelopeFor(body);
  const sent = bodyOver ? { ...body, ...(typeof bodyOver === 'function' ? bodyOver(body) : bodyOver) } : body;
  withHome(home, () => saveProfile({
    version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: 'recipient', courierDid: holder.bare, ownerDid: RECIPIENT_OWNER,
    spaceId: SPACE.replace(OWNER.split(':').at(-1), RECIPIENT_OWNER.split(':').at(-1)), grantExpiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    status: 'ready', peers: {}, ...profileOver,
  }));
  const deps = {
    home,
    loadKey: () => ({ v: 1, jwk: holder.jwk, did: holder.bare, createdAt: '2026-10-20T10:00:00Z' }),
    fetch: async (input, init) => (String(input).endsWith('/.well-known/tinycloud-share/config.json') ? shareConfigResponse() : witness.fetch(input, init)),
    out: () => {},
    err: () => {},
    node: async () => { calls.order.push('node'); if (nodeError) throw nodeError; return {}; },
    receive: {
      request: async (_link, options) => ({ metadata: {}, envelope: signed, proof: await requestEmailProofCode({ address: ADDRESS, holder: options.holder, fetch: options.fetch }) }),
      resume: async (_link, findPending) => {
        const proof = await findPending(ADDRESS);
        if (proof === undefined) throw new ShareReceiveError('authorization-denied', 'no pending email proof for this share');
        return { metadata: {}, envelope: signed, proof };
      },
      complete: async (pending, code, options) => {
        calls.order.push('complete');
        calls.complete.push(code);
        // A wrong code goes through the SHIPPED `@tinycloud/node-sdk/share-receive` entrypoint to the stub witness and fails
        // there, recoverably or terminally, with that bundle's own EmailProofError class.
        if (code !== witness.code) return completeAgentShareReceive(pending, code, options);
        if (outcome === 'decrypt-failed') throw new ShareReceiveError('decrypt-failed', 'share content could not be opened');
        if (typeof outcome === 'function') outcome(home);
        return { text: JSON.stringify(sent), bytes: new Uint8Array(), mediaType: 'application/json', untrusted: true, metadata: {} };
      },
    },
  };
  return { home, body, witness, deps, calls, withCode: (code) => ({ ...deps, readStdinLine: async () => code }) };
}

test('step 1 stores one owner-only pending proof and returns no invitation', async () => {
  const { home, witness, deps } = setup();
  assert.equal(await receiveEmailInvitation(LINK, false, deps), undefined);
  const [requestId] = witness.reqs.keys();
  assert.deepEqual(pendingFiles(home), [pendingFileFor(requestId)]);
});

test('a recoverable rejection keeps the pending proof; the retry with the right code opens the invitation and spends it', async () => {
  const { home, witness, deps, calls, withCode } = setup();
  await receiveEmailInvitation(LINK, false, deps);
  const [requestId] = witness.reqs.keys();

  const failure = await receiveEmailInvitation(LINK, true, withCode('00000000')).then(() => undefined, (error) => error);
  assert.match(failure?.code ?? '', /^credential\.code\./, 'mapped like `credential acquire`');
  assert.match(failure.message, /Retry with `[^`]*--code-stdin` before 20\d\d-/);
  assert.doesNotMatch(failure.message, /00000000/, 'the code is never echoed');
  assert.deepEqual(pendingFiles(home), [pendingFileFor(requestId)], 'the same pending proof is still there');

  const body = await receiveEmailInvitation(LINK, true, withCode(witness.code));
  assert.equal(body?.recipient, ADDRESS);
  assert.deepEqual(calls.complete, ['00000000', witness.code]);
  assert.deepEqual(pendingFiles(home), [], 'success consumes the proof');
});

test('a non-recoverable failure (attempts exhausted) deletes the pending proof; a later code needs a new request', async () => {
  const { home, witness, deps, withCode } = setup({ maxAttempts: 1 });
  await receiveEmailInvitation(LINK, false, deps);
  const failure = await receiveEmailInvitation(LINK, true, withCode('00000000')).then(() => undefined, (error) => error);
  assert.match(failure?.code ?? '', /^credential\.code\./);
  assert.doesNotMatch(failure.message, /Retry with/);
  assert.deepEqual(pendingFiles(home), []);
  await assert.rejects(receiveEmailInvitation(LINK, true, withCode(witness.code)), { code: 'share.authorization-denied' });
});

test('after the code was accepted, a later failure (decrypt) still spends the pending proof', async () => {
  const { home, witness, deps, withCode } = setup({ outcome: 'decrypt-failed' });
  await receiveEmailInvitation(LINK, false, deps);
  await assert.rejects(receiveEmailInvitation(LINK, true, withCode(witness.code)), { code: 'share.decrypt-failed' });
  assert.deepEqual(pendingFiles(home), []);
});

test('a malformed code is refused before the pending proof or the witness is touched', async () => {
  const { home, witness, deps, calls, withCode } = setup();
  await receiveEmailInvitation(LINK, false, deps);
  const [requestId] = witness.reqs.keys();
  await assert.rejects(receiveEmailInvitation(LINK, true, withCode('12ab')), { code: 'credential.code.CODE_INVALID' });
  assert.deepEqual(calls.complete, []);
  assert.deepEqual(pendingFiles(home), [pendingFileFor(requestId)]);
});

// ---- preflight: everything local that can be refused before the one-time code is spent ----

test('a valid preflight opens the profile node first, then spends the code, and returns the verified body', async () => {
  const { witness, deps, calls, withCode } = setup();
  await receiveEmailInvitation(LINK, false, deps);
  const body = await receiveEmailInvitation(LINK, true, withCode(witness.code));
  assert.equal(body?.recipient, ADDRESS);
  assert.deepEqual(calls.order, ['node', 'complete']);
});

const REFUSALS = [
  ['an expired envelope', { envelope: (body) => envelopeFor(body, { expiry: new Date(Date.now() - 1000).toISOString() }) }, 'invite-expired'],
  ['a share that is not a Courier invitation path', { envelope: (body) => envelopeFor(body, { resource: { kind: 'exact', path: 'shares/x/note.txt' } }) }, 'bad-invitation'],
  ['a prefix resource', { envelope: (body) => envelopeFor(body, { resource: { kind: 'prefix', path: `${PREFIX}/to/invite-${body.id}/envelope/` } }) }, 'bad-invitation'],
  ['a resource path whose share id is not the envelope share id', { envelope: (body) => envelopeFor(body, { shareId: 'd'.repeat(32) }) }, 'bad-invitation'],
  ['another node host than this profile', { envelope: (body) => envelopeFor(body, { target: { origin: 'https://other-node.example', nodeAudience: 'did:key:z6MkNode', spaceId: SPACE } }) }, 'bad-invitation'],
  ['this agent as the issuer', { envelope: (body, holder) => envelopeFor(body, { policy: { ownerDid: holder } }) }, 'bad-invitation'],
  ['a missing or unusable grant (the node cannot be opened)', { nodeError: Object.assign(new Error('The Courier grant expired'), { code: 'grant-expired' }) }, 'grant-expired'],
  ['an already joined invitation', { joined: true }, 'invite-used'],
];

for (const [name, options, code] of REFUSALS) {
  test(`preflight refuses ${name} before the code reaches the witness, and keeps the pending proof`, async () => {
    const body = invitationBody();
    const { home, witness, deps, calls, withCode } = setup({ body, envelope: options.envelope, nodeError: options.nodeError });
    await receiveEmailInvitation(LINK, false, deps);
    const [requestId] = witness.reqs.keys();
    if (options.joined) {
      mkdirSync(join(home, 'invitation-joins'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'invitation-joins', `${body.id}.json`), JSON.stringify({ invitationHash: 'h', claim: {}, joined: true }), { mode: 0o600 });
    }
    await assert.rejects(receiveEmailInvitation(LINK, true, withCode(witness.code)), { code });
    assert.deepEqual(calls.complete, [], 'the witness never saw the code');
    assert.deepEqual(pendingFiles(home), [pendingFileFor(requestId)], 'the pending proof is intact for a retry');
  });
}

// ---- after decrypt: the encrypted body must match what the signed envelope already said ----

// Each body is internally valid (its own artifact matches its own id and issuer): only the envelope can tell it is wrong.
const OTHER_ID = '01M6AQSXVWMJD184HKR0RA4SD9';
const MISMATCHES = [
  ['another invitation id', (body) => ({ id: OTHER_ID, artifact: { ...body.artifact, peer: `chat-${OTHER_ID}-recipient`, callMe: `chat-${OTHER_ID}-issuer` } })],
  ['another node host', () => ({ host: 'https://other-node.example' })],
  ['another issuer', (body) => { const other = identity('other-issuer').did; return { issuer: other, artifact: { ...body.artifact, from: { ...body.artifact.from, courier: other } } }; }],
  ['another expiry', () => ({ expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 7_200_000).toISOString() })],
];

for (const [name, over] of MISMATCHES) {
  test(`a decrypted body with ${name} is refused, and the spent proof is gone`, async () => {
    const { home, witness, deps, calls, withCode } = setup({ bodyOver: over });
    await receiveEmailInvitation(LINK, false, deps);
    await assert.rejects(receiveEmailInvitation(LINK, true, withCode(witness.code)), (error) => ['bad-invitation'].includes(error.code));
    assert.equal(calls.complete.length, 1);
    assert.deepEqual(pendingFiles(home), []);
  });
}

test('a decrypted body whose artifact space is not the envelope target space is refused, and the spent proof is gone', async () => {
  // The body is valid on its own (its space belongs to its owner); only the SIGNED envelope says it is the wrong space.
  const { home, witness, deps, calls, withCode } = setup({
    envelope: (body) => envelopeFor(body, { target: { origin: HOST, nodeAudience: 'did:key:z6MkNode', spaceId: SPACE.replace('agents', 'elsewhere') } }),
  });
  await receiveEmailInvitation(LINK, false, deps);
  await assert.rejects(receiveEmailInvitation(LINK, true, withCode(witness.code)), { code: 'bad-invitation' });
  assert.equal(calls.complete.length, 1);
  assert.deepEqual(pendingFiles(home), []);
});

test('a differently cased space id is a different resource: the body is refused, and the spent proof is gone', async () => {
  // The space id is a canonical resource identifier used verbatim as a KV space path: no case folding.
  for (const spaceId of [SPACE.toLowerCase(), SPACE.toUpperCase()]) {
    assert.notEqual(spaceId, SPACE);
    const { home, witness, deps, calls, withCode } = setup({
      envelope: (body) => envelopeFor(body, { target: { origin: HOST, nodeAudience: 'did:key:z6MkNode', spaceId } }),
    });
    await receiveEmailInvitation(LINK, false, deps);
    await assert.rejects(receiveEmailInvitation(LINK, true, withCode(witness.code)), { code: 'bad-invitation' });
    assert.equal(calls.complete.length, 1);
    assert.deepEqual(pendingFiles(home), []);
  }
});

test('the join state is checked again after decrypt: an invitation joined meanwhile is refused', async () => {
  const body = invitationBody();
  const { witness, deps, withCode } = setup({
    body,
    outcome: (home) => {
      mkdirSync(join(home, 'invitation-joins'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'invitation-joins', `${body.id}.json`), JSON.stringify({ invitationHash: 'h', claim: {}, joined: true }), { mode: 0o600 });
    },
  });
  await receiveEmailInvitation(LINK, false, deps);
  await assert.rejects(receiveEmailInvitation(LINK, true, withCode(witness.code)), { code: 'invite-used' });
});
