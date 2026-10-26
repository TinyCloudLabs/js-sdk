// The peers.json guard on every path that creates a peer or a grant for a handle: the join side (the inviter picks the handle) and manual pair.
// A refusal happens before the profile or the node is touched, so these run with no profile and no network: success would end in [no-profile].
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimCallMe } from '../dist/invite-commands.js';
import { peersFilesFor } from '../dist/peers-guard.js';
import { secureSubdir } from '../dist/profile.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const ISSUED = new Date().toISOString();
const INVITER_OWNER = `did:pkh:eip155:1:0x${'1'.repeat(40)}`;
const INVITER_COURIER = 'did:key:z6MkInviterCourier';
const SPACE = `tinycloud:pkh:eip155:1:0x${'1'.repeat(40)}:agents`;

let home;
let saved;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-pair-guard-'));
  saved = process.env.COURIER_PEERS_FILE;
  delete process.env.COURIER_PEERS_FILE;
  process.env.COURIER_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.COURIER_PEERS_FILE;
  else process.env.COURIER_PEERS_FILE = saved;
  delete process.env.COURIER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const peersFile = (file = path.join(home, 'peers.json')) => file;
const writePeers = (value, file = peersFile()) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
};
const gate = () => path.join(home, 'gate', 'peers.json');

const blobFor = (callMe) => ({
  inviteId: 'a'.repeat(26),
  artifactA: { type: 'courier-pair', v: 0, step: 'A', from: { owner: INVITER_OWNER, courier: INVITER_COURIER }, spaceId: SPACE, peer: 'hunter', callMe, issuedAt: ISSUED },
});
const emptyProfile = () => ({ version: 3, host: 'https://n.example.test', openkeyHost: 'https://o.example.test', label: 'hunter', courierDid: 'did:key:z6MkMe', status: 'ready', peers: {} });

const artifact = (step, over = {}) => ({
  type: 'courier-pair', v: 0, step,
  from: { owner: INVITER_OWNER, courier: INVITER_COURIER, label: 'Sam' },
  spaceId: SPACE, peer: 'me', callMe: 'hunter', issuedAt: ISSUED,
  ...(step === 'A' ? {} : { delegation: 'DELEGATION', delegationExpiresAt: ISSUED }),
  ...over,
});

function runCli(args, { env = {}, input } = {}) {
  const e = { ...process.env, COURIER_HOME: home, ...env };
  if (!('COURIER_PEERS_FILE' in env)) delete e.COURIER_PEERS_FILE;
  return spawnSync(process.execPath, [CLI, ...args], { env: e, input, encoding: 'utf8' });
}
const noProfileYet = (r) => /^courier: \[no-profile\]/.test(r.stderr);

// join side
test('join: an inviter-picked handle that a peers file lists is refused before anything is created or dropped', () => {
  writePeers({ hunter: { tier: 'trusted' } });
  const profile = emptyProfile();
  const stale = { v: 1, inviteId: 'b'.repeat(26), blob: JSON.stringify(blobFor('hunter')), helloText: '{}', stage: 'hello-ready' };
  fs.writeFileSync(path.join(secureSubdir('joins'), `${stale.inviteId}.json`), JSON.stringify(stale), { mode: 0o600 });
  profile.peers.hunter = { handle: 'hunter', ownerDid: INVITER_OWNER, courierDid: INVITER_COURIER, spaceId: SPACE, outbound: [], theirHandleForMe: 'me', status: 'awaiting-C', pairedAt: ISSUED };
  const before = JSON.stringify(profile);
  assert.throws(() => claimCallMe(profile, blobFor('hunter'), peersFilesFor()), (e) => e.code === 'peers-entry-exists');
  assert.equal(JSON.stringify(profile), before);
  assert.equal(fs.existsSync(path.join(secureSubdir('joins'), `${stale.inviteId}.json`)), true);
});

test('join: an unreadable peers file refuses (peers-unreadable), a handle that is not listed passes', () => {
  writePeers('{ not json');
  assert.throws(() => claimCallMe(emptyProfile(), blobFor('hunter'), peersFilesFor()), (e) => e.code === 'peers-unreadable');
  writePeers({ someone: { tier: 'trusted' } });
  claimCallMe(emptyProfile(), blobFor('hunter'), peersFilesFor());
});

