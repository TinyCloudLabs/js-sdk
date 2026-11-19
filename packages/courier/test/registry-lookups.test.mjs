// TC-2970 / TC-2481: how often one Courier process looks an owner up in the location registry. Reads of an owner with no
// registry record share one lookup; every write and every grant install looks its owner up afresh (absent-reads). Also,
// `courier read` of an N-entry thread makes a bounded number of node calls. Real signed pairings against the owned
// loopback fixture host; the registry is the canonical no-entry fixture (v2 404, v1 404), the state of an owner with no
// registry record. Synthetic owner keys only.
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
import { AGENT_GRANT, COURIER_SPACE, PREFIX, k } from '../dist/keys.js';
import { buildMessage } from '../dist/a2a.js';
import { ulid } from 'ulid';
import { courierRegistryFixtureEnv, installCourierRegistryFixture } from './support/registry-fixture.mjs';
import { peerKv, courierNode } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const wasm = new NodeWasmBindings();
const execFileAsync = promisify(execFile);
const DAY = 24 * 3_600_000;

const fixtureApi = issuedFixture({});
let invokes = 0;
/** The owner address of every KV write (put, delete) the node received, in arrival order. */
const writes = [];
/** The node's KV, by resource (`<space>/kv/<key>`): get, put, list, delete and multi-key batch get, as the node answers them. */
const store = new Map();
let revision = 0;
const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/invoke') {
    invokes++;
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /i, '');
    const att = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).att ?? {};
    const entries = Object.entries(att).filter(([resource]) => resource.includes('/kv/'));
    for (const [resource, abilities] of entries) {
      if (Object.keys(abilities).some((action) => action === 'tinycloud.kv/put' || action === 'tinycloud.kv/del')) {
        writes.push(/:(0x[0-9a-fA-F]{40}):/.exec(resource)?.[1].toLowerCase());
      }
    }
    if (entries.length) { void kvInvoke(req, res, entries); return; }
  }
  void fixtureApi.handle(req, res);
});

function split(resource) {
  const at = resource.indexOf('/kv/');
  return { space: resource.slice(0, at), path: resource.slice(at + 4) };
}

async function kvInvoke(req, res, entries) {
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body); };
  const actions = entries.map(([, abilities]) => Object.keys(abilities)[0]);
  if (entries.length > 1) {
    if (actions.some((action) => action !== 'tinycloud.kv/get')) { send(400, '{}'); return; }
    const results = entries.map(([resource]) => {
      const row = store.get(resource);
      const key = split(resource).path;
      return row
        ? { key, ok: true, headers: { 'content-type': 'application/json', etag: row.etag }, dataBase64: Buffer.from(row.body).toString('base64') }
        : { key, ok: false, error: { code: 'KV_NOT_FOUND', message: 'Key not found' } };
    });
    send(200, JSON.stringify({ results }));
    return;
  }
  const [resource] = entries[0];
  const row = store.get(resource);
  switch (actions[0]) {
    case 'tinycloud.kv/get':
      if (row) send(200, row.body, { etag: row.etag });
      else send(404, JSON.stringify({ code: 'KV_NOT_FOUND' }));
      return;
    case 'tinycloud.kv/put': {
      if ((req.headers['if-none-match'] === '*' && row) || (req.headers['if-match'] && row?.etag !== req.headers['if-match'])) { send(412, '{}'); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      const etag = `"stub-${++revision}"`;
      store.set(resource, { body, etag });
      send(200, '{}', { etag });
      return;
    }
    case 'tinycloud.kv/list': {
      const { space, path: prefix } = split(resource);
      send(200, JSON.stringify([...store.keys()].filter((key) => key.startsWith(`${space}/kv/${prefix}`)).map((key) => split(key).path)));
      return;
    }
    case 'tinycloud.kv/del':
      store.delete(resource);
      send(200, '{}');
      return;
    default:
      send(200, '{}');
  }
}
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

/** The expected lookups: for each owner, that many v2 lookups and as many v1 (a no-entry owner is confirmed on both versions). */
function lookupPairs(perOwner) {
  return Object.fromEntries(Object.entries(perOwner).flatMap(([owner, count]) => [[`v2 ${owner}`, count], [`v1 ${owner}`, count]]));
}

