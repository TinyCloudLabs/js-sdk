// TC-2384: profile.json is shared by commands that hold a copy for minutes (`init --wait`) or days (`invite serve`).
// Saving that copy must keep every pairing, revocation and rotation another command made meanwhile; pending pairings expire;
// and a pairing that is already complete is never overwritten by a new artifact A.
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { AGENT_GRANT, COURIER_SPACE } from '../dist/keys.js';
import { LOCAL } from './support/lock-identity.mjs';
import { loadProfile, saveProfile, writeSecure } from '../dist/profile.js';

const HOME = process.env.COURIER_HOME;
const PROFILE = path.join(HOME, 'profile.json');
const DAY = 86_400_000;
const OWNER = 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001';
const onDisk = () => JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function peer(handle, status = 'paired', extra = {}) {
  return { handle, ownerDid: OWNER, courierDid: `did:key:z${handle}`, spaceId: 's', outbound: [], status, pairedAt: iso(0), ...extra };
}

function seed(peers = {}, extra = {}) {
  fs.rmSync(`${PROFILE}.lock`, { force: true });
  writeSecure(PROFILE, {
    version: 3, host: 'http://127.0.0.1:1', openkeyHost: 'https://openkey.so', label: 'courier · test', courierDid: 'did:key:zself',
    status: 'awaiting-grant', peers, ...extra,
  });
}

test('a stale copy saved by a long-running command keeps a pairing made meanwhile', () => {
  seed({ old: peer('old') });
  const waiter = loadProfile(); // `init --wait` holds this for minutes
  const pairer = loadProfile();
  pairer.peers.fresh = peer('fresh');
  saveProfile(pairer);

  waiter.ownerDid = OWNER; // the waiter's own change: the grant it collected
  waiter.status = 'ready';
  saveProfile(waiter);

  const saved = onDisk();
  assert.deepEqual(Object.keys(saved.peers).sort(), ['fresh', 'old']);
  assert.equal(saved.status, 'ready');
  assert.equal(saved.ownerDid, OWNER);
  assert.deepEqual(Object.keys(waiter.peers).sort(), ['fresh', 'old'], 'the saved copy reflects what is on disk');
});

test('a stale copy does not bring back a peer revoked meanwhile', () => {
  seed({ gone: peer('gone'), kept: peer('kept') });
  const server = loadProfile(); // `invite serve` holds this for days
  const revoker = loadProfile();
  delete revoker.peers.gone;
  saveProfile(revoker);

  server.peers.kept.label = 'renamed';
  saveProfile(server);

  const saved = onDisk();
  assert.deepEqual(Object.keys(saved.peers), ['kept']);
  assert.equal(saved.peers.kept.label, 'renamed');
});

test('a stale copy is refused after the agent key was rotated meanwhile', () => {
  seed({ old: peer('old') });
  const waiter = loadProfile();
  seed({}, { courierDid: 'did:key:znew' }); // `init --rotate-key`: new key, no peers
  waiter.status = 'ready';
  assert.throws(() => saveProfile(waiter), (e) => e.code === 'profile-changed');
  const saved = onDisk();
  assert.equal(saved.courierDid, 'did:key:znew');
  assert.deepEqual(saved.peers, {});
  assert.equal(saved.status, 'awaiting-grant');
});

test('concurrent renewals of the same peer keep every outbound delegation and the longest inbound one', () => {
  const t0 = Date.now() + 5 * DAY;
  seed({ p: peer('p', 'paired', { inbound: { delegation: 'd0', cid: 'c0', expiresAt: new Date(t0).toISOString() }, outbound: [{ cid: 'o0', issuedAt: iso(-DAY), expiresAt: iso(DAY) }] }) });
  const a = loadProfile();
  const b = loadProfile();
  b.peers.p.inbound = { delegation: 'd2', cid: 'c2', expiresAt: new Date(t0 + 2 * DAY).toISOString() };
  b.peers.p.outbound.push({ cid: 'o-b', issuedAt: iso(0), expiresAt: iso(7 * DAY) });
  saveProfile(b);
  a.peers.p.inbound = { delegation: 'd1', cid: 'c1', expiresAt: new Date(t0 + DAY).toISOString() }; // an older artifact imported last
  a.peers.p.outbound.push({ cid: 'o-a', issuedAt: iso(1), expiresAt: iso(7 * DAY) });
  saveProfile(a);

  const saved = onDisk().peers.p;
  assert.equal(saved.inbound.cid, 'c2', 'the shorter artifact must not replace the longer one');
  assert.deepEqual(saved.outbound.map((o) => o.cid).sort(), ['o-a', 'o-b', 'o0']);
});

test('saving a pairing start over a peer that completed pairing meanwhile is refused and keeps the pairing', () => {
  seed();
  const starter = loadProfile();
  const finisher = loadProfile();
  finisher.peers.bob = peer('bob');
  saveProfile(finisher);

  starter.peers.bob = peer('bob', 'awaiting-C');
  assert.throws(() => saveProfile(starter), (e) => e.code === 'usage' && /Already paired with bob/.test(e.message));
  assert.equal(onDisk().peers.bob.status, 'paired');
});