test('join: the default guard looks at COURIER_PEERS_FILE; --peers-file wins over it', () => {
  writePeers({ hunter: { tier: 'trusted' } }, gate());
  const other = path.join(home, 'other', 'peers.json');
  writePeers({}, other);
  process.env.COURIER_PEERS_FILE = gate();
  assert.throws(() => claimCallMe(emptyProfile(), blobFor('hunter')), (e) => e.code === 'peers-entry-exists');
  claimCallMe(emptyProfile(), blobFor('hunter'), peersFilesFor(other));
});

test('join: a peers file that cannot be read at all (a directory) refuses, not just one with bad JSON', () => {
  fs.mkdirSync(path.join(home, 'peers.json'));
  assert.throws(() => claimCallMe(emptyProfile(), blobFor('hunter'), peersFilesFor()), (e) => e.code === 'peers-unreadable');
});

test('join: the same guard applies without a file named: the defaults under COURIER_HOME', () => {
  writePeers({ hunter: { tier: 'strict' } }, path.join(home, 'intake', 'peers.json'));
  assert.throws(() => claimCallMe(emptyProfile(), blobFor('hunter')), (e) => e.code === 'peers-entry-exists');
});

test('join: a bad --peers-file stops the command before the invite is fetched', () => {
  const relative = runCli(['join', 'tcinvite1:x:y:z', '--peers-file', 'rel/peers.json']);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /^--peers-file must be an absolute path/);
  const missing = runCli(['join', 'tcinvite1:x:y:z', '--peers-file', path.join(home, 'typo.json')]);
  assert.match(missing.stderr, /^courier: \[peers-unreadable\]/);
});

// manual pair
test('pair start: a handle listed in a peers file is refused before the profile is read; nothing is written', () => {
  writePeers({ hunter: { tier: 'trusted' } });
  const r = runCli(['pair', 'start', 'hunter']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^courier: \[peers-entry-exists\]/);
  assert.equal(fs.existsSync(path.join(home, 'profile.json')), false);
  assert.ok(noProfileYet(runCli(['pair', 'start', 'someone-else'])));
});

test('pair start: COURIER_PEERS_FILE and --peers-file are honoured, an unreadable file refuses', () => {
  writePeers({ hunter: { tier: 'trusted' } }, gate());
  assert.match(runCli(['pair', 'start', 'hunter'], { env: { COURIER_PEERS_FILE: gate() } }).stderr, /^courier: \[peers-entry-exists\]/);
  assert.match(runCli(['pair', 'start', 'hunter', '--peers-file', gate()]).stderr, /^courier: \[peers-entry-exists\]/);
  writePeers('{ not json');
  assert.match(runCli(['pair', 'start', 'hunter']).stderr, /^courier: \[peers-unreadable\]/);
});

test('pair accept A: the handle the artifact asks us to use (callMe) is checked before a grant is minted', () => {
  writePeers({ hunter: { tier: 'trusted' } });
  const r = runCli(['pair', 'accept', '--stdin'], { input: JSON.stringify(artifact('A')) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^courier: \[peers-entry-exists\]/);
  assert.equal(fs.existsSync(path.join(home, 'profile.json')), false);
  assert.ok(noProfileYet(runCli(['pair', 'accept', '--stdin'], { input: JSON.stringify(artifact('A', { callMe: 'other' })) })));
});

test('pair accept B: the handle it pairs (--as, else callMe) is checked', () => {
  writePeers({ hunter: { tier: 'trusted' } });
  const viaCallMe = runCli(['pair', 'accept', '--stdin'], { input: JSON.stringify(artifact('B')) });
  assert.match(viaCallMe.stderr, /^courier: \[peers-entry-exists\]/);
  const viaAs = runCli(['pair', 'accept', '--stdin', '--as', 'hunter'], { input: JSON.stringify(artifact('B', { callMe: 'other' })) });
  assert.match(viaAs.stderr, /^courier: \[peers-entry-exists\]/);
  assert.ok(noProfileYet(runCli(['pair', 'accept', '--stdin', '--as', 'free'], { input: JSON.stringify(artifact('B')) })));
});

test('pair accept C only completes an existing pairing and is not blocked by the guard', () => {
  writePeers({ hunter: { tier: 'trusted' } });
  assert.ok(noProfileYet(runCli(['pair', 'accept', '--stdin'], { input: JSON.stringify(artifact('C')) })));
});
