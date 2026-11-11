// TC-2746: real signed pairings against an owned loopback activation host.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { AGENT_GRANT, COURIER_SPACE } from '../dist/keys.js';
import { courierRegistryFixtureEnv } from './support/registry-fixture.mjs';

import { peerKv, courierNode } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const wasm = new NodeWasmBindings();
// Never execFileSync: the child answers through the in-process stub below, which needs this process's event loop free.
const execFileAsync = promisify(execFile);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Synthetic owner wallets. No credentials are read.
const owners = {
  sam: randomBytes(32).toString('hex'),
  mira: randomBytes(32).toString('hex'),
};

const hits = { delegate: 0, invoke: 0 };
const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/delegate') {
    hits.delegate += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ activated: ['agents'], skipped: [] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/invoke') {
    hits.invoke += 1;
    res.writeHead(200, { 'content-type': 'application/json', etag: '"stub-etag"' });
    res.end('{}');
    return;
  }
  res.writeHead(404).end('no such route');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'COURIER_TEST_HOME (setup-home.mjs) must pin this test home');
fs.mkdirSync(path.join(root, 'inbound-renewal'), { recursive: true });

async function run(home, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  return JSON.parse(stdout);
}

const courierDid = (key) => key.did.split('#', 1)[0];

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const jwk = JSON.parse(manager.jwk(id));
  return { v: 1, jwk, did: manager.getDID(id), createdAt: new Date().toISOString() };
}

/** Signed Courier grant for `key` issued by `ownerPrivateKey` and valid for `lifetimeMs`, same shape OpenKey returns. */
async function makeGrant(ownerPrivateKey, key, lifetimeMs) {
  const signer = new PrivateKeySigner(ownerPrivateKey);
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, COURIER_SPACE);
  const abilities = {};
  for (const permission of AGENT_GRANT) {
    const service = permission.service.replace(/^tinycloud\./, '');
    (abilities[service] ??= {})[permission.path] = permission.actions;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + lifetimeMs);
  const prepared = wasm.prepareSession({
    abilities,
    address,
    chainId,
    domain: 'courier.test',
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString(),
    spaceId,
    jwk: key.jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    grant: {
      v: 1,
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId,
      ownerDid: `did:pkh:eip155:${chainId}:${address}`,
      address,
      chainId,
      verificationMethod: key.did,
      siwe: prepared.siwe,
      signature,
      expiresAt: expiresAt.toISOString(),
      receivedAt: now.toISOString(),
    },
    ownerDid: `did:pkh:eip155:${chainId}:${address}`,
    spaceId,
  };
}

