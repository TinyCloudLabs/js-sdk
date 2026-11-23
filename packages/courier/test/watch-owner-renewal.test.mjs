// TC-3522: two persistent watch commands, real SDK signing and renewal verification,
// and an owned loopback fixture. Advance only at the watch loop's sleep boundary.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { on, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import { bases } from 'multiformats/basics';
import { CID } from 'multiformats/cid';
import { create as digest } from 'multiformats/hashes/digest';
import { NodeWasmBindings, PrivateKeySigner, serializeDelegation } from '@tinycloud/node-sdk';
import { parseSignedCompactUcanAttenuation, parseSignedSiweCacao } from '@tinycloud/sdk-core';
import { parseArgs } from '../dist/args.js';
import { AGENT_GRANT, COURIER_SPACE, k, peerReadPermissions } from '../dist/keys.js';
import { courierNode, peerKv } from '../dist/node.js';
import { loadProfile, saveProfile, writeSecure } from '../dist/profile.js';
import { cmdWatch } from '../dist/watch-cmd.js';
import { issuedFixture } from './support/issued-fixture.mjs';
import { courierRegistryFixtureEnv, installCourierRegistryFixture } from './support/registry-fixture.mjs';

const START = Date.parse('2026-11-23T12:00:00Z');
const HOUR = 3_600_000;
const SIGNED_END = START + 30 * HOUR;
const RENEWED_END = START + 46 * HOUR;
const LEASE_END = START + 72 * HOUR;
const POLL_MS = 60_125; // distinct from SDK timers
const iso = (ms) => new Date(ms).toISOString();
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

// This fork runs the production watch command, not a recreated authority callback. Its only
// instrumentation is controllable wall time and the timer at which the polling loop parks.
async function runWatcher() {
  mock.timers.enable({ apis: ['Date'], now: START });
  const setTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== POLL_MS) return setTimeout(fn, ms, ...args);
    process.once('message', (at) => { mock.timers.setTime(at); fn(...args); });
    process.send('parked');
  };
  try {
    await cmdWatch(parseArgs(['--wake', 'none', '--notify', 'none', '--poll', String(POLL_MS / 1000), '--ticket', '300']));
  } catch (error) {
    console.error(error.stack);
    process.send({ stopped: error.code ?? error.message });
  } finally {
    process.disconnect();
  }
}

// Canonical DAG-CBOR subset for the stamp's small integer, text and map fields.
function stampBytes(value) {
  const head = (major, size) => Buffer.from(size < 24 ? [major | size] : [major | 24, size]);
  if (typeof value === 'number') return head(0, value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    assert.ok(bytes.length < 256);
    return Buffer.concat([head(0x60, bytes.length), bytes]);
  }
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || Buffer.from(a).compare(Buffer.from(b)));
  return Buffer.concat([head(0xa0, keys.length), ...keys.flatMap(key => [stampBytes(key), stampBytes(value[key])])]);
}

