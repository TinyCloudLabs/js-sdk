import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdInvite } from '../dist/invite-commands.js';
import { storedLink } from './support/invite-link-fixture.mjs';
import { writeSecure, secureSubdir } from '../dist/profile.js';

const INVITE_ID = 'a'.repeat(25) + 'b';
const OTHER_ID = 'a'.repeat(25) + 'c';
const DELETE_TOKEN = 'DELETE-TOKEN-SECRET-VALUE';

let home;
let logged;
const realLog = console.log;
const realWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-invrec-'));
  process.env.COURIER_HOME = home;
  logged = [];
  console.log = (...parts) => logged.push(parts.join(' '));
  process.stdout.write = (chunk) => {
    logged.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  console.log = realLog;
  process.stdout.write = realWrite;
  delete process.env.COURIER_HOME;
});

function args(positional) {
  return { positional, get: () => undefined, has: () => false, all: () => [] };
}

function writeRecord(id, overrides = {}) {
  const record = {
    v: 1,
    inviteId: id,
    handle: 'hunter',
    callMe: 'sam',
    email: 'hunter@example.test',
    tier: 'trusted',
    alsoAsk: false,
    expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    link: storedLink('store-id-1'),
    status: 'open',
    ...overrides,
  };
  writeSecure(path.join(secureSubdir('invites'), `${id}.json`), record);
  return record;
}

async function errorOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

test('invite list with no records prints an empty list', async () => {
  await cmdInvite(args(['list']));
  assert.equal(logged.join('\n').trim(), '[]');
});

test('invite list shows an open invite past its expiry as expired', async () => {
  writeRecord(INVITE_ID, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  await cmdInvite(args(['list']));
  const out = logged.join('\n');
  assert.match(out, new RegExp(INVITE_ID));
  assert.match(out, /expired/);
});

test('invite list never prints the delete token', async () => {
  writeRecord(INVITE_ID);
  await cmdInvite(args(['list']));
  assert.match(logged.join('\n'), new RegExp(INVITE_ID));
  assert.doesNotMatch(logged.join('\n'), new RegExp(DELETE_TOKEN));
});

test('revoking an already-revoked invite is a no-op notice', async () => {
  writeRecord(INVITE_ID, { status: 'revoked' });
  await cmdInvite(args(['revoke', INVITE_ID]));
  assert.match(logged.join('\n'), /already revoked/);
});

test('revoking a consumed invite is refused with invite-not-open', async () => {
  writeRecord(INVITE_ID, { status: 'consumed' });
  const err = await errorOf(cmdInvite(args(['revoke', INVITE_ID])));
  assert.equal(err.code, 'invite-not-open');
});

test('revoking an unknown invite id is a usage error', async () => {
  const err = await errorOf(cmdInvite(args(['revoke', OTHER_ID])));
  assert.equal(err.code, 'usage');
  assert.match(err.message, /No invite/);
});

test('revoking a malformed invite id is a usage error', async () => {
  const err = await errorOf(cmdInvite(args(['revoke', 'not-an-id'])));
  assert.equal(err.code, 'usage');
});
