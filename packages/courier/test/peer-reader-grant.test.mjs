// TC-2917 / TC-2938: the SDK invokes with the first installed grant that covers an operation, so after a peer renews its
// grant to us the superseded one must not be used. Real signed pairings against the owned loopback fixture host.
import { issuedFixture } from './support/issued-fixture.mjs';
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
import { AGENT_GRANT, COURIER_SPACE, PREFIX } from '../dist/keys.js';
import { courierRegistryFixtureEnv } from './support/registry-fixture.mjs';
import { peerKv, courierNode } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const wasm = new NodeWasmBindings();
const execFileAsync = promisify(execFile);
const DAY = 24 * 3_600_000;

const fixtureApi = issuedFixture({});
/** The proof CIDs of every KV invocation, in order. */
const proofs = [];
const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/invoke') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /i, '');
    proofs.push(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).prf);
  }
  void fixtureApi.handle(req, res);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());

const root = path.join(process.env.COURIER_TEST_HOME, 'peer-reader-grant');
fs.mkdirSync(root, { recursive: true });

async function run(home, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  return JSON.parse(stdout);
}

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  return { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
}

async function makeGrant(ownerPrivateKey, key, lifetimeMs) {
  const signer = new PrivateKeySigner(ownerPrivateKey);
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const abilities = {};
  for (const permission of AGENT_GRANT) (abilities[permission.service.replace(/^tinycloud\./, '')] ??= {})[permission.path] = permission.actions;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + lifetimeMs);
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: now.toISOString(), expirationTime: expiresAt.toISOString(), spaceId, jwk: key.jwk });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    grant: { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, ownerDid: `did:pkh:eip155:1:${address}`, address, chainId: 1,
      verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt: expiresAt.toISOString(), receivedAt: now.toISOString() },
    ownerDid: `did:pkh:eip155:1:${address}`, spaceId,
  };
}

async function makeHome(name, handle, ownerPrivateKey) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { mode: 0o700 });
  const key = agentKey();
  const { grant, ownerDid, spaceId } = await makeGrant(ownerPrivateKey, key, 30 * DAY);
  const profile = { version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: name, selfHandle: handle, courierDid: key.did.split('#', 1)[0],
    ownerDid, spaceId, grantExpiresAt: grant.expiresAt, status: 'ready', peers: {} };
  for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) fs.writeFileSync(path.join(home, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return { home, ownerPrivateKey };
}

async function approveLater(fixture) {
  const key = JSON.parse(fs.readFileSync(path.join(fixture.home, 'key.json'), 'utf8'));
  const { grant } = await makeGrant(fixture.ownerPrivateKey, key, 30 * DAY);
  fs.writeFileSync(path.join(fixture.home, 'grant.json'), JSON.stringify(grant), { mode: 0o600 });
  const profile = JSON.parse(fs.readFileSync(path.join(fixture.home, 'profile.json'), 'utf8'));
  profile.grantExpiresAt = grant.expiresAt;
  fs.writeFileSync(path.join(fixture.home, 'profile.json'), JSON.stringify(profile));
}

test('after a peer renews its grant to us, reads in the same process use the new grant, never the superseded one', async () => {
  const issuer = await makeHome('issuer', 'issuer', randomBytes(32).toString('hex'));
  const recipient = await makeHome('recipient', 'recipient', randomBytes(32).toString('hex'));
  const artA = await run(issuer.home, ['pair', 'start', 'to-recipient', '--call-me', 'to-issuer']);
  const artB = await run(recipient.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(issuer.home, ['pair', 'accept', JSON.stringify(artB)]);
  await run(recipient.home, ['pair', 'accept', JSON.stringify(artC)]);

  process.env.COURIER_HOME = recipient.home;
  const profile = loadProfile();
  const peer = structuredClone(profile.peers['to-issuer']);
  const superseded = peer.inbound.cid;
  const node = await courierNode(profile);
  await peerKv(node, profile, peer); // the first grant goes on the main node

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await approveLater(issuer);
  const artifact = await run(issuer.home, ['pair', 'renew', 'to-recipient', '--renew-artifact', '--force']);
  fixtureApi.seed(artifact.delegation); // the issuer's renewal marker, as its watcher would publish it
  const renewed = JSON.parse(artifact.delegation).cid;

  const kv = await peerKv(node, profile, peer);
  assert.equal(peer.inbound.cid, renewed, 'the renewal was adopted');
  const before = proofs.length;
  await kv.get(`${PREFIX}/to/${peer.theirHandleForMe}/threads/T/msg/M.json`);
  const used = proofs.slice(before).flat();
  assert.ok(used.length > 0, 'the read was invoked');
  assert.ok(used.includes(renewed), 'the read is proven by the new grant');
  assert.equal(used.includes(superseded), false, 'and never by the superseded one');

  const again = await peerKv(node, profile, peer);
  const mark = proofs.length;
  await again.get(`${PREFIX}/to/${peer.theirHandleForMe}/threads/T/msg/M.json`);
  assert.equal(proofs.slice(mark).flat().includes(superseded), false, 'later reads too');
});