test('pending-A and awaiting-C pairings expire after 7 days; paired and fresh ones stay', () => {
  seed({
    staleA: peer('staleA', 'pending-A', { pairedAt: iso(-8 * DAY) }),
    staleC: peer('staleC', 'awaiting-C', { pairedAt: iso(-8 * DAY) }),
    freshA: peer('freshA', 'pending-A', { pairedAt: iso(-6 * DAY) }),
    freshC: peer('freshC', 'awaiting-C', { pairedAt: iso(-6 * DAY) }),
    oldPaired: peer('oldPaired', 'paired', { pairedAt: iso(-90 * DAY) }),
  });
  const profile = loadProfile();
  assert.deepEqual(Object.keys(profile.peers).sort(), ['freshA', 'freshC', 'oldPaired']);
  profile.label = 'touched';
  saveProfile(profile);
  assert.deepEqual(Object.keys(onDisk().peers).sort(), ['freshA', 'freshC', 'oldPaired']);
});

test('a lock left by a dead process does not block saving', async () => {
  seed();
  const dead = fork(fileURLToPath(new URL('./profile-concurrency-child.mjs', import.meta.url)), ['/nonexistent-start', 'x'], { execArgv: [] });
  const pid = dead.pid;
  dead.kill('SIGKILL');
  await new Promise((resolve) => dead.once('exit', resolve));
  fs.writeFileSync(`${PROFILE}.lock`, JSON.stringify({ ...LOCAL, pid, nonce: 'dead-holder' }), { mode: 0o600 });
  const profile = loadProfile();
  profile.label = 'after-crash';
  saveProfile(profile);
  assert.equal(onDisk().label, 'after-crash');
  assert.equal(fs.existsSync(`${PROFILE}.lock`), false, 'the lock is released');
});

test('commands saving at the same moment each keep their own pairing', async () => {
  seed();
  const start = path.join(HOME, 'start');
  fs.rmSync(start, { force: true });
  const script = fileURLToPath(new URL('./profile-concurrency-child.mjs', import.meta.url));
  const handles = Array.from({ length: 8 }, (_, i) => `peer${i}`);
  const children = handles.map((handle) => fork(script, [start, handle], { execArgv: [] }));
  await Promise.all(children.map((child) => new Promise((resolve) => child.once('message', resolve))));
  const exited = children.map((child) => new Promise((resolve, reject) => child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))));
  fs.writeFileSync(start, '1');
  await Promise.all(exited);
  assert.deepEqual(Object.keys(onDisk().peers).sort(), handles);
});

// ---- artifact A over an already paired peer (real CLI, loopback stub for the host's /delegate activation) ----

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const execFileAsync = promisify(execFile);
const wasm = new NodeWasmBindings();
const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/delegate') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ activated: ['agents'], skipped: [] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/invoke') {
    res.writeHead(200, { 'content-type': 'application/json', etag: '"stub-etag"' });
    res.end('{}');
    return;
  }
  res.writeHead(404).end('no such route');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
test.after(() => stub.close());
const HOST = `http://127.0.0.1:${stub.address().port}`;

const run = async (home, args) => JSON.parse((await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home, HOME: home }, encoding: 'utf8' })).stdout);
async function runFail(home, args) {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home, HOME: home }, encoding: 'utf8' });
  } catch (e) {
    return { stderr: String(e.stderr) };
  }
  throw new Error(`expected \`courier ${args.join(' ')}\` to fail`);
}

async function makeHome(name, handle, ownerPrivateKey) {
  const home = path.join(process.env.COURIER_TEST_HOME, 'pairing', name);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
  const signer = new PrivateKeySigner(ownerPrivateKey);
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const abilities = {};
  for (const permission of AGENT_GRANT) (abilities[permission.service.replace(/^tinycloud\./, '')] ??= {})[permission.path] = permission.actions;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * DAY);
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: now.toISOString(), expirationTime: expiresAt.toISOString(), spaceId, jwk: key.jwk });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt: expiresAt.toISOString(), receivedAt: now.toISOString() };
  const profile = { version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: `courier · ${name}`, selfHandle: handle, courierDid: key.did.split('#', 1)[0], ownerDid, spaceId, grantExpiresAt: grant.expiresAt, status: 'ready', peers: {} };
  for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) fs.writeFileSync(path.join(home, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return home;
}

test('accepting an artifact A that names an already paired peer is refused and leaves the pairing untouched', async () => {
  const wallet = randomBytes(32).toString('hex');
  const issuer = await makeHome('a-issuer', 'issuer', wallet);
  const receiver = await makeHome('a-receiver', 'receiver', wallet);
  const other = await makeHome('a-other', 'other', wallet);
  const artA = await run(issuer, ['pair', 'start', 'issuer-one', '--call-me', 'friend']);
  const artB = await run(receiver, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(issuer, ['pair', 'accept', JSON.stringify(artB)]);
  await run(receiver, ['pair', 'accept', JSON.stringify(artC)]);
  const before = JSON.parse(fs.readFileSync(path.join(receiver, 'profile.json'), 'utf8')).peers.friend;
  assert.equal(before.status, 'paired');

  const intruder = await run(other, ['pair', 'start', 'receiver-one', '--call-me', 'friend']);
  const refused = await runFail(receiver, ['pair', 'accept', JSON.stringify(intruder)]);
  assert.match(refused.stderr, /Already paired with friend/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(receiver, 'profile.json'), 'utf8')).peers.friend, before);
});
