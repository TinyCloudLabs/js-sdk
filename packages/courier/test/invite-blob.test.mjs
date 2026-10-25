import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInviteId, buildInviteBlob, buildHello } from '../dist/invite-blob.js';
import { inviteEmailHash } from '../dist/invite-email-hash.js';
import { LINK_ISSUER } from './support/invite-link-fixture.mjs';
import { parseInviteBlob, parseHello, inviteFolder, CREDENTIAL_MAX_BYTES } from '../dist/invite-schema.js';

// A fixed clock: the build and the parse are both checked against it, so nothing here depends on the wall clock.
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const LATER = new Date(NOW + 24 * 3600e3);
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const ISSUED = new Date(NOW).toISOString();

const artifactA = () => ({
  type: 'courier-pair',
  v: 0,
  step: 'A',
  from: { owner: SAM_OWNER, courier: 'did:key:z6MkSamCourier', label: 'Sam' },
  spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  peer: 'hunter',
  callMe: 'sam',
  issuedAt: ISSUED,
});

const artifactB = () => ({
  type: 'courier-pair',
  v: 0,
  step: 'B',
  from: { owner: HUNTER_OWNER, courier: 'did:key:z6MkHunterCourier' },
  spaceId: `tinycloud:pkh:eip155:1:${HUNTER_ADDR}:agents`,
  peer: 'sam',
  callMe: 'hunter',
  delegation: 'DELEGATION-B',
  delegationExpiresAt: LATER.toISOString(),
  issuedAt: ISSUED,
});

const oneTimeKey = { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) };
const permissions = { put: 'PUT-DELEGATION', read: 'READ-DELEGATION', hooks: 'HOOKS-DELEGATION' };

test('newInviteId yields 26 lowercase base32 characters and differs per call', () => {
  const a = newInviteId();
  const b = newInviteId();
  assert.match(a, /^[a-z2-7]{26}$/);
  assert.match(b, /^[a-z2-7]{26}$/);
  assert.notEqual(a, b);
});

test('built invite blob parses back to the same fields and folder', () => {
  const inviteId = newInviteId();
  const text = buildInviteBlob({
    inviteId,
    host: 'https://node.example.test',
    spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
    oneTimeKey,
    permissions,
    artifactA: artifactA(),
    expiresAt: LATER,
    issuer: LINK_ISSUER,
    expectEmail: 'hunter@example.test',
    expectOwner: null,
    tier: 'strict',
    now: NOW,
  });
  const blob = parseInviteBlob(text, NOW);
  assert.equal(blob.inviteId, inviteId);
  assert.equal(blob.host, 'https://node.example.test');
  assert.equal(blob.folder, inviteFolder(inviteId));
  assert.equal(blob.expiresAt, LATER.toISOString());
  assert.equal(blob.expectEmailHash, inviteEmailHash(inviteId, 'hunter@example.test'));
  assert.equal(blob.issuer, LINK_ISSUER);
  assert.equal(text.includes('hunter@example.test'), false, 'the address is not in the blob');
  assert.deepEqual(blob.permissions, permissions);
  assert.equal(blob.artifactA.callMe, 'sam');
});

test('an invite blob whose expiry has passed is refused by the parser', () => {
  const text = buildInviteBlob({
    inviteId: newInviteId(),
    host: 'https://node.example.test',
    spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
    oneTimeKey,
    permissions,
    artifactA: artifactA(),
    expiresAt: LATER,
    issuer: LINK_ISSUER,
    expectEmail: 'hunter@example.test',
    expectOwner: null,
    tier: 'strict',
    now: NOW,
  });
  assert.equal(parseInviteBlob(text, LATER.getTime() - 1).inviteId.length, 26, 'one millisecond before expiry it parses');
  assert.throws(() => parseInviteBlob(text, LATER.getTime() + 1));
});

test('building an invite blob refuses a mixed-case expected email', () => {
  assert.throws(() => buildInviteBlob({
    inviteId: newInviteId(),
    host: 'https://node.example.test',
    spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
    oneTimeKey,
    permissions,
    artifactA: artifactA(),
    expiresAt: LATER,
    issuer: LINK_ISSUER,
    expectEmail: 'Hunter@Example.test',
    expectOwner: null,
    tier: 'strict',
    now: NOW,
  }));
});

test('built hello parses back with its credential and possession', () => {
  const inviteId = newInviteId();
  const text = buildHello({
    inviteId,
    artifactB: artifactB(),
    claimedLabel: 'Hunter',
    credential: 'proof-text',
    possession: 'sig-text',
    sentAt: new Date(NOW),
  });
  const hello = parseHello(text);
  assert.equal(hello.inviteId, inviteId);
  assert.equal(hello.claimedLabel, 'Hunter');
  assert.equal(hello.credential, 'proof-text');
  assert.equal(hello.possession, 'sig-text');
});

test('a hello without a credential carries neither credential nor possession', () => {
  const text = buildHello({
    inviteId: newInviteId(),
    artifactB: artifactB(),
    claimedLabel: 'Hunter',
    sentAt: new Date(NOW),
  });
  const hello = parseHello(text);
  assert.equal(hello.credential, undefined);
  assert.equal(hello.possession, undefined);
});

test('a credential over the cap is refused when the hello is built', () => {
  assert.throws(() => buildHello({
    inviteId: newInviteId(),
    artifactB: artifactB(),
    claimedLabel: 'Hunter',
    credential: 'x'.repeat(CREDENTIAL_MAX_BYTES + 1),
    sentAt: new Date(NOW),
  }));
});
