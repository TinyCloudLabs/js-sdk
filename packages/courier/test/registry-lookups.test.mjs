// TC-2970: one Courier process looks each owner up in the location registry once, however many node calls it makes.
// Real signed pairings against the owned loopback fixture host; the registry is the canonical no-entry fixture (v2 404,
// v1 404), the state of an owner with no registry record. Synthetic owner keys only.
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
import { courierRegistryFixtureEnv, installCourierRegistryFixture } from './support/registry-fixture.mjs';
import { peerKv, courierNode } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const wasm = new NodeWasmBindings();
const execFileAsync = promisify(execFile);
const DAY = 24 * 3_600_000;

const fixtureApi = issuedFixture({});
let invokes = 0;
const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/invoke') {
    invokes++;
    // The node answers a listing with a JSON array of keys; this fixture's mailboxes are empty.
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /i, '');
    const actions = Object.values(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).att ?? {}).flatMap(Object.keys);
    if (actions.includes('tinycloud.kv/list')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); return; }
  }
  void fixtureApi.handle(req, res);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());

const root = path.join(process.env.COURIER_TEST_HOME, 'registry-lookups');
fs.mkdirSync(root, { recursive: true });
const LOG = path.join(root, 'registry.jsonl');

/** Registry lookups logged by process `pid` (all processes when omitted), as `v2 <owner>` / `v1 <owner>` counts. */
function lookups(pid) {
  const counts = {};
  const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  for (const entry of lines) {
    if (pid !== undefined && entry.pid !== pid) continue;
    const version = entry.path.split('/')[1];
    const owner = decodeURIComponent(entry.path.slice(entry.path.lastIndexOf('/') + 1)).split(':').at(-1).toLowerCase();
    counts[`${version} ${owner}`] = (counts[`${version} ${owner}`] ?? 0) + 1;
  }
  return counts;
}

/** The expected lookups: one v2 and one v1 per owner (a no-entry owner is confirmed on both versions). */
function onePairEach(...owners) {
  return Object.fromEntries(owners.flatMap((owner) => [[`v2 ${owner}`, 1], [`v1 ${owner}`, 1]]));
}

/** Runs the CLI in its own process with the registry log on; returns its output and its lookups. */
async function run(home, args) {
  fs.rmSync(LOG, { force: true });
  const env = { ...courierRegistryFixtureEnv(home, HOST), TC_TEST_MOCK_REGISTRY_LOG: LOG };
  const before = invokes;
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { stdout, lookups: lookups(), invokes: invokes - before };
}

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  return { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
}

async function makeHome(name, handle) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { mode: 0o700 });
  const key = agentKey();
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
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
  const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, ownerDid, address, chainId: 1,
    verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt: expiresAt.toISOString(), receivedAt: now.toISOString() };
  const profile = { version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: name, selfHandle: handle, courierDid: key.did.split('#', 1)[0],
    ownerDid, spaceId, grantExpiresAt: grant.expiresAt, status: 'ready', peers: {} };
  for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) fs.writeFileSync(path.join(home, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return { home, owner: address.toLowerCase() };
}

const issuer = await makeHome('issuer', 'issuer');
const recipient = await makeHome('recipient', 'recipient');
const artA = JSON.parse((await run(issuer.home, ['pair', 'start', 'to-recipient', '--call-me', 'to-issuer'])).stdout);
const artB = JSON.parse((await run(recipient.home, ['pair', 'accept', JSON.stringify(artA)])).stdout);
const artC = JSON.parse((await run(issuer.home, ['pair', 'accept', JSON.stringify(artB)])).stdout);
await run(recipient.home, ['pair', 'accept', JSON.stringify(artC)]);

test('many node calls in one process, across node instances and a peer reader: one v2 and one v1 lookup per owner', async () => {
  installCourierRegistryFixture(HOST);
  process.env.TC_TEST_MOCK_REGISTRY_LOG = LOG;
  fs.rmSync(LOG, { force: true });
  process.env.COURIER_HOME = recipient.home;
  const profile = loadProfile();
  const peer = structuredClone(profile.peers['to-issuer']);
  const before = invokes;

  const node = await courierNode(profile);
  // Concurrent first calls share one lookup.
  await Promise.all(Array.from({ length: 10 }, (_, i) => node.kv.get(`${PREFIX}/me/probe/${i}.json`)));
  for (let i = 0; i < 10; i++) await node.kv.get(`${PREFIX}/me/probe/s${i}.json`);
  const second = await courierNode(profile);
  for (let i = 0; i < 5; i++) await second.kv.get(`${PREFIX}/me/probe/t${i}.json`);
  const kv = await peerKv(node, profile, peer);
  for (let i = 0; i < 10; i++) await kv.get(`${PREFIX}/to/${peer.theirHandleForMe}/threads/T/msg/M${i}.json`);

  assert.ok(invokes - before >= 35, `the node calls were made (${invokes - before})`);
  assert.deepEqual(lookups(process.pid), onePairEach(recipient.owner, issuer.owner));
});

test('courier send: one v2 and one v1 lookup per owner for the whole command', async () => {
  const first = await run(issuer.home, ['send', 'to-recipient', '--new', 'Synthetic subject', '--text', 'Synthetic message one']);
  const { threadId } = JSON.parse(first.stdout);
  assert.ok(first.invokes > 2, `send made several node calls (${first.invokes})`);
  assert.deepEqual(first.lookups, onePairEach(issuer.owner, recipient.owner));
  const reply = await run(issuer.home, ['send', 'to-recipient', '--thread', threadId, '--text', 'Synthetic message two']);
  assert.deepEqual(reply.lookups, onePairEach(issuer.owner, recipient.owner));
});

test('courier watch --once: one v2 and one v1 lookup per owner for the whole pass', async () => {
  const pass = await run(recipient.home, ['watch', '--once', '--wake', 'none', '--notify', 'none']);
  assert.ok(pass.invokes > 2, `the pass made several node calls (${pass.invokes})`);
  assert.deepEqual(pass.lookups, onePairEach(recipient.owner, issuer.owner));
});
