import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import { InviteWatcher, peersEntryProblem, readRecord, recordPath } from '../dist/invite-watch.js';
import { inviteFolder } from '../dist/invite-schema.js';
import { newInviteId } from '../dist/invite-blob.js';
import { writeSecure } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

// peers.json is keyed by handle and holds the trust tier. A self-service pairing must never land on a handle that already has an entry.
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const NOW = Date.now();
const ISSUED = new Date(NOW).toISOString();
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const ALICE_OWNER = `did:pkh:eip155:1:0x${'a'.repeat(40)}`;
const MALLORY_OWNER = `did:pkh:eip155:1:0x${'b'.repeat(40)}`;
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const ALICE_COURIER = 'did:key:z6MkAliceCourier';
const MALLORY_COURIER = 'did:key:z6MkMalloryCourier';
const EMAIL = 'alice@example.test';
const C_ARTIFACT = { type: 'courier-pair', v: 0, step: 'C', from: { owner: SAM_OWNER, courier: SAM_COURIER }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'alice', callMe: 'sam', delegation: 'DELEGATION-C', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED };

let home;
let sentinel;
let saved;
let kv;
let accepted;

beforeEach(() => {
  home = fs.mkdtempSync(path.join('/var/tmp', 'courier-peers-guard-home-'));
  sentinel = fs.mkdtempSync(path.join('/var/tmp', 'courier-peers-guard-sentinel-'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME };
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  kv = memoryKv();
  accepted = [];
});

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sentinel, { recursive: true, force: true });
});

const peersFile = () => path.join(home, 'peers.json');
const writePeers = (value, file = peersFile()) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
};

function openInvite() {
  const inviteId = newInviteId();
  const { record } = inviteRecordsFor({
    inviteId, handle: 'alice', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: null, alsoAsk: false,
    expiresAt: new Date(NOW + 24 * 3600e3), createdAt: ISSUED,
    store: { id: 'store-1', cid: 'bafkrei' + 'a'.repeat(52), deleteToken: 'DELETE-TOKEN-FIXTURE' },
    publicDir: undefined,
  });
  writeSecure(recordPath(inviteId), storedRecord(record, 'hash-of-one-time-key'));
  return inviteId;
}

async function helloFrom(inviteId, { courier, owner }) {
  await kv.put(`${inviteFolder(inviteId)}in/hello.json`, {
    v: 1,
    inviteId,
    artifactB: {
      type: 'courier-pair', v: 0, step: 'B',
      from: { owner, courier },
      spaceId: `tinycloud:pkh:eip155:1:${owner.split(':').pop()}:agents`,
      peer: 'sam', callMe: 'alice', delegation: 'DELEGATION-B', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED,
    },
    claimedLabel: 'Alice',
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
    now: () => new Date(NOW),
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }),
    accept: async (_profile, _node, artifact) => { accepted.push(artifact.from.courier); return C_ARTIFACT; },
    deleteSealed: async () => undefined,
  });
}

const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;

test('peersEntryProblem: absent, listed, other handle, unreadable and non-object files', () => {
  const file = peersFile();
  assert.equal(peersEntryProblem('alice', [file]), undefined);
  writePeers({ alice: { tier: 'trusted' } });
  assert.equal(peersEntryProblem('alice', [file]), 'peers-entry-exists');
  assert.equal(peersEntryProblem('bob', [file]), undefined);
  writePeers('{ not json');
  assert.equal(peersEntryProblem('alice', [file]), 'peers-unreadable');
  writePeers('[]');
  assert.equal(peersEntryProblem('alice', [file]), 'peers-unreadable');
});

for (const [name, who] of [
  ['a reused handle with a different courier DID', { courier: MALLORY_COURIER, owner: MALLORY_OWNER }],
  ['a re-pair of the same courier DID under the same handle', { courier: ALICE_COURIER, owner: ALICE_OWNER }],
]) {
  test(`${name}: a trusted peers.json entry makes the hello held, nothing is paired or written`, async () => {
    writePeers({ alice: { tier: 'trusted' } });
    const id = openInvite();
    await helloFrom(id, who);
    await watcher().onHello(id);
    const record = readRecord(id);
    assert.equal(record.status, 'held');
    assert.equal(record.held.reason, 'peers-entry-exists');
    assert.equal(record.artifactC, undefined);
    assert.equal(record.completedPeer, undefined);
    assert.deepEqual(accepted, []);
    assert.equal(welcomeOf(id), undefined);
    assert.equal(fs.readFileSync(peersFile(), 'utf8'), JSON.stringify({ alice: { tier: 'trusted' } }));
  });

  test(`${name}: approve is refused with a stable code while the entry exists, and pairs strict once it is removed`, async () => {
    writePeers({ alice: { tier: 'trusted' } });
    const id = openInvite();
    await helloFrom(id, who);
    const w = watcher();
    await w.onHello(id);
    await assert.rejects(w.approve(id), (e) => e.code === 'peers-entry-exists');
    assert.equal(readRecord(id).status, 'held');
    assert.deepEqual(accepted, []);
    assert.equal(welcomeOf(id), undefined);

    writePeers({});
    assert.equal(await w.approve(id), 'strict');
    assert.equal(readRecord(id).status, 'completed');
    assert.deepEqual(accepted, [who.courier]);
    assert.equal(welcomeOf(id).tier, 'strict');
  });
}

test('an entry in the intake default location is seen too, and a malformed peers file fails closed', async () => {
  writePeers({ alice: { tier: 'strict' } }, path.join(home, 'intake', 'peers.json'));
  const id = openInvite();
  await helloFrom(id, { courier: ALICE_COURIER, owner: ALICE_OWNER });
  await watcher().onHello(id);
  assert.equal(readRecord(id).held.reason, 'peers-entry-exists');

  fs.rmSync(path.join(home, 'intake'), { recursive: true });
  writePeers('{ not json');
  const second = openInvite();
  await helloFrom(second, { courier: ALICE_COURIER, owner: ALICE_OWNER });
  await watcher().onHello(second);
  assert.equal(readRecord(second).held.reason, 'peers-unreadable');
  assert.deepEqual(accepted, []);
});

test('a handle without an entry still pairs on a valid hello', async () => {
  writePeers({ someone: { tier: 'trusted' } });
  const id = openInvite();
  await helloFrom(id, { courier: ALICE_COURIER, owner: ALICE_OWNER });
  await watcher().onHello(id);
  assert.equal(readRecord(id).status, 'completed');
  assert.deepEqual(accepted, [ALICE_COURIER]);
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home }, encoding: 'utf8' });
}

test('courier invite refuses a handle that has a peers.json entry before touching the profile', () => {
  writePeers({ hunter: { tier: 'trusted' } });
  const refused = runCli(['invite', 'hunter', '--email', 'hunter@example.test']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^courier: \[peers-entry-exists\]/);
  assert.equal(fs.existsSync(path.join(home, 'profile.json')), false);

  const free = runCli(['invite', 'other', '--email', 'hunter@example.test']);
  assert.match(free.stderr, /^courier: \[no-profile\]/);
});

test('courier invite --peers-file adds a custom location to the check', () => {
  const custom = path.join(home, 'gate', 'peers.json');
  writePeers({ hunter: { tier: 'trusted' } }, custom);
  const refused = runCli(['invite', 'hunter', '--email', 'hunter@example.test', '--peers-file', custom]);
  assert.match(refused.stderr, /^courier: \[peers-entry-exists\]/);
});