function renewer() {
  const seed = randomBytes(32);
  const pubkey = ed25519.getPublicKey(seed);
  const did = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...pubkey]))}`;
  const identity = { nodeDid: did, renewerDid: did, renewerPublicKey: Buffer.from(pubkey).toString('base64url'), renewerEpoch: 1 };
  return { identity, stamp(originalCid, leaseCid) {
    const bytes = stampBytes({ domain: 'tinycloud/node/renewal-stamp/v1', unsigned: {
      type: 'TinyCloudRenewalStamp', newEnd: iso(RENEWED_END).replace('.000Z', 'Z'), nodeDid: did, version: 1,
      originalCid, leaseCid, renewerEpoch: 1, leaseGeneration: 1, previousStampCid: leaseCid,
    } });
    return { cid: CID.createV1(0x55, digest(0x1e, blake3(bytes))).toString(), lease_cid: leaseCid, generation: 1,
      previous_stamp_cid: leaseCid, new_end: RENEWED_END / 1000, signed_bytes: bytes.toString('base64url'),
      signature: Buffer.from(ed25519.sign(bytes, seed)).toString('base64url') };
  } };
}

async function makeSide(root, host, handle, { identity, stamp }) {
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: iso(START) };
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const courierDid = key.did.split('#')[0];
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const params = { address, chainId: 1, domain: 'courier.test', issuedAt: iso(START), spaceId };
  const prepared = wasm.prepareSession({ ...params, abilities, expirationTime: iso(SIGNED_END), jwk: key.jwk });
  const signature = await signer.signMessage(prepared.siwe);
  const original = wasm.completeSessionSetup({ ...prepared, signature });
  const leaseRequest = wasm.prepareSession({ ...params, abilities: {}, delegateUri: identity.renewerDid,
    rawAbilities: { [`urn:cid:${original.delegationCid}`]: ['tinycloud.delegation/renew'] }, expirationTime: iso(LEASE_END) });
  const lease = wasm.completeSessionSetup({ ...leaseRequest, signature: await signer.signMessage(leaseRequest.siwe) });
  const leaseAuthorization = lease.delegationHeader.Authorization.replace(/^Bearer\s+/i, '');
  const parsed = await parseSignedSiweCacao(leaseAuthorization, lease.delegationCid);
  const grant = { v: 1, delegationHeader: original.delegationHeader, delegationCid: original.delegationCid, spaceId, ownerDid,
    address, chainId: 1, verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt: iso(SIGNED_END), receivedAt: iso(START),
    renewal: { version: 1, approvedAt: iso(START), approvedLeaseLifetimeSeconds: 72 * 3600, receipt: {
      originalCid: original.delegationCid, leaseCid: lease.delegationCid, leaseAuthorization, leaseExpiresAt: parsed.expiresAt,
      leaseGeneration: 1, nodeIdentity: identity,
    } } };
  const profile = { version: 4, host, openkeyHost: host, label: handle, selfHandle: handle, spaceId, ownerDid, courierDid,
    grantExpiresAt: grant.expiresAt, status: 'ready', peers: {} };
  const home = path.join(root, handle);
  fs.mkdirSync(home, { mode: 0o700 });
  for (const [name, value] of Object.entries({ profile, key, grant })) writeSecure(path.join(home, `${name}.json`), value);
  return { home, handle, profile, grant, stamp: stamp(original.delegationCid, lease.delegationCid) };
}

const wire = (delegation) => ({ cid: delegation.cid, delegation: serializeDelegation(delegation), expiresAt: delegation.expiry.toISOString() });
function verifiedPayload(authorization, cid) {
  const compact = authorization.replace(/^Bearer /i, '');
  parseSignedCompactUcanAttenuation(compact, cid);
  return JSON.parse(Buffer.from(compact.split('.')[1], 'base64url'));
}
const payload = (serialized) => {
  const { delegationHeader, cid } = JSON.parse(serialized);
  return verifiedPayload(delegationHeader.Authorization, cid);
};

function spawnWatcher(t, side, host) {
  const child = fork(fileURLToPath(import.meta.url), [], { execArgv: [], env: courierRegistryFixtureEnv(side.home, host), silent: true });
  const exited = once(child, 'exit');
  const messages = on(child, 'message', { close: ['exit'], signal: t.signal });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk; });
  t.after(async () => { child.kill(); await exited; });
  const next = async (expected) => assert.deepEqual((await messages.next()).value?.[0], expected, `${side.handle}: ${logs}`);
  return { parked: () => next('parked'), step: async (at, expected = 'parked') => { child.send(at); await next(expected); }, logs: () => logs };
}

if (process.send) await runWatcher();
else test('running watches renew and collect both child grants when verified owner ends advance', { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const api = issuedFixture();
  const signing = renewer();
  const status = new Map();
  const activated = new Set();
  const tickets = new Map();
  const canaryProofs = new Map();
  const streams = new Set();
  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/info') return json(res, { nodeId: signing.identity.nodeDid, features: ['delegation-issued-query-v1'] });
    if (req.url === '/.well-known/tinycloud/node-keys') return json(res, signing.identity);
    if (req.url === '/delegation/status') {
      const { cid } = await readBody(req);
      return json(res, { cid, ...status.get(cid) });
    }
    if (req.url === '/delegate') {
      const authorization = req.headers.authorization?.replace(/^Bearer /i, '');
      if (authorization?.split('.').length === 3) {
        const { cid } = parseSignedCompactUcanAttenuation(authorization);
        // Unlike the generic fixture, reactivating an existing CID must not reset its issuance time.
        if (activated.has(cid)) return json(res, { activated: [COURIER_SPACE], skipped: [] });
        activated.add(cid);
      }
    }
    if (req.url === '/hooks/tickets') {
      const { subscriptions } = await readBody(req);
      for (const { space, pathPrefix } of subscriptions) {
        if (pathPrefix === k.approvalsPrefix.slice(0, -1)) tickets.set(space, (tickets.get(space) ?? 0) + 1);
      }
      return json(res, { ticket: 'fixture' });
    }
    if (req.url.startsWith('/hooks/events?')) {
      streams.add(res);
      res.on('close', () => streams.delete(res));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ready\ndata: {"type":"ready"}\n\n');
      return;
    }
    if (req.url === '/invoke') {
      const p = verifiedPayload(req.headers.authorization);
      for (const [resource, actions] of Object.entries(p.att)) {
        if (actions['tinycloud.kv/list']) return json(res, []);
        if (resource.endsWith('/fixture.json') && actions['tinycloud.kv/get']) canaryProofs.set(resource, p.prf);
      }
    }
    await api.handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const res of streams) res.destroy(); server.closeAllConnections(); server.close(); });
  const host = `http://127.0.0.1:${server.address().port}`;
  installCourierRegistryFixture(host);
  const root = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, 'watch-owner-renewal-'));
  const sides = await Promise.all(['alice', 'bob'].map(handle => makeSide(root, host, handle, signing)));
  const directions = [sides, sides.toReversed()];
  const inHome = (side) => { process.env.COURIER_HOME = side.home; return loadProfile(); };
  const active = { exists: true, active: true, revoked: false, expired: false, status: 'active' };
  const sessionId = '01K00000000000000000000000';
  for (const [issuer, reader] of directions) {
    status.set(issuer.grant.delegationCid, { ...active, effective_expiry: SIGNED_END / 1000, renewal_history: [] });
    const node = await courierNode(inHome(issuer));
    assert.equal(node.sessionEnd.getTime(), SIGNED_END);
    const { delegation } = await node.delegateTo(reader.profile.courierDid, peerReadPermissions(reader.handle, issuer.profile.spaceId, sessionId),
      { expiry: '7d', requireActivation: true });
    issuer.initial = wire(delegation);
    assert.equal(payload(issuer.initial.delegation).exp, SIGNED_END / 1000);
    issuer.canary = `${k.threadRoot(reader.handle, sessionId)}/fixture.json`;
    assert.equal((await node.kv.put(issuer.canary, { issuer: issuer.handle }, { prefix: '' })).ok, true);
    api.seed(issuer.initial.delegation);
  }
  for (const [side, other] of directions) {
    const profile = inHome(side);
    profile.peers[other.handle] = { handle: other.handle, ownerDid: other.profile.ownerDid, courierDid: other.profile.courierDid,
      spaceId: other.profile.spaceId, theirHandleForMe: side.handle, sessionId, pairedAt: iso(START), status: 'paired',
      inbound: other.initial, outbound: [{ ...side.initial, issuedAt: iso(START) }] };
    saveProfile(profile);
  }
  const peerOf = (side, other) => inHome(side).peers[other.handle];
  async function readCanary(issuer, reader, cid) {
    const profile = inHome(reader);
    const kv = await peerKv(await courierNode(profile), profile, profile.peers[issuer.handle], { renew: false });
    const result = await kv.get(issuer.canary, { prefix: '' });
    assert.equal(result.ok, true);
    const data = result.data.data;
    assert.deepEqual(typeof data === 'string' ? JSON.parse(data) : data, { issuer: issuer.handle });
    assert.deepEqual(canaryProofs.get(`${issuer.profile.spaceId}/kv/${issuer.canary}`), [cid]);
  }
  for (const [issuer, reader] of directions) await readCanary(issuer, reader, issuer.initial.cid);
  const watchers = sides.map(side => spawnWatcher(t, side, host));
  await Promise.all(watchers.map(w => w.parked()));
  const ticketCounts = () => sides.map(s => tickets.get(s.profile.spaceId));
  assert.deepEqual(ticketCounts(), [1, 1]);
  const step = async (at) => {
    t.mock.timers.setTime(at);
    await Promise.all(watchers.map(w => w.step(at)));
  };

  for (const side of sides) status.set(side.grant.delegationCid,
    { ...active, effective_expiry: RENEWED_END / 1000, renewal_history: [side.stamp] });
  await step(START + 16 * HOUR);
  for (const side of sides) {
    const restored = await courierNode(inHome(side));
    assert.equal(await restored.getRenewalEffectiveExpiry(side.grant.renewal.receipt.leaseAuthorization), RENEWED_END / 1000);
    assert.equal(restored.sessionEnd.getTime(), RENEWED_END);
  }
  // The graph must rebind, but neither direction can sign before its 24h throttle.
  for (const [issuer, reader] of directions) assert.equal(peerOf(issuer, reader).outbound.at(-1).cid, issuer.initial.cid);
  await step(START + 25 * HOUR);
  await step(START + 25 * HOUR + 300_000); // Both prior marker writes are now visible on the normal housekeeping cadence.
  const successors = directions.map(([issuer, reader], i) => {
    const { outbound, interim } = peerOf(issuer, reader);
    const next = outbound.at(-1);
    assert.notEqual(next.cid, issuer.initial.cid, `${issuer.handle}'s persistent watcher did not issue a successor (${JSON.stringify(interim)})\n${watchers[i].logs()}`);
    assert.equal(peerOf(reader, issuer).inbound.cid, next.cid, `${reader.handle}'s persistent watcher did not install the successor`);
    const old = payload(issuer.initial.delegation);
    const signed = payload(next.delegation);
    for (const field of ['iss', 'aud', 'prf', 'att']) assert.deepEqual(signed[field], old[field]);
    assert.ok(Date.parse(next.issuedAt) < SIGNED_END);
    assert.equal(signed.exp * 1000, RENEWED_END);
    return next.cid;
  });
  assert.deepEqual(ticketCounts(), [2, 2], 'replace the self hook once, not on subsequent polls with the same verified end');

  await step(START + 31 * HOUR);
  for (const [i, [issuer, reader]] of directions.entries()) await readCanary(issuer, reader, successors[i]);

  status.set(sides[0].grant.delegationCid, { exists: true, active: false, revoked: true, expired: false, status: 'revoked' });
  await watchers[0].step(Date.now(), { stopped: 'owner-authority-refused' });
  t.mock.timers.setTime(LEASE_END + 1000);
  await watchers[1].step(Date.now(), { stopped: 'approval-required' });
});
