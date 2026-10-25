import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import { storedLink } from './support/invite-link-fixture.mjs';
import { InviteWatcher, readRecord, recordPath } from '../dist/invite-watch.js';
import { inviteFolder, parseWelcome } from '../dist/invite-schema.js';
import { newInviteId } from '../dist/invite-blob.js';
import { writeSecure } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

// A record exactly as `invite create` writes it (inviteRecordsFor + storedRecord) must be accepted by the watcher.
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const ISSUED = '2026-10-21T00:00:00.000Z';
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const OTHER_OWNER = `did:pkh:eip155:1:0x${'1'.repeat(40)}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';
const EMAIL = 'hunter@example.test';
const C_ARTIFACT = { type: 'courier-pair', v: 0, step: 'C', from: { owner: SAM_OWNER, courier: SAM_COURIER }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'hunter', callMe: 'sam', delegation: 'DELEGATION-C', delegationExpiresAt: '2026-10-22T00:00:00.000Z', issuedAt: ISSUED };

let home;
let sentinel;
let saved;
let kv;
let notices;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-create-watch-home-'));
  sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-create-watch-sentinel-'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME };
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  kv = memoryKv();
  notices = [];
});

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sentinel, { recursive: true, force: true });
});

function createdRecord(over) {
  const inviteId = newInviteId();
  const { record } = inviteRecordsFor({
    inviteId, handle: 'hunter', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: null, alsoAsk: false,
    expiresAt: new Date(NOW + 24 * 3600e3), createdAt: ISSUED,
    link: storedLink('store-1'),
    publicDir: undefined,
    ...over,
  });
  writeSecure(recordPath(inviteId), storedRecord(record, 'hash-of-one-time-key'));
  return inviteId;
}

async function helloFor(inviteId) {
  await kv.put(`${inviteFolder(inviteId)}in/hello.json`, {
    v: 1,
    inviteId,
    artifactB: {
      type: 'courier-pair', v: 0, step: 'B',
      from: { owner: HUNTER_OWNER, courier: HUNTER_COURIER },
      spaceId: `tinycloud:pkh:eip155:1:${HUNTER_ADDR}:agents`,
      peer: 'sam', callMe: 'hunter', delegation: 'DELEGATION-B', delegationExpiresAt: '2026-10-22T00:00:00.000Z', issuedAt: ISSUED,
    },
    claimedLabel: 'Hunter Agent',
    sentAt: ISSUED,
    credential: 'CREDENTIAL-FIXTURE',
    possession: 'POSSESSION-FIXTURE',
  });
}

function watcher() {
  return new InviteWatcher({
    node: { kv },
    profile: () => ({ version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: () => undefined,
    notify: async (notice) => { notices.push(notice); },
    now: () => new Date(NOW),
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }),
    accept: async () => C_ARTIFACT,
    deleteLink: async () => undefined,
  });
}

const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;

test('a created record with no owner check and --tier strict pairs on a valid hello', async () => {
  const id = createdRecord({});
  assert.equal(Object.hasOwn(readRecord(id), 'expectOwner'), false);
  await helloFor(id);
  await watcher().onHello(id);
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(welcomeOf(id).tier, 'strict');
});

test('a created --tier trusted record pairs with a Welcome the invitee parses as trusted-requested, never trusted', async () => {
  const id = createdRecord({ tier: 'trusted' });
  assert.equal(readRecord(id).tier, 'trusted-requested');
  await helloFor(id);
  await watcher().onHello(id);
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(welcomeOf(id).tier, 'trusted-requested');
  assert.equal(parseWelcome(JSON.stringify(welcomeOf(id))).tier, 'trusted-requested');
  assert.equal(notices[0].invite.tier, 'trusted-requested');
});

test('a created record with --expect-owner holds a hello from another owner and pairs the matching owner', async () => {
  const mismatch = createdRecord({ expectOwner: OTHER_OWNER });
  await helloFor(mismatch);
  await watcher().onHello(mismatch);
  assert.equal(readRecord(mismatch).status, 'held');
  assert.equal(readRecord(mismatch).held.reason, 'owner-mismatch');
  assert.equal(welcomeOf(mismatch), undefined);

  const match = createdRecord({ expectOwner: HUNTER_OWNER });
  await helloFor(match);
  await watcher().onHello(match);
  assert.equal(readRecord(match).status, 'completed');
});
