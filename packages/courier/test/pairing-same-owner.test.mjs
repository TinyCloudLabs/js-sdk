// TC-1248: Courier pairs agents by courier did:key, not by owner DID. Two agent keys of one
// owner complete the real A→B→C protocol with the same explicit consent as two owners;
// an artifact from the agent's own courier DID stays refused, and substituted or mismatched
// identities still fail. Real CLI + real signed sessions, isolated COURIER_HOME dirs, and a
// loopback stub standing in for the host's POST /delegate activation receipt (every signed
// check still runs in-process); there is no KV endpoint, so the best-effort me/peers record
// write warns to stderr and never blocks.
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

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const wasm = new NodeWasmBindings();
// Never execFileSync: the child answers through the in-process stub below, which needs this
// process's event loop free.
const execFileAsync = promisify(execFile);

// Synthetic owner wallets (one per owner DID in this file). No credentials are read.
const owners = {
  sam: randomBytes(32).toString('hex'),
  mira: randomBytes(32).toString('hex'),
};

const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/delegate') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ activated: ['agents'], skipped: [] }));
    return;
  }
  res.writeHead(404).end('no such route');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'COURIER_TEST_HOME (setup-home.mjs) must pin this test home');
fs.mkdirSync(path.join(root, 'pairing'), { recursive: true });

async function run(home, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    env: { ...process.env, COURIER_HOME: home, HOME: home },
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

async function runFail(home, args) {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, COURIER_HOME: home, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { code: e.code, stderr: String(e.stderr) };
  }
  throw new Error(`expected \`courier ${args.join(' ')}\` to fail`);
}

const courierDid = (key) => key.did.split('#', 1)[0];

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const jwk = JSON.parse(manager.jwk(id));
  return { v: 1, jwk, did: manager.getDID(id), createdAt: new Date().toISOString() };
}

