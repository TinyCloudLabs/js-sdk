import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inviteRecordsFor, storedRecord, approveSummary } from '../dist/invite-commands.js';
import { storedLink } from './support/invite-link-fixture.mjs';
import { InviteWatcher, readRecord, recordPath } from '../dist/invite-watch.js';
import { inviteFolder } from '../dist/invite-schema.js';
import { newInviteId } from '../dist/invite-blob.js';
import { writeSecure } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

const NOW = Date.now();
const ISSUED = new Date(NOW).toISOString();
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';
const EMAIL = 'hunter@example.test';
const C_ARTIFACT = { type: 'courier-pair', v: 0, step: 'C', from: { owner: SAM_OWNER, courier: SAM_COURIER }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'hunter', callMe: 'sam', delegation: 'DELEGATION-C', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED };

let home;
let sentinel;
let saved;
let kv;
let accepts;
let clock;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-sweep-home-'));
  sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-sweep-sentinel-'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME };
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  kv = memoryKv();
  accepts = 0;
  clock = NOW;
});

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sentinel, { recursive: true, force: true });
});

function invite(over = {}) {
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

async function writeHello(inviteId) {
  await kv.put(`${inviteFolder(inviteId)}in/hello.json`, {
    v: 1,
    inviteId,
    artifactB: {
      type: 'courier-pair', v: 0, step: 'B',
      from: { owner: HUNTER_OWNER, courier: HUNTER_COURIER },
      spaceId: `tinycloud:pkh:eip155:1:${HUNTER_ADDR}:agents`,
      peer: 'sam', callMe: 'hunter', delegation: 'DELEGATION-B', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED,
    },
    claimedLabel: 'Hunter',
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
    notify: async () => undefined,
    now: () => new Date(clock),
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }),
    accept: async () => { accepts += 1; return C_ARTIFACT; },
    deleteLink: async () => undefined,
    peersFiles: [],
  });
}

const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;

test('a hello that no hook delivered is paired by the poll sweep', async () => {
  const id = invite();
  await writeHello(id);
  await watcher().sweep();
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(welcomeOf(id).tier, 'strict');
  assert.equal(accepts, 1);
});

test('a hello seen by the hook and again by sweeps pairs once', async () => {
  const id = invite();
  await writeHello(id);
  const w = watcher();
  await w.onHello(id);
  await w.sweep();
  await w.sweep();
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(accepts, 1);
});

test('two sweeps racing on one hello pair once', async () => {
  const id = invite();
  await writeHello(id);
  const w = watcher();
  await Promise.all([w.sweep(), w.sweep()]);
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(accepts, 1);
});

test('sweep leaves an open invite with no hello open, and still closes it at expiry', async () => {
  const id = invite();
  const w = watcher();
  await w.sweep();
  assert.equal(readRecord(id).status, 'open');
  clock = NOW + 25 * 3600e3;
  await w.sweep();
  assert.equal(readRecord(id).status, 'expired');
});

test('sweep does not process a hello for an invite that has already expired', async () => {
  const id = invite();
  await writeHello(id);
  clock = NOW + 25 * 3600e3;
  await watcher().sweep();
  assert.equal(readRecord(id).status, 'expired');
  assert.equal(accepts, 0);
});

test('approve returns the tier the record carries, and the summary shows the request not the flag', async () => {
  const id = invite({ tier: 'trusted', alsoAsk: true });
  await writeHello(id);
  const w = watcher();
  await w.sweep();
  assert.equal(readRecord(id).held.reason, 'also-ask');
  assert.equal(await w.approveHeld(id, HUNTER_OWNER), 'trusted-requested');
  assert.match(approveSummary(id, 'trusted-requested'), /Requested tier: trusted\. The peer starts as strict/);
  assert.match(approveSummary(id, 'strict'), /Requested tier: strict\. The peer starts as strict/);

  const second = invite({ tier: 'trusted', alsoAsk: true });
  await writeHello(second);
  await w.sweep();
  assert.equal(await w.approveHeld(second, HUNTER_OWNER, 'strict'), 'strict');
});

test('a second handler that finds the invite consumed leaves the hello in place while the first is still deciding', async () => {
  const id = invite();
  await writeHello(id);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = new InviteWatcher({
    node: { kv },
    profile: () => ({ version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: () => undefined,
    notify: async () => undefined,
    now: () => new Date(clock),
    verify: async () => { await gate; return { ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }; },
    accept: async () => { accepts += 1; return C_ARTIFACT; },
    deleteLink: async () => undefined,
    peersFiles: [],
  });
  const first = slow.onHello(id);
  const second = slow.onHello(id);
  await second;
  assert.equal(readRecord(id).status, 'consumed');
  assert.equal(kv.rows.has(`${inviteFolder(id)}in/hello.json`), true);
  release();
  await first;
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(accepts, 1);
});
