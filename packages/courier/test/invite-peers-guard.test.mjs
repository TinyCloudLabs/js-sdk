import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import { InviteWatcher, peersEntryProblem, peersFilesFor, readRecord, recordPath } from '../dist/invite-watch.js';
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
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  delete process.env.COURIER_PEERS_FILE;
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

function runCli(args, extraEnv = {}) {
  const env = { ...process.env, COURIER_HOME: home };
  delete env.COURIER_PEERS_FILE;
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
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

// The gate's file lives outside COURIER_HOME. COURIER_PEERS_FILE lets every invite, approve and watch see it without a flag on each call.
const gateFile = () => path.join(home, 'gate', 'peers.json');

function watcherWith(files) {
  return new InviteWatcher({
    node: { kv },
    profile: () => ({ version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: () => undefined,
    notify: async () => undefined,
    now: () => new Date(NOW),
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }),
    accept: async (_profile, _node, artifact) => { accepted.push(artifact.from.courier); return C_ARTIFACT; },
    deleteSealed: async () => undefined,
    peersFiles: files,
  });
}

test('COURIER_PEERS_FILE: a reused handle listed in the gate file is held, both for a new DID and the same DID', async () => {
  writePeers({ alice: { tier: 'trusted' } }, gateFile());
  process.env.COURIER_PEERS_FILE = gateFile();
  for (const who of [{ courier: MALLORY_COURIER, owner: MALLORY_OWNER }, { courier: ALICE_COURIER, owner: ALICE_OWNER }]) {
    const id = openInvite();
    await helloFrom(id, who);
    await watcherWith(peersFilesFor()).onHello(id);
    assert.equal(readRecord(id).status, 'held');
    assert.equal(readRecord(id).held.reason, 'peers-entry-exists');
  }
  assert.deepEqual(accepted, []);
});

test('COURIER_PEERS_FILE is honoured by courier invite without any flag', () => {
  writePeers({ hunter: { tier: 'trusted' } }, gateFile());
  const refused = runCli(['invite', 'hunter', '--email', 'hunter@example.test'], { COURIER_PEERS_FILE: gateFile() });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^courier: \[peers-entry-exists\]/);
  const unset = runCli(['invite', 'hunter', '--email', 'hunter@example.test']);
  assert.match(unset.stderr, /^courier: \[no-profile\]/);
});

test('precedence: --peers-file wins over COURIER_PEERS_FILE; an empty COURIER_PEERS_FILE is unset', () => {
  const fromEnv = path.join(home, 'env', 'peers.json');
  const fromFlag = path.join(home, 'flag', 'peers.json');
  writePeers({ hunter: { tier: 'trusted' } }, fromEnv);
  writePeers({ other: { tier: 'strict' } }, fromFlag);
  process.env.COURIER_PEERS_FILE = fromEnv;
  assert.equal(peersFilesFor(fromFlag)[0].path, fromFlag);
  assert.equal(peersFilesFor(fromFlag).some((f) => f.path === fromEnv), false);
  assert.equal(peersFilesFor()[0].path, fromEnv);
  const withFlag = runCli(['invite', 'hunter', '--email', 'hunter@example.test', '--peers-file', fromFlag], { COURIER_PEERS_FILE: fromEnv });
  assert.match(withFlag.stderr, /^courier: \[no-profile\]/);
  process.env.COURIER_PEERS_FILE = '';
  assert.equal(peersFilesFor().length, 2);
});

test('an explicit peers file that is empty, relative or missing is an error, never ignored', () => {
  writePeers({ hunter: { tier: 'trusted' } }, gateFile());
  const base = ['invite', 'hunter', '--email', 'hunter@example.test'];
  const noValue = runCli([...base, '--peers-file']);
  assert.match(noValue.stderr, /^--peers-file needs a path/);
  const empty = runCli([...base, '--peers-file=']);
  assert.match(empty.stderr, /^--peers-file needs a path/);
  const relative = runCli([...base, '--peers-file', 'gate/peers.json']);
  assert.match(relative.stderr, /^--peers-file must be an absolute path/);
  const missing = runCli([...base, '--peers-file', path.join(home, 'gate', 'typo.json')]);
  assert.match(missing.stderr, /^courier: \[peers-unreadable\] --peers-file names a file that does not exist/);
  const envRelative = runCli(base, { COURIER_PEERS_FILE: 'gate/peers.json' });
  assert.match(envRelative.stderr, /^COURIER_PEERS_FILE must be an absolute path/);
  const envMissing = runCli(base, { COURIER_PEERS_FILE: path.join(home, 'gate', 'typo.json') });
  assert.match(envMissing.stderr, /^courier: \[peers-unreadable\] COURIER_PEERS_FILE names a file that does not exist/);
  for (const result of [noValue, empty, relative, envRelative]) assert.equal(result.status, 2);
  for (const result of [missing, envMissing]) assert.equal(result.status, 1);
});

test('a required peers file that disappears later refuses, while a missing default file is still no entry', () => {
  const gone = path.join(home, 'gate', 'gone.json');
  assert.equal(peersEntryProblem('alice', [{ path: gone, required: true }]), 'peers-unreadable');
  assert.equal(peersEntryProblem('alice', [{ path: gone, required: false }]), undefined);
  assert.equal(peersEntryProblem('alice', [gone]), undefined);
});

test('the unreadable-file refusal says the file cannot be read, not that it lists the handle', () => {
  writePeers('{ not json');
  const refused = runCli(['invite', 'hunter', '--email', 'hunter@example.test']);
  assert.match(refused.stderr, /^courier: \[peers-unreadable\]/);
  assert.match(refused.stderr, /missing or cannot be read as a JSON object/);
  assert.doesNotMatch(refused.stderr, /already lists this handle/);
});

test('the usage lines of invite and invite approve show --peers-file', () => {
  assert.match(runCli(['invite']).stderr, /\[--peers-file f\]/);
  assert.match(runCli(['invite', 'approve']).stderr, /invite approve <invite-id> \[--tier strict\|trusted\] \[--peers-file f\]/);
});

test('watch --install-systemd refuses a relative or missing --peers-file and carries COURIER_PEERS_FILE into the unit', () => {
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ version: 3, host: 'https://n.example.test', openkeyHost: 'https://o.example.test', label: 'x', courierDid: 'did:key:z6MkX', status: 'awaiting-grant', peers: {} }), { mode: 0o600 });
  writePeers({}, gateFile());
  const relative = runCli(['watch', '--install-systemd', '--dry-run', '--peers-file', 'gate/peers.json']);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /^--peers-file must be an absolute path/);
  const missing = runCli(['watch', '--install-systemd', '--dry-run', '--peers-file', path.join(home, 'gate', 'typo.json')]);
  assert.match(missing.stderr, /^courier: \[peers-unreadable\]/);
  const planned = runCli(['watch', '--install-systemd', '--dry-run'], { COURIER_PEERS_FILE: gateFile() });
  assert.equal(planned.status, 0);
  assert.match(planned.stdout, new RegExp(`COURIER_PEERS_FILE=${gateFile().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