/** Runs the CLI in its own process with the registry log on; returns its output, its lookups and its writes per owner. */
async function run(home, args) {
  fs.rmSync(LOG, { force: true });
  const env = { ...courierRegistryFixtureEnv(home, HOST), TC_TEST_MOCK_REGISTRY_LOG: LOG };
  const before = invokes;
  const firstWrite = writes.length;
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  const written = {};
  for (const owner of writes.slice(firstWrite)) written[owner] = (written[owner] ?? 0) + 1;
  return { stdout, lookups: lookups(), invokes: invokes - before, writes: written };
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

test('many node calls in one process, across node instances and a peer reader: reads share one lookup per owner; installing the peer\'s grant looks the peer\'s owner up afresh', async () => {
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
  // The peer's ten reads share one lookup; installing its grant on the reader is routed with the grant's own accesses,
  // which are not all reads, so it looks the peer's owner up afresh.
  assert.deepEqual(lookups(process.pid), lookupPairs({ [recipient.owner]: 1, [issuer.owner]: 2 }));
});

test('reads of an owner with no registry record share one lookup; every write looks it up afresh, and the next read again', async () => {
  installCourierRegistryFixture(HOST);
  process.env.TC_TEST_MOCK_REGISTRY_LOG = LOG;
  const writer = await makeHome('writer', 'writer');
  process.env.COURIER_HOME = writer.home;
  const node = await courierNode(loadProfile());
  const pairs = () => [lookups(process.pid)[`v2 ${writer.owner}`] ?? 0, lookups(process.pid)[`v1 ${writer.owner}`] ?? 0];
  for (let i = 0; i < 5; i++) await node.kv.get(`${PREFIX}/me/probe/r${i}.json`);
  assert.deepEqual(pairs(), [1, 1], 'five reads, one lookup');
  for (let i = 0; i < 3; i++) await node.kv.put(`${PREFIX}/me/probe/w${i}.json`, { i });
  assert.deepEqual(pairs(), [4, 4], 'three writes, three more lookups');
  for (let i = 0; i < 5; i++) await node.kv.get(`${PREFIX}/me/probe/w${i}.json`);
  assert.deepEqual(pairs(), [5, 5], 'a write drops the kept absence: the reads after it share one new lookup');
});

test('the node identity an invitation is published and delivered under is looked up afresh, never from an absence kept by reads', async () => {
  installCourierRegistryFixture(HOST);
  process.env.TC_TEST_MOCK_REGISTRY_LOG = LOG;
  const inviter = await makeHome('inviter', 'inviter');
  process.env.COURIER_HOME = inviter.home;
  const node = await courierNode(loadProfile());
  const pairs = () => [lookups(process.pid)[`v2 ${inviter.owner}`] ?? 0, lookups(process.pid)[`v1 ${inviter.owner}`] ?? 0];
  for (let i = 0; i < 3; i++) await node.kv.get(`${PREFIX}/me/probe/r${i}.json`);
  assert.deepEqual(pairs(), [1, 1], 'reads keep the absence');
  // sendEmailInvitation resolves this identity, then publishes and delivers under it (email-invitation.ts).
  const identity = await node.activeNodeIdentity();
  assert.equal(identity.origin, HOST);
  assert.deepEqual(pairs(), [2, 2], 'the identity lookup does not use the kept absence');
});

test('courier send: every write looks its owner up afresh; the peer\'s owner is looked up once for its reads and once to activate its grant', async () => {
  const first = await run(issuer.home, ['send', 'to-recipient', '--new', 'Synthetic subject', '--text', 'Synthetic message one']);
  const { threadId } = JSON.parse(first.stdout);
  const reply = await run(issuer.home, ['send', 'to-recipient', '--thread', threadId, '--text', 'Synthetic message two']);
  // Each command first checks its peers' authority (POST /delegation/query), which is not a data read: its own lookup. A new
  // thread then writes meta and the message, each with its own lookup: 3 for our owner. A reply reads the meta (one shared
  // lookup) and writes the message: 3. The peer's reads share one lookup; installing its grant on the reader is not a
  // read: 2 for the peer.
  for (const [sent, writes, own] of [[first, 2, 3], [reply, 1, 3]]) {
    assert.equal(sent.invokes, 3);
    assert.deepEqual(sent.writes, { [issuer.owner]: writes }, 'send writes only its own space');
    assert.deepEqual(sent.lookups, lookupPairs({ [issuer.owner]: own, [recipient.owner]: 2 }));
  }
});

test('courier watch --once: every write looks its owner up afresh, reads between writes share one lookup; the peer\'s owner once for reads and once for its grant', async () => {
  const pass = await run(recipient.home, ['watch', '--once', '--wake', 'none', '--notify', 'none']);
  assert.ok(pass.invokes > 2, `the pass made several node calls (${pass.invokes})`);
  // After the earlier sends, the pass imports, mirrors and records receipts and state: 9 writes to our space, each with its
  // own lookup; 2 authority checks (POST /delegation/query), each with its own lookup; and 4 runs of reads between them
  // sharing one each: 15. Any blow-up past that fails here.
  assert.equal(pass.writes[recipient.owner], 9);
  assert.deepEqual(pass.lookups, lookupPairs({ [recipient.owner]: 15, [issuer.owner]: 2 }));
});

test('courier read of a 344-entry thread: bounded batched node calls, reads share one lookup per owner, the authority check and the peer\'s grant install each look up afresh, every entry shown', async () => {
  const started = await run(recipient.home, ['send', 'to-issuer', '--new', 'Synthetic long thread', '--text', 'Synthetic opener']);
  const { threadId, messageId: opener } = JSON.parse(started.stdout);
  const profile = JSON.parse(fs.readFileSync(path.join(recipient.home, 'profile.json'), 'utf8'));
  const peer = profile.peers['to-issuer'];
  // Our side: meta, the opener and 170 more messages (172 entries); the peer's side: 172 messages. 344 in all, as Orchard's.
  const seeded = new Map();
  const seed = (space, key, body) => store.set(`${space}/kv/${key}`, { body: JSON.stringify(body), etag: `"seed-${++revision}"` });
  for (let i = 0; i < 342; i++) {
    const body = buildMessage({ threadId, text: `Synthetic ${i}`, role: 'ROLE_USER', intent: 'inform', from: { owner: 'o', agent: 'a' } });
    body.messageId = ulid();
    seeded.set(body.messageId, body);
    if (i < 170) seed(profile.spaceId, k.msg('to-issuer', threadId, body.messageId), body);
    else seed(peer.spaceId, `${PREFIX}/to/${peer.theirHandleForMe}/threads/${threadId}/msg/${body.messageId}.json`, body);
  }

  const read = await run(recipient.home, ['read', threadId, '--json']);
  const shown = JSON.parse(read.stdout);
  assert.equal(shown.entries.length, 344);
  assert.deepEqual(shown.errors, []);
  const messages = shown.entries.filter((entry) => entry.kind === 'msg');
  assert.deepEqual(messages.map((entry) => entry.id).sort(), [opener, ...seeded.keys()].sort(), 'every message is shown once');
  for (const entry of messages) if (entry.id !== opener) assert.deepEqual(entry.body, seeded.get(entry.id), `${entry.id} is shown as stored`);
  assert.equal(messages.filter((entry) => entry.side === 'me').length, 171);
  assert.equal(messages.filter((entry) => entry.side === 'peer').length, 172);
  assert.equal(shown.entries.filter((entry) => entry.kind === 'meta').length, 1);
  // Batches of 16 per side: ⌈172/16⌉ + ⌈172/16⌉ = 22, plus listings, the peer's renewal marker and the grant checks.
  const bound = Math.ceil(172 / 16) * 2 + 6;
  assert.ok(read.invokes <= bound, `read made ${read.invokes} node calls for 344 entries (bound ${bound})`);
  assert.equal(read.writes[recipient.owner] ?? 0, 0, 'read writes nothing');
  // Our reads share one lookup; the authority check before them is not a data read and has its own.
  assert.deepEqual(read.lookups, lookupPairs({ [recipient.owner]: 2, [issuer.owner]: 2 }));
});
