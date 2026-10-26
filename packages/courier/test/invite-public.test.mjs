import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { publicInvitesDir, updatePublicInvite, writePublicInvite } from '../dist/invite-public.js';

const ID = 'abcdefghijklmnopqrstuvwxyz';

const record = (over = {}) => ({
  v: 1,
  inviteId: ID,
  handle: 'alice',
  expectEmail: 'alice@example.com',
  expectOwner: null,
  tier: 'strict',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  status: 'open',
  completedPeer: null,
  ...over,
});

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'courier-public-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const codeIs = (code) => (e) => e.code === code;

test('public invite: the record file is written with mode 0640', (t) => {
  const dir = tempDir(t);
  writePublicInvite(dir, record());
  assert.equal(fs.statSync(path.join(dir, `${ID}.json`)).mode & 0o777, 0o640);
});

test('public invite: a rewrite replaces the whole record and leaves no temp file behind', (t) => {
  const dir = tempDir(t);
  writePublicInvite(dir, record());
  writePublicInvite(dir, record({ handle: 'bob', tier: 'trusted' }));
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8')), record({ handle: 'bob', tier: 'trusted' }));
});

test('public invite: the public dir is resolved with the flag winning over the env var, and unset means none', () => {
  assert.equal(publicInvitesDir(undefined, undefined), undefined);
  assert.equal(publicInvitesDir(undefined, ''), undefined);
  assert.equal(publicInvitesDir(undefined, '/env/dir'), '/env/dir');
  assert.equal(publicInvitesDir('/flag/dir', '/env/dir'), '/flag/dir');
  assert.throws(() => publicInvitesDir('true', undefined), codeIs('usage'));
  assert.throws(() => publicInvitesDir('', undefined), codeIs('usage'));
});

test('public invite: a symlinked directory is refused and nothing is written through it', (t) => {
  const real = tempDir(t);
  const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
  fs.symlinkSync(real, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.throws(() => writePublicInvite(link, record()), codeIs('public-invite-refused'));
  assert.deepEqual(fs.readdirSync(real), []);
});

test('public invite: a symlinked record file is refused and its target is left alone', (t) => {
  const dir = tempDir(t);
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, path.join(dir, `${ID}.json`));
  assert.throws(() => writePublicInvite(dir, record()), codeIs('public-invite-refused'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('public invite: a record with an extra field is refused, including a delete token', (t) => {
  const dir = tempDir(t);
  assert.throws(() => writePublicInvite(dir, record({ deleteToken: 'secret' })), /unexpected fields deleteToken/);
  assert.throws(() => writePublicInvite(dir, record({ blobId: 'x' })), /unexpected fields blobId/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('public invite: a record missing a whitelisted field is refused', (t) => {
  const dir = tempDir(t);
  const { expectOwner, ...partial } = record();
  assert.throws(() => writePublicInvite(dir, partial), /missing fields expectOwner/);
});

test('public invite: an invite id that is not 26 lowercase base32 characters is refused', (t) => {
  const dir = tempDir(t);
  assert.throws(() => writePublicInvite(dir, record({ inviteId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' })), /inviteId must be 26/);
  assert.throws(() => writePublicInvite(dir, record({ inviteId: 'abc' })), /inviteId must be 26/);
  assert.throws(() => writePublicInvite(dir, record({ inviteId: 'abcdefghijklmnopqrstuvwxy0' })), /inviteId must be 26/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('public invite: an unknown status or a malformed completedPeer is refused', (t) => {
  const dir = tempDir(t);
  assert.throws(() => writePublicInvite(dir, record({ status: 'paid' })), /status must be one of/);
  assert.throws(() => writePublicInvite(dir, record({ completedPeer: { handle: 'bob' } })), /completedPeer must have exactly/);
});

test('public invite: revoke changes only the status and keeps every other field and the mode', (t) => {
  const dir = tempDir(t);
  writePublicInvite(dir, record());
  updatePublicInvite(dir, ID, { status: 'revoked' });
  const file = path.join(dir, `${ID}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record({ status: 'revoked' }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test('public invite: an update may not touch fields other than status and completedPeer', (t) => {
  const dir = tempDir(t);
  writePublicInvite(dir, record());
  assert.throws(() => updatePublicInvite(dir, ID, { handle: 'mallory' }), /patch may set only status and completedPeer/);
  assert.throws(() => updatePublicInvite(dir, ID, { deleteToken: 'x' }), /patch may set only status and completedPeer/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8')).handle, 'alice');
});

test('public invite: an update for a record that does not exist is refused', (t) => {
  const dir = tempDir(t);
  assert.throws(() => updatePublicInvite(dir, ID, { status: 'revoked' }), codeIs('public-invite-refused'));
  assert.deepEqual(fs.readdirSync(dir), []);
});
