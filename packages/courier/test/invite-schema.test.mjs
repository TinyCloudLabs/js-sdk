import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInviteBlob, parseHello, parseWelcome, ownerMatches, inviteFolder } from '../dist/invite-schema.js';
import { inviteEmailHash } from '../dist/invite-email-hash.js';
import { LINK_ISSUER } from './support/invite-link-fixture.mjs';

const NOW = Date.parse('2026-10-21T00:00:00.000Z');
const LATER = '2026-10-22T00:00:00.000Z';
const ISSUED = '2026-10-21T00:00:00.000Z';
const INVITE_ID = 'abcdefghijklmnopqrstuvwxyz';
const FOLDER = `xyz.tinycloud.courier/to/_invites/${INVITE_ID}/`;

const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';

const artifactA = () => ({
  type: 'courier-pair',
  v: 0,
  step: 'A',
  from: { owner: SAM_OWNER, courier: SAM_COURIER, label: 'Sam' },
  spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  peer: 'hunter',
  callMe: 'sam',
  issuedAt: ISSUED,
});

const artifactB = () => ({
  type: 'courier-pair',
  v: 0,
  step: 'B',
  from: { owner: HUNTER_OWNER, courier: HUNTER_COURIER },
  spaceId: `tinycloud:pkh:eip155:1:${HUNTER_ADDR}:agents`,
  peer: 'sam',
  callMe: 'hunter',
  delegation: 'DELEGATION-B',
  delegationExpiresAt: LATER,
  issuedAt: ISSUED,
});

const artifactC = () => ({
  type: 'courier-pair',
  v: 0,
  step: 'C',
  from: { owner: SAM_OWNER, courier: SAM_COURIER },
  spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  peer: 'hunter',
  callMe: 'sam',
  delegation: 'DELEGATION-C',
  delegationExpiresAt: LATER,
  issuedAt: ISSUED,
});

const blob = () => ({
  v: 1,
  inviteId: INVITE_ID,
  host: 'https://tee.node.tinycloud.xyz',
  spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  folder: FOLDER,
  helloKey: `${FOLDER}in/hello.json`,
  outPrefix: `${FOLDER}out/`,
  oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) },
  permissions: { put: 'PUT-DELEGATION', read: 'READ-DELEGATION', hooks: 'HOOKS-DELEGATION' },
  artifactA: artifactA(),
  expiresAt: LATER,
  issuer: LINK_ISSUER,
  expectEmailHash: inviteEmailHash(INVITE_ID, 'invitee@example.com'),
  expectOwner: null,
  tier: 'strict',
});

const hello = () => ({ v: 1, inviteId: INVITE_ID, artifactB: artifactB(), claimedLabel: 'Hunter Agent', sentAt: ISSUED });
const welcome = () => ({ v: 1, inviteId: INVITE_ID, tier: 'trusted-requested', artifactC: artifactC(), sentAt: ISSUED });

function assertRejects(parse, text, pattern) {
  assert.throws(
    () => parse(text),
    (err) => err.name === 'CourierError' && err.code === 'bad-invite-file' && pattern.test(err.message),
  );
}