/** A Courier home ready for pairing without `courier init` (no OpenKey round trip). */
async function makeHome(name, handle, ownerPrivateKey, grantLifetimeMs = 30 * DAY) {
  const home = path.join(root, 'inbound-renewal', name);
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const key = agentKey();
  const { grant, ownerDid, spaceId } = await makeGrant(ownerPrivateKey, key, grantLifetimeMs);
  const profile = {
    version: 3,
    host: HOST,
    openkeyHost: 'https://openkey.so',
    label: `courier · ${name}`,
    selfHandle: handle,
    courierDid: courierDid(key),
    ownerDid,
    spaceId,
    grantExpiresAt: grant.expiresAt,
    status: 'ready',
    peers: {},
  };
  for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) {
    fs.writeFileSync(path.join(home, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
  return { home, profile, grant };
}

const profilePath = (home) => path.join(home, 'profile.json');
const profileAt = (home) => JSON.parse(fs.readFileSync(profilePath(home), 'utf8'));
const profileBytes = (home) => fs.readFileSync(profilePath(home), 'utf8');
const writeProfile = (home, profile) => fs.writeFileSync(profilePath(home), `${JSON.stringify(profile, null, 2)}\n`);

/** Complete A→B→C; `a` addresses `b` as `aPeerHandle`, `b` addresses `a` as `callMe`. */
async function pairAll(a, aPeerHandle, b, callMe) {
  const artA = await run(a.home, ['pair', 'start', aPeerHandle, '--call-me', callMe]);
  const artB = await run(b.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(a.home, ['pair', 'accept', JSON.stringify(artB)]);
  await run(b.home, ['pair', 'accept', JSON.stringify(artC)]);
}


await import('./support/registry-fixture.mjs').then(m => m.installCourierRegistryFixture(HOST));

test('peer reads collect a newer signed grant without a receiving pair renew; preserve binding and outbound history', async () => {
  const issuer = await makeHome('issuer', 'issuer', owners.sam);
  const recipient = await makeHome('recipient', 'recipient', owners.mira);
  await pairAll(issuer, 'to-recipient', recipient, 'to-issuer');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const artifact = await run(issuer.home, ['pair', 'renew', 'to-recipient', '--renew-artifact', '--force']);
  process.env.COURIER_HOME = recipient.home;
  const profile = loadProfile();
  // Watch passes a peer from a separate loadProfile; exercise that exact object boundary.
  const peer = structuredClone(profile.peers['to-issuer']);
  const before = structuredClone(peer);
  const node = await courierNode(profile);
  let reads = 0;
  const kv = { get: async key => {
    reads++;
    assert.match(key, /delegation/);
    return { ok: true, data: { data: { delegation: artifact.delegation } } };
  } };
  node.kvForSpace = () => kv;
  assert.equal(await peerKv(node, profile, peer), kv);
  assert.equal(reads, 1);
  assert.equal(peer.inbound.cid, JSON.parse(artifact.delegation).cid);
  assert.notEqual(peer.inbound.cid, before.inbound.cid);
  assert.deepEqual(profileAt(recipient.home).peers['to-issuer'], { ...before, inbound: peer.inbound });

  // Repeated access is idempotent, and checks cached current expiry too.
  await peerKv(node, profile, peer);
  const now = Date.now;
  try {
    Date.now = () => Date.parse(peer.inbound.expiresAt);
    const calls = reads;
    await assert.rejects(peerKv(node, profile, peer), /expired/);
    assert.equal(reads, calls, 'never fetch a replacement after lapse');
  } finally { Date.now = now; }
});

test('absent renewal keeps current access; failed collection is surfaced; saved lapse never fetches', async () => {
  const recipientHome = path.join(root, 'inbound-renewal', 'recipient');
  process.env.COURIER_HOME = recipientHome;
  const profile = loadProfile();
  const peer = profile.peers['to-issuer'];
  const before = profileBytes(recipientHome);
  const node = await courierNode(profile);
  let reads = 0;
  node.kvForSpace = () => ({ get: async () => { reads++; return { ok: false, error: { code: 'NOT_FOUND', message: 'not found', status: 404 } }; } });
  await peerKv(node, profile, peer);
  assert.equal(reads, 1);
  assert.equal(profileBytes(recipientHome), before);
  node.kvForSpace = () => ({ get: async () => { throw new Error('permission revoked'); } });
  await assert.rejects(peerKv(node, profile, peer), /permission revoked/);
  assert.equal(profileBytes(recipientHome), before);
  peer.inbound.expiresAt = new Date(0).toISOString();
  const calls = reads;
  await assert.rejects(peerKv(node, profile, peer), /expired/);
  assert.equal(reads, calls);
});

test('replacement with changed mailbox is not saved', async () => {
  const issuer = await makeHome('other-issuer', 'other-issuer', owners.sam);
  const recipient = { home: path.join(root, 'inbound-renewal', 'recipient') };
  await pairAll(issuer, 'elsewhere', recipient, 'other-side');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const artifact = await run(issuer.home, ['pair', 'renew', 'elsewhere', '--renew-artifact', '--force']);
  const home = path.join(root, 'inbound-renewal', 'recipient');
  process.env.COURIER_HOME = home;
  const profile = loadProfile();
  const peer = profile.peers['to-issuer'];
  const before = profileBytes(home);
  const node = await courierNode(profile);
  node.kvForSpace = () => ({ get: async () => ({ ok: true, data: { data: { delegation: artifact.delegation } } }) });
  await assert.rejects(peerKv(node, profile, peer), /not authorized/);
  assert.equal(profileBytes(home), before);
});

test('expiry reached during the replacement read leaves the saved grant untouched', async () => {
  const home = path.join(root, 'inbound-renewal', 'recipient');
  process.env.COURIER_HOME = home;
  const profile = loadProfile();
  const peer = profile.peers['to-issuer'];
  const before = profileBytes(home);
  const node = await courierNode(profile);
  const now = Date.now;
  node.kvForSpace = () => ({ get: async () => {
    Date.now = () => Date.parse(peer.inbound.expiresAt);
    return { ok: true, data: { data: {} } };
  } });
  try { await assert.rejects(peerKv(node, profile, peer), /expired/); }
  finally { Date.now = now; }
  assert.equal(profileBytes(home), before);
});


test('another signed issuer with the same owner and exact mailbox cannot replace the paired issuer', async () => {
  const issuer = await makeHome('forger', 'forger', owners.sam);
  const recipient = { home: path.join(root, 'inbound-renewal', 'recipient') };
  await pairAll(issuer, 'to-recipient', recipient, 'forger-side');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const artifact = await run(issuer.home, ['pair', 'renew', 'to-recipient', '--renew-artifact', '--force']);
  const home = path.join(root, 'inbound-renewal', 'recipient');
  process.env.COURIER_HOME = home;
  const profile = loadProfile();
  const peer = profile.peers['to-issuer'];
  const before = profileBytes(home);
  const node = await courierNode(profile);
  node.kvForSpace = () => ({ get: async () => ({ ok: true, data: { data: { delegation: artifact.delegation } } }) });
  await assert.rejects(peerKv(node, profile, peer), /not the advertised courier/);
  assert.equal(profileBytes(home), before);
});

test('a peer removed or rebound during collection is never restored or overwritten', async () => {
  const issuerHome = path.join(root, 'inbound-renewal', 'issuer');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const artifact = await run(issuerHome, ['pair', 'renew', 'to-recipient', '--renew-artifact', '--force']);
  const home = path.join(root, 'inbound-renewal', 'recipient');
  process.env.COURIER_HOME = home;
  const baseline = profileAt(home);
  for (const change of ['removed', 'rebound', 'newer', 'owner', 'key', 'mailbox', 'status', 'expired']) {
    writeProfile(home, baseline);
    const profile = loadProfile();
    const peer = structuredClone(profile.peers['to-issuer']);
    const node = await courierNode(profile);
    let concurrent;
    node.kvForSpace = () => ({ get: async () => {
      const disk = profileAt(home);
      if (change === 'removed') delete disk.peers['to-issuer'];
      else if (change === 'rebound') disk.peers['to-issuer'].sessionId = 'new-session';
      else if (change === 'newer') disk.peers['to-issuer'].inbound = {
        cid: 'concurrently-installed-newer', delegation: artifact.delegation,
        expiresAt: new Date(Date.parse(artifact.delegationExpiresAt) + DAY).toISOString(),
      };
      else if (change === 'owner') disk.ownerDid = issuerHome;
      else if (change === 'key') disk.courierDid = 'did:key:rotated';
      else if (change === 'mailbox') disk.peers['to-issuer'].theirHandleForMe = 'another-mailbox';
      else if (change === 'status') disk.peers['to-issuer'].status = 'awaiting-C';
      else disk.peers['to-issuer'].inbound.expiresAt = new Date(0).toISOString();
      writeProfile(home, disk);
      concurrent = profileBytes(home);
      return { ok: true, data: { data: { delegation: artifact.delegation } } };
    } });
    await assert.rejects(peerKv(node, profile, peer), /revoked|changed/);
    assert.equal(profileBytes(home), concurrent, change);
  }
  writeProfile(home, baseline);
});
