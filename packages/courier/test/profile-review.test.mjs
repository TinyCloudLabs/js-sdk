// TC-2384 review findings: a stale command never leaves a half-applied result behind.
//  1. a command that outlived `init --rotate-key` never writes the old key's grant.json beside the new profile;
//  2. accepting artifact A runs the paired-peer check before `delegateTo`, so a refusal leaves no live unrecorded delegation;
//  3. two commands adding the same handle never replace each other's peer and delegations;
//  4. a command whose peer was revoked meanwhile fails and publishes nothing.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { AGENT_GRANT, COURIER_SPACE } from '../dist/keys.js';
import { installRefusing } from '../dist/grant.js';
import { main } from '../dist/main.js';
import { loadProfile, saveProfile, writeSecure } from '../dist/profile.js';
import { homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe } from './support/approval-fixture.mjs';

const DAY = 86_400_000;
const OWNER = 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001';
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const peerOf = (handle, status, extra = {}) => ({ handle, ownerDid: OWNER, courierDid: `did:key:z${handle}`, spaceId: 's', outbound: [], status, pairedAt: iso(0), ...extra });

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


/** Runs `fn` with COURIER_HOME pointing at `home`, in this process. */
async function inHome(home, fn) {
  const previous = process.env.COURIER_HOME;
  process.env.COURIER_HOME = home;
  try { return await fn(); } finally { process.env.COURIER_HOME = previous; }
}

/** Runs `courier ...argv` in this process; `during` runs once, the first time grant.json is read (the command has loaded its profile by then). */
async function runHere(t, home, argv, during) {
  const errors = [];
  const written = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  t.mock.method(process.stdout, 'write', (chunk) => { written.push(String(chunk)); return true; });
  const read = fs.readFileSync;
  let fired = false;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (!fired && String(file) === path.join(home, 'grant.json')) { fired = true; during(); }
    return read(file, ...rest);
  });
  let code;
  try { code = await inHome(home, () => main(argv)); } finally { t.mock.restoreAll(); }
  assert.equal(fired, true, 'the hook ran while the command was working');
  return { code, stderr: errors.join('\n'), stdout: written.join('') };
}

const diskProfile = (home) => JSON.parse(fs.readFileSync(path.join(home, 'profile.json'), 'utf8'));
const setPeers = (home, edit) => { const profile = diskProfile(home); edit(profile.peers); fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify(profile, null, 2), { mode: 0o600 }); };

scenario('a command that outlived `init --rotate-key` refuses before it writes the old key\'s grant.json', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  const key = readHome('key.json');
  const waiter = loadProfile(); // `init --wait` holds this while the owner approves
  const payload = await signedGrant(key);
  writeSecure(homeFile('profile.json'), { ...readHome('profile.json'), courierDid: 'did:key:znew', peers: {} }); // meanwhile: `init --rotate-key`
  await assert.rejects(installRefusing(waiter, key, payload), (e) => e.code === 'profile-changed');
  assert.equal(fs.existsSync(homeFile('grant.json')), false, 'no grant for the old key was written');
  assert.equal(readHome('profile.json').courierDid, 'did:key:znew');
});

test('accept A refuses an already-paired handle before it creates any delegation, even when the pairing completed after this command loaded its profile', async (t) => {
  const wallet = randomBytes(32).toString('hex');
  const issuer = await makeHome('r-issuer', 'issuer', wallet);
  const receiver = await makeHome('r-receiver', 'receiver', wallet);
  const artA = await run(issuer, ['pair', 'start', 'issuer-one', '--call-me', 'friend']);
  const original = TinyCloudNode.prototype.delegateTo;
  const delegations = [];
  t.mock.method(TinyCloudNode.prototype, 'delegateTo', function (...args) { delegations.push(args[0]); return original.apply(this, args); });
  const result = await runHere(t, receiver, ['pair', 'accept', JSON.stringify(artA)], () => setPeers(receiver, (peers) => { peers.friend = peerOf('friend', 'paired'); }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Already paired with friend/);
  assert.deepEqual(delegations, [], 'no delegation was created');
  assert.equal(result.stdout, '', 'no artifact was printed');
  assert.equal(diskProfile(receiver).peers.friend.status, 'paired');
});

test('two commands that add the same handle: the second save never replaces the first one\'s peer and delegations', async () => {
  const home = process.env.COURIER_HOME;
  fs.rmSync(`${home}/profile.json.lock`, { force: true });
  writeSecure(path.join(home, 'profile.json'), { version: 3, host: 'http://127.0.0.1:1', openkeyHost: 'https://openkey.so', label: 'courier · test', courierDid: 'did:key:zself', status: 'ready', peers: {} });
  const first = loadProfile();
  const second = loadProfile();
  first.peers.dup = peerOf('dup', 'awaiting-C', { outbound: [{ cid: 'first-delegation', issuedAt: iso(0), expiresAt: iso(7 * DAY) }] });
  saveProfile(first);
  second.peers.dup = peerOf('dup', 'awaiting-C', { courierDid: 'did:key:zother', outbound: [{ cid: 'second-delegation', issuedAt: iso(1), expiresAt: iso(7 * DAY) }] });
  try { saveProfile(second); } catch { /* refusing the second add is allowed */ }
  const saved = diskProfile(home).peers.dup;
  assert.ok(saved.outbound.some((entry) => entry.cid === 'first-delegation'), 'the first command\'s delegation is still recorded');
  assert.equal(saved.courierDid, 'did:key:zdup', 'the first command\'s peer identity is kept');
});

test('a command whose peer was revoked meanwhile fails and publishes no artifact', async (t) => {
  const wallet = randomBytes(32).toString('hex');
  const issuer = await makeHome('v-issuer', 'issuer', wallet);
  const receiver = await makeHome('v-receiver', 'receiver', wallet);
  const artA = await run(issuer, ['pair', 'start', 'issuer-one', '--call-me', 'friend']);
  const artB = await run(receiver, ['pair', 'accept', JSON.stringify(artA)]);
  const result = await runHere(t, issuer, ['pair', 'accept', JSON.stringify(artB)], () => setPeers(issuer, (peers) => { delete peers['issuer-one']; })); // `courier revoke` in another shell
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /revoked/);
  assert.equal(result.stdout, '', 'no artifact C was printed');
  assert.deepEqual(diskProfile(issuer).peers, {}, 'the revoked peer stays revoked');
});