/** Each row: [name, mutate(doc) → doc, reason pattern]. Mutations run on a fresh golden object. */
const BLOB_REJECTS = [
  ['missing v', (d) => { delete d.v; return d; }, /missing "v"|v must be 1/],
  ['v is 2', (d) => { d.v = 2; return d; }, /v must be 1/],
  ['missing inviteId', (d) => { delete d.inviteId; return d; }, /missing "inviteId"/],
  ['extra key', (d) => { d.extra = 1; return d; }, /unknown key "extra"/],
  ['inviteId uppercase', (d) => { d.inviteId = INVITE_ID.toUpperCase(); return d; }, /inviteId/],
  ['inviteId 25 chars', (d) => { d.inviteId = INVITE_ID.slice(1); return d; }, /inviteId/],
  ['host is http', (d) => { d.host = 'http://tee.node.tinycloud.xyz'; return d; }, /host must be a plain https URL/],
  ['host has a query', (d) => { d.host = 'https://tee.node.tinycloud.xyz/?q=1'; return d; }, /host must be a plain https URL/],
  ['host is not a URL', (d) => { d.host = 'tee node'; return d; }, /host is not a URL/],
  ['folder under another prefix', (d) => { d.folder = `xyz.tinycloud.other/to/_invites/${INVITE_ID}/`; return d; }, /folder is not the invite meeting folder/],
  ['folder for another invite', (d) => { d.folder = `xyz.tinycloud.courier/to/_invites/${'z'.repeat(26)}/`; return d; }, /folder is not the invite meeting folder/],
  ['folder outside _invites', (d) => { d.folder = `xyz.tinycloud.courier/to/${INVITE_ID}/`; return d; }, /folder is not the invite meeting folder/],
  ['helloKey wrong file', (d) => { d.helloKey = `${FOLDER}in/hello.txt`; return d; }, /helloKey is not the exact hello key/],
  ['helloKey wrong folder', (d) => { d.helloKey = `${FOLDER}in/x/hello.json`; return d; }, /helloKey is not the exact hello key/],
  ['outPrefix without slash', (d) => { d.outPrefix = `${FOLDER}out`; return d; }, /outPrefix is not the out\/ prefix/],
  ['oneTimeKey extra field', (d) => { d.oneTimeKey.extra = 'x'; return d; }, /oneTimeKey has unknown key "extra"/],
  ['oneTimeKey curve P-256', (d) => { d.oneTimeKey.crv = 'P-256'; return d; }, /Ed25519 OKP key/],
  ['oneTimeKey short d', (d) => { d.oneTimeKey.d = 'B'.repeat(42); return d; }, /oneTimeKey\.d has an invalid format/],
  ['permissions missing put', (d) => { delete d.permissions.put; return d; }, /permissions is missing "put"/],
  ['permissions missing read', (d) => { delete d.permissions.read; return d; }, /permissions is missing "read"/],
  ['permissions missing hooks', (d) => { delete d.permissions.hooks; return d; }, /permissions is missing "hooks"/],
  ['permissions extra key', (d) => { d.permissions.extra = 'X'; return d; }, /permissions has unknown key "extra"/],
  ['permissions.put not a string', (d) => { d.permissions.put = 42; return d; }, /permissions\.put must be a non-empty string/],
  ['permissions.read not a string', (d) => { d.permissions.read = ['x']; return d; }, /permissions\.read must be a non-empty string/],
  ['permissions.hooks not a string', (d) => { d.permissions.hooks = null; return d; }, /permissions\.hooks must be a non-empty string/],
  ['permissions.put over 16 KiB', (d) => { d.permissions.put = 'P'.repeat(16 * 1024 + 1); return d; }, /permissions\.put is over 16384 bytes/],
  ['permissions.read over 16 KiB', (d) => { d.permissions.read = 'R'.repeat(16 * 1024 + 1); return d; }, /permissions\.read is over 16384 bytes/],
  ['permissions.hooks over 16 KiB', (d) => { d.permissions.hooks = 'H'.repeat(16 * 1024 + 1); return d; }, /permissions\.hooks is over 16384 bytes/],
  ['permissions is the old string shape', (d) => { d.permissions = 'PERMISSION'; return d; }, /permissions must be an object/],
  ['old permission key still present', (d) => { d.permission = 'PERMISSION'; return d; }, /invite has unknown key "permission"/],
  ['artifactA is step B', (d) => { d.artifactA.step = 'B'; return d; }, /artifactA must be a courier-pair v0 step A/],
  ['artifactA carries a delegation', (d) => { d.artifactA.delegation = 'X'; return d; }, /artifactA has unknown key "delegation"/],
  ['artifactA owner not a DID', (d) => { d.artifactA.from.owner = 'sam@example'; return d; }, /artifactA: Artifact owner must be a did:pkh/],
  ['artifactA peer has a newline', (d) => { d.artifactA.peer = 'hun\nter'; return d; }, /control character/],
  ['spaceId differs from artifactA', (d) => { d.spaceId = `tinycloud:pkh:eip155:1:${HUNTER_ADDR}:agents`; return d; }, /spaceId does not match artifactA/],
  ['expiresAt without milliseconds', (d) => { d.expiresAt = '2026-10-22T00:00:00Z'; return d; }, /expiresAt must be an ISO UTC time/],
  ['expiresAt not a real date', (d) => { d.expiresAt = '2026-13-40T00:00:00.000Z'; return d; }, /expiresAt must be an ISO UTC time|expiresAt is not a real date/],
  ['expiresAt already past', (d) => { d.expiresAt = '2026-10-20T00:00:00.000Z'; return d; }, /invite is expired/],
  ['control character in spaceId', (d) => { d.spaceId = `${d.spaceId}\u0007`; return d; }, /spaceId has an invalid format|control character/],
  ['over 128 KiB file', (d) => { d.pad = 'x'.repeat(128 * 1024); return d; }, /invite file is over 131072 bytes/],
  ['expectEmailHash missing', (d) => { delete d.expectEmailHash; return d; }, /missing "expectEmailHash"/],
  ['the address in place of its hash', (d) => { d.expectEmailHash = 'invitee@example.com'; return d; }, /expectEmailHash has an invalid format/],
  ['expectEmailHash short', (d) => { d.expectEmailHash = d.expectEmailHash.slice(1); return d; }, /expectEmailHash has an invalid format/],
  ['expectEmailHash not canonical base64url', (d) => { d.expectEmailHash = `${d.expectEmailHash.slice(0, 42)}B`; return d; }, /expectEmailHash is not canonical base64url/],
  ['the old expectEmail key still present', (d) => { d.expectEmail = 'invitee@example.com'; return d; }, /unknown key "expectEmail"/],
  ['issuer missing', (d) => { delete d.issuer; return d; }, /missing "issuer"/],
  ['issuer is a did:web', (d) => { d.issuer = 'did:web:issuer.example'; return d; }, /issuer must be an Ed25519 did:key/],
  ['issuer is a did:key with a fragment', (d) => { d.issuer = `${LINK_ISSUER}#${LINK_ISSUER.slice(8)}`; return d; }, /issuer must be an Ed25519 did:key/],
  ['issuer is not a string', (d) => { d.issuer = 7; return d; }, /issuer must be an Ed25519 did:key/],
];