/** Signed Courier grant for `key` issued by `ownerPrivateKey`, same shape OpenKey returns. */
async function makeGrant(ownerPrivateKey, key) {
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
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
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
async function makeHome(name, handle, ownerPrivateKey) {
  const home = path.join(root, 'pairing', name);
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const key = agentKey();
  const { grant, ownerDid, spaceId } = await makeGrant(ownerPrivateKey, key);
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
  return { home, profile };
}

const profileAt = (home) => JSON.parse(fs.readFileSync(path.join(home, 'profile.json'), 'utf8'));

const samA = await makeHome('sam-a', 'sam-a', owners.sam);
const samB = await makeHome('sam-b', 'sam-b', owners.sam);
const mira = await makeHome('mira', 'mira', owners.mira);
const samC = await makeHome('sam-c', 'sam-c', owners.sam);

const pairAll = async (a, aPeerHandle, b, callMe) => {
  const artA = await run(a.home, ['pair', 'start', aPeerHandle, '--call-me', callMe ?? a.profile.selfHandle]);
  const artB = await run(b.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(a.home, ['pair', 'accept', JSON.stringify(artB)]);
  const done = await run(b.home, ['pair', 'accept', JSON.stringify(artC)]);
  return { artA, artB, artC, done };
};

test('two distinct agent keys of the same owner pair with the real protocol', async () => {
  const aHome = profileAt(samA.home);
  const bHome = profileAt(samB.home);
  assert.equal(aHome.ownerDid, bHome.ownerDid, 'fixture: same owner DID');
  assert.notEqual(aHome.courierDid, bHome.courierDid, 'fixture: distinct courier keys');

  const { artA, artB, artC, done } = await pairAll(samA, 'sam-b', samB);
  assert.equal(artA.step, 'A');
  assert.equal(artB.step, 'B');
  assert.equal(artC.step, 'C');
  assert.equal(done.ok, true);
  assert.equal(done.paired, 'sam-a');

  const aPeer = profileAt(samA.home).peers['sam-b'];
  const bPeer = profileAt(samB.home).peers['sam-a'];
  assert.equal(aPeer.status, 'paired');
  assert.equal(bPeer.status, 'paired');
  // Peer owner DID and agent-key binding are preserved on both sides.
  assert.equal(aPeer.ownerDid, samA.profile.ownerDid);
  assert.equal(bPeer.ownerDid, samA.profile.ownerDid);
  assert.equal(aPeer.courierDid, samB.profile.courierDid);
  assert.equal(bPeer.courierDid, samA.profile.courierDid);
  assert.equal(aPeer.spaceId, samA.profile.spaceId);
  assert.equal(bPeer.spaceId, samA.profile.spaceId);
  assert.ok(aPeer.inbound && aPeer.outbound.length === 1, 'inbound delegation installed');
  assert.ok(bPeer.inbound && bPeer.outbound.length === 1);
});

test('an artifact from the agent own courier DID is refused, same owner or not', async () => {
  const selfA = await run(samA.home, ['pair', 'start', 'loopback']);
  const refused = await runFail(samA.home, ['pair', 'accept', JSON.stringify(selfA)]);
  assert.match(refused.stderr, /\[bad-artifact\]/);
  assert.match(refused.stderr, /Refusing to pair with this agent identity/);
  assert.equal(profileAt(samA.home).peers.loopback.status, 'pending-A', 'self artifact installed no peer');

  const selfB = await run(samB.home, ['pair', 'start', 'alias-b']);
  const refusedB = await runFail(samB.home, ['pair', 'accept', JSON.stringify(selfB)]);
  assert.match(refusedB.stderr, /Refusing to pair with this agent identity/);
  assert.equal(profileAt(samB.home).peers['alias-b'].status, 'pending-A');
});

test('different-owner pairing still completes', async () => {
  const { done } = await pairAll(samA, 'mira', mira);
  assert.equal(done.ok, true);
  assert.equal(done.paired, 'sam-a');
  const peer = profileAt(samA.home).peers.mira;
  const reverse = profileAt(mira.home).peers['sam-a'];
  assert.equal(peer.status, 'paired');
  assert.equal(peer.ownerDid, mira.profile.ownerDid);
  assert.notEqual(peer.ownerDid, samA.profile.ownerDid);
  assert.equal(peer.courierDid, mira.profile.courierDid);
  assert.equal(reverse.status, 'paired');
  assert.equal(reverse.ownerDid, samA.profile.ownerDid);
});

test('a B artifact advertising a courier DID that did not sign is refused and the pairing survives', async () => {
  const a3b = makeFreshStranger();
  const artA3 = await run(samA.home, ['pair', 'start', 'sam-c']);
  const artB3 = await run(samC.home, ['pair', 'accept', JSON.stringify(artA3)]);

  const swapped = await runFail(samA.home, ['pair', 'accept', JSON.stringify({ ...artB3, from: { ...artB3.from, courier: a3b } })]);
  assert.match(swapped.stderr, /\[bad-delegation\]/, 'advertised courier did not sign the delegation');
  assert.equal(profileAt(samA.home).peers['sam-c'].status, 'pending-A', 'tampered B changed nothing');

  const artC3 = await run(samA.home, ['pair', 'accept', JSON.stringify(artB3)]);
  assert.equal(artC3.step, 'C');
  assert.equal(profileAt(samA.home).peers['sam-c'].status, 'paired');

  const swappedC = await runFail(samC.home, ['pair', 'accept', JSON.stringify({ ...artC3, from: { ...artC3.from, courier: a3b } })]);
  assert.match(swappedC.stderr, /\[bad-artifact\]/, 'artifact C must name the pending pairing identity');
  assert.equal(profileAt(samC.home).peers['sam-a'].status, 'awaiting-C', 'tampered C changed nothing');

  const done = await run(samC.home, ['pair', 'accept', JSON.stringify(artC3)]);
  assert.equal(done.ok, true);
  assert.equal(profileAt(samC.home).peers['sam-a'].status, 'paired');
});

function makeFreshStranger() {
  const manager = wasm.createSessionManager();
  return manager.getDID(manager.createSessionKey('stranger')).split('#', 1)[0];
}
