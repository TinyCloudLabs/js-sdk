import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../dist/args.js';
import { requestedOwnerAndTier, inviteRecordsFor } from '../dist/invite-commands.js';
import { newInviteId, buildInviteBlob } from '../dist/invite-blob.js';
import { parseInviteBlob } from '../dist/invite-schema.js';
import { writePublicInvite } from '../dist/invite-public.js';

const NOW = Math.floor(Date.now() / 1000) * 1000;
const LATER = new Date(NOW + 24 * 3600e3);
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const ISSUED = new Date(NOW).toISOString();

const artifactA = () => ({
  type: 'courier-pair',
  v: 0,
  step: 'A',
  from: { owner: `did:pkh:eip155:1:${SAM_ADDR}`, courier: 'did:key:z6MkSamCourier', label: 'Sam' },
  spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  peer: 'hunter',
  callMe: 'sam',
  issuedAt: ISSUED,
});

const oneTimeKey = { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) };
const permissions = { put: 'PUT-DELEGATION', read: 'READ-DELEGATION', hooks: 'HOOKS-DELEGATION' };

const blobInput = (over = {}) => ({
  inviteId: newInviteId(),
  host: 'https://node.example.test',
  spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  oneTimeKey,
  permissions,
  artifactA: artifactA(),
  expiresAt: LATER,
  expectEmail: 'hunter@example.test',
  expectOwner: null,
  tier: 'strict',
  ...over,
});

const codeIs = (code) => (e) => e.code === code;

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'courier-create-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('requested owner and tier: no flags means no expected owner and a strict tier', () => {
  assert.deepEqual(requestedOwnerAndTier(parseArgs([])), { tier: 'strict', expectOwner: null });
});

test('requested owner and tier: --tier trusted and --expect-owner are carried as given', () => {
  const args = parseArgs(['--tier', 'trusted', '--expect-owner', HUNTER_OWNER]);
  assert.deepEqual(requestedOwnerAndTier(args), { tier: 'trusted', expectOwner: HUNTER_OWNER });
});

test('requested owner and tier: an unknown tier is refused as a usage error', () => {
  assert.throws(() => requestedOwnerAndTier(parseArgs(['--tier', 'bogus'])), codeIs('usage'));
});

test('requested owner and tier: a malformed expected owner is refused as a usage error', () => {
  assert.throws(() => requestedOwnerAndTier(parseArgs(['--expect-owner', 'bad'])), codeIs('usage'));
  assert.throws(() => requestedOwnerAndTier(parseArgs(['--expect-owner', `did:key:z6MkX`])), codeIs('usage'));
});

test('invite blob: expectOwner and tier survive a build and parse round-trip', () => {
  const text = buildInviteBlob(blobInput({ expectOwner: HUNTER_OWNER, tier: 'trusted' }));
  const blob = parseInviteBlob(text, NOW);
  assert.equal(blob.expectOwner, HUNTER_OWNER);
  assert.equal(blob.tier, 'trusted');
});

test('invite blob: no owner and a strict tier round-trip as null and strict', () => {
  const blob = parseInviteBlob(buildInviteBlob(blobInput()), NOW);
  assert.equal(blob.expectOwner, null);
  assert.equal(blob.tier, 'strict');
});

test('invite blob: a malformed expectOwner is refused by the parser', () => {
  const text = buildInviteBlob(blobInput());
  const tampered = JSON.parse(text);
  tampered.expectOwner = 'not-a-did';
  assert.throws(() => parseInviteBlob(JSON.stringify(tampered), NOW), /expectOwner must be null or a did:pkh:eip155 DID/);
});

test('invite blob: a tier outside strict and trusted is refused by the parser', () => {
  const tampered = JSON.parse(buildInviteBlob(blobInput()));
  tampered.tier = 'rejected';
  assert.throws(() => parseInviteBlob(JSON.stringify(tampered), NOW), /tier must be strict or trusted/);
});

test('create records: the private and public records carry the same expectOwner and tier', () => {
  const records = inviteRecordsFor({
    inviteId: newInviteId(),
    handle: 'hunter',
    callMe: 'sam',
    expectEmail: 'hunter@example.test',
    tier: 'trusted',
    expectOwner: HUNTER_OWNER,
    alsoAsk: false,
    expiresAt: LATER,
    createdAt: ISSUED,
    store: { id: 'store-id', cid: 'cid', deleteToken: 'token' },
    publicDir: undefined,
  });
  assert.equal(records.record.expectOwner, HUNTER_OWNER);
  assert.equal(records.record.tier, 'trusted');
  assert.equal(records.publicRecord.expectOwner, HUNTER_OWNER);
  assert.equal(records.publicRecord.tier, 'trusted');
});

test('create records: with no flags the public record shows null and strict', () => {
  const records = inviteRecordsFor({
    inviteId: newInviteId(),
    handle: 'hunter',
    callMe: 'sam',
    expectEmail: 'hunter@example.test',
    tier: 'strict',
    expectOwner: null,
    alsoAsk: false,
    expiresAt: LATER,
    createdAt: ISSUED,
    store: { id: 'store-id', cid: 'cid', deleteToken: 'token' },
    publicDir: undefined,
  });
  assert.equal(records.publicRecord.expectOwner, null);
  assert.equal(records.publicRecord.tier, 'strict');
});

test('create records: the public record written to disk reads back with the same expectOwner and tier', (t) => {
  const dir = tempDir(t);
  const { publicRecord } = inviteRecordsFor({
    inviteId: newInviteId(),
    handle: 'hunter',
    callMe: 'sam',
    expectEmail: 'hunter@example.test',
    tier: 'trusted',
    expectOwner: HUNTER_OWNER,
    alsoAsk: false,
    expiresAt: LATER,
    createdAt: ISSUED,
    store: { id: 'store-id', cid: 'cid', deleteToken: 'token' },
    publicDir: dir,
  });
  writePublicInvite(dir, publicRecord);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${publicRecord.inviteId}.json`), 'utf8'));
  assert.equal(onDisk.expectOwner, HUNTER_OWNER);
  assert.equal(onDisk.tier, 'trusted');
});