test('invite blob: golden object parses and keeps the exact fields', () => {
  const parsed = parseInviteBlob(JSON.stringify(blob()), NOW);
  assert.equal(parsed.folder, FOLDER);
  assert.equal(parsed.helloKey, `${FOLDER}in/hello.json`);
  assert.equal(parsed.outPrefix, `${FOLDER}out/`);
  assert.deepEqual(parsed.oneTimeKey, { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) });
  assert.deepEqual(parsed.permissions, { put: 'PUT-DELEGATION', read: 'READ-DELEGATION', hooks: 'HOOKS-DELEGATION' });
  assert.equal(parsed.artifactA.step, 'A');
  assert.equal(inviteFolder(INVITE_ID), FOLDER);
});

for (const [name, mutate, pattern] of BLOB_REJECTS) {
  test(`invite blob rejects: ${name}`, () => {
    assertRejects((text) => parseInviteBlob(text, NOW), JSON.stringify(mutate(blob())), pattern);
  });
}

test('invite blob rejects non-JSON, arrays, and duplicate keys', () => {
  assertRejects((t) => parseInviteBlob(t, NOW), '{not json', /not valid JSON/);
  assertRejects((t) => parseInviteBlob(t, NOW), '[]', /must be an object/);
  const dup = JSON.stringify(blob()).replace('"v":1', '"v":1,"v":1');
  assertRejects((t) => parseInviteBlob(t, NOW), dup, /duplicate key/);
  const nestedDup = JSON.stringify(blob()).replace('"peer":"hunter"', '"peer":"hunter","peer":"sam"');
  assertRejects((t) => parseInviteBlob(t, NOW), nestedDup, /duplicate key/);
});

test('invite blob: duplicate key check ignores escapes-looking text in string values', () => {
  const d = blob();
  d.permissions.put = '{"a":1,"a":2}';
  assert.equal(parseInviteBlob(JSON.stringify(d), NOW).permissions.put, '{"a":1,"a":2}');
});

const HELLO_REJECTS = [
  ['label has a newline', (d) => { d.claimedLabel = 'Hunter\nAgent'; return d; }, /control character/],
  ['label is a markdown link', (d) => { d.claimedLabel = '[Sam](https://example.com)'; return d; }, /claimedLabel has an invalid format/],
  ['label 65 chars', (d) => { d.claimedLabel = 'a'.repeat(65); return d; }, /claimedLabel is over 64 bytes/],
  ['label empty', (d) => { d.claimedLabel = ''; return d; }, /claimedLabel must be a non-empty string/],
  ['label missing', (d) => { delete d.claimedLabel; return d; }, /missing "claimedLabel"/],
  ['artifactB is step A', (d) => { d.artifactB.step = 'A'; return d; }, /artifactB must be a courier-pair v0 step B/],
  ['artifactB without delegation', (d) => { delete d.artifactB.delegation; return d; }, /artifactB is missing "delegation"/],
  ['artifactB owner malformed', (d) => { d.artifactB.from.owner = 'did:pkh:eip155:1:0x12'; return d; }, /artifactB: Artifact owner must be a did:pkh/],
  ['artifactB peer is not a handle', (d) => { d.artifactB.peer = 'sam peer'; return d; }, /artifactB\.peer has an invalid format/],
  ['unknown key', (d) => { d.note = 'x'; return d; }, /hello has unknown key "note"/],
  ['inviteId shape', (d) => { d.inviteId = 'short'; return d; }, /inviteId/],
  ['sentAt not ISO', (d) => { d.sentAt = 'yesterday'; return d; }, /sentAt must be an ISO UTC time/],
  ['v is 0', (d) => { d.v = 0; return d; }, /v must be 1/],
  ['control character in delegation', (d) => { d.artifactB.delegation = 'DELEG\u0000ATION'; return d; }, /control character/],
  ['artifactB.delegation over 16 KiB', (d) => { d.artifactB.delegation = 'D'.repeat(16 * 1024 + 1); return d; }, /artifactB\.delegation is over 16384 bytes/],
  ['credential over 16 KiB', (d) => { d.credential = 'C'.repeat(16 * 1024 + 1); return d; }, /credential is over 16384 bytes/],
  ['possession over 2 KiB', (d) => { d.possession = 'P'.repeat(2 * 1024 + 1); return d; }, /possession is over 2048 bytes/],
  ['whole hello over HELLO_MAX_BYTES', (d) => { d.artifactB.delegation = 'D'.repeat(16 * 1024); d.credential = 'C'.repeat(16 * 1024); d.possession = 'P'.repeat(2 * 1024); return d; }, /is over/],
  ['credential empty', (d) => { d.credential = ''; return d; }, /credential must be a non-empty string/],
  ['credential not a string', (d) => { d.credential = 7; return d; }, /credential must be a non-empty string/],
];

test('hello: golden object parses', () => {
  const parsed = parseHello(JSON.stringify(hello()));
  assert.equal(parsed.claimedLabel, 'Hunter Agent');
  assert.equal(parsed.artifactB.step, 'B');
});

test('hello: optional credential round-trips; absent credential stays absent', () => {
  assert.equal(parseHello(JSON.stringify({ ...hello(), credential: 'PROOF' })).credential, 'PROOF');
  assert.equal(Object.hasOwn(parseHello(JSON.stringify(hello())), 'credential'), false);
});

test('hello: optional possession round-trips; absent possession stays absent', () => {
  assert.equal(parseHello(JSON.stringify({ ...hello(), possession: 'PAYLOAD.SIG' })).possession, 'PAYLOAD.SIG');
  assert.equal(Object.hasOwn(parseHello(JSON.stringify(hello())), 'possession'), false);
});

for (const [name, mutate, pattern] of HELLO_REJECTS) {
  test(`hello rejects: ${name}`, () => {
    assertRejects(parseHello, JSON.stringify(mutate(hello())), pattern);
  });
}

test('hello rejects duplicate keys', () => {
  const dup = JSON.stringify(hello()).replace('"sentAt"', '"claimedLabel":"x","sentAt"');
  assertRejects(parseHello, dup, /duplicate key/);
});

test('welcome: trusted and strict carry artifact C; rejected carries none', () => {
  assert.equal(parseWelcome(JSON.stringify(welcome())).artifactC.step, 'C');
  const strict = { ...welcome(), tier: 'strict' };
  assert.equal(parseWelcome(JSON.stringify(strict)).tier, 'strict');
  const rejected = { v: 1, inviteId: INVITE_ID, tier: 'rejected', sentAt: ISSUED };
  const parsed = parseWelcome(JSON.stringify(rejected));
  assert.equal(parsed.tier, 'rejected');
  assert.equal(Object.hasOwn(parsed, 'artifactC'), false);
});

const WELCOME_REJECTS = [
  ['rejected with artifactC', (d) => { d.tier = 'rejected'; return d; }, /unknown key "artifactC"/],
  ['trusted without artifactC', (d) => { delete d.artifactC; return d; }, /missing "artifactC"/],
  ['tier open', (d) => { d.tier = 'open'; return d; }, /tier must be/],
  ['tier missing', (d) => { delete d.tier; return d; }, /tier must be strict/],
  ['artifactC is step B', (d) => { d.artifactC = artifactB(); return d; }, /artifactC must be a courier-pair v0 step C/],
  ['artifactC delegation missing', (d) => { delete d.artifactC.delegationExpiresAt; return d; }, /artifactC is missing "delegationExpiresAt"/],
  ['inviteId shape', (d) => { d.inviteId = INVITE_ID.toUpperCase(); return d; }, /inviteId/],
  ['sentAt bad', (d) => { d.sentAt = '2026-10-21'; return d; }, /sentAt must be an ISO UTC time/],
  ['extra key', (d) => { d.note = 'x'; return d; }, /welcome has unknown key "note"/],
  ['v is 2', (d) => { d.v = 2; return d; }, /v must be 1/],
  ['over 16 KiB', (d) => { d.artifactC.delegation = 'D'.repeat(16 * 1024); return d; }, /is over/],
];

for (const [name, mutate, pattern] of WELCOME_REJECTS) {
  test(`welcome rejects: ${name}`, () => {
    assertRejects(parseWelcome, JSON.stringify(mutate(welcome())), pattern);
  });
}

test('ownerMatches: same address in another case matches', () => {
  assert.equal(ownerMatches(SAM_OWNER, `did:pkh:eip155:1:${SAM_ADDR.toUpperCase().replace('0X', '0x')}`), true);
});

test('ownerMatches: different address does not match', () => {
  assert.equal(ownerMatches(SAM_OWNER, HUNTER_OWNER), false);
});

test('ownerMatches: same address on another chain does not match', () => {
  assert.equal(ownerMatches(SAM_OWNER, `did:pkh:eip155:137:${SAM_ADDR}`), false);
});

test('ownerMatches: malformed or non-string input does not match', () => {
  assert.equal(ownerMatches(SAM_OWNER, 'did:pkh:eip155:1:0x12'), false);
  assert.equal(ownerMatches(SAM_OWNER, SAM_COURIER), false);
  assert.equal(ownerMatches('sam', SAM_OWNER), false);
  assert.equal(ownerMatches(SAM_OWNER, undefined), false);
  assert.equal(ownerMatches(SAM_OWNER, `${SAM_OWNER} `), false);
});
