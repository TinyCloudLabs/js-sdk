// TC-2380: an `awaiting-space` profile with a leased owner grant heals on the automatic owner preflight, through
// `createRuntimeNode`, and inside a profile transaction, without waiting on its own profile lock (LOCK_WAIT_MS is 10 s).
// Real SDK signing and lease verification against an owned loopback node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { bases } from 'multiformats/basics';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { parseSignedSiweCacao } from '@tinycloud/sdk-core';
import { AGENT_GRANT, COURIER_SPACE } from '../dist/keys.js';
import { courierNode } from '../dist/node.js';
import { loadProfile, withProfileTransaction, writeSecure } from '../dist/profile.js';
import { preflightOwner } from '../dist/interim-owner.js';
import { createRuntimeNode } from '../dist/interim-runtime.js';
import { newestPending, savePending } from '../dist/pending.js';
import { installCourierRegistryFixture } from './support/registry-fixture.mjs';

const HOUR = 3_600_000;
/** Well under the profile lock's 10 s wait: a heal that waits on its own lock cannot finish inside it. */
const NO_STALL_MS = 5_000;
const iso = (ms) => new Date(ms).toISOString();
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const wasm = new NodeWasmBindings();

const seed = randomBytes(32);
const renewerPublicKey = ed25519.getPublicKey(seed);
const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
const identity = { nodeDid: renewerDid, renewerDid, renewerPublicKey: Buffer.from(renewerPublicKey).toString('base64url'), renewerEpoch: 1 };

// The node: hosts every space, has not renewed any grant yet (the grant holds to its signed end), and counts space reads.
const signedEnds = new Map();
let probes = 0;
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/info') return json(res, { nodeId: identity.nodeDid });
  if (req.url === '/.well-known/tinycloud/node-keys') return json(res, identity);
  if (req.url === '/delegation/status') {
    const { cid } = await readBody(req);
    return json(res, { cid, exists: true, active: true, revoked: false, expired: false, status: 'active',
      effective_expiry: signedEnds.get(cid) / 1000, renewal_history: [] });
  }
  if (req.url === '/invoke') { probes++; return json(res, []); }
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const host = `http://127.0.0.1:${server.address().port}`;
installCourierRegistryFixture(host);
test.after(() => { server.closeAllConnections(); server.close(); });

/** A home whose profile is `awaiting-space` with a leased owner grant, and a pending record for that grant. */
async function leasedAwaitingHome() {
  const start = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  const signedEnd = start + 30 * HOUR;
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: iso(start) };
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const params = { address, chainId: 1, domain: 'courier.test', issuedAt: iso(start), spaceId };
  const prepared = wasm.prepareSession({ ...params, abilities, expirationTime: iso(signedEnd), jwk: key.jwk });
  const signature = await signer.signMessage(prepared.siwe);
  const original = wasm.completeSessionSetup({ ...prepared, signature });
  const leaseRequest = wasm.prepareSession({ ...params, abilities: {}, delegateUri: identity.renewerDid,
    rawAbilities: { [`urn:cid:${original.delegationCid}`]: ['tinycloud.delegation/renew'] }, expirationTime: iso(start + 72 * HOUR) });
  const lease = wasm.completeSessionSetup({ ...leaseRequest, signature: await signer.signMessage(leaseRequest.siwe) });
  const leaseAuthorization = lease.delegationHeader.Authorization.replace(/^Bearer\s+/i, '');
  const parsed = await parseSignedSiweCacao(leaseAuthorization, lease.delegationCid);
  const grant = { v: 1, delegationHeader: original.delegationHeader, delegationCid: original.delegationCid, spaceId, ownerDid,
    address, chainId: 1, verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt: iso(signedEnd), receivedAt: iso(start),
    renewal: { version: 1, approvedAt: iso(start), approvedLeaseLifetimeSeconds: 72 * 3600, receipt: {
      originalCid: original.delegationCid, leaseCid: lease.delegationCid, leaseAuthorization, leaseExpiresAt: parsed.expiresAt,
      leaseGeneration: 1, nodeIdentity: identity,
    } } };
  const profile = { version: 4, host, openkeyHost: host, label: 'leased', spaceId, ownerDid, courierDid: key.did.split('#')[0],
    grantExpiresAt: grant.expiresAt, status: 'awaiting-space', peers: {} };
  signedEnds.set(grant.delegationCid, signedEnd);
  const home = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, 'heal-leased-'));
  fs.chmodSync(home, 0o700);
  process.env.COURIER_HOME = home;
  for (const [name, value] of Object.entries({ profile, key, grant })) writeSecure(path.join(home, `${name}.json`), value);
  savePending('ABCD-EFGH', { ...grant }, new Date(signedEnd));
  assert.equal(newestPending()?.delegationCid, grant.delegationCid);
  probes = 0;
  return { home, grant };
}

async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

function assertHealed() {
  const saved = loadProfile();
  assert.equal(saved.status, 'ready');
  assert.equal('spacePending' in saved, false);
  assert.equal(newestPending(), undefined, 'the healed grant\'s pending record is dropped');
}

test('the automatic owner preflight heals a leased awaiting-space profile without waiting on its own profile lock', async () => {
  await leasedAwaitingHome();

  const { value: preflight, ms } = await timed(() => preflightOwner({ watchSession: true }));

  assert.ok(ms < NO_STALL_MS, `preflight took ${Math.round(ms)} ms`);
  assert.equal(preflight.state, 'live');
  assert.ok(preflight.node instanceof TinyCloudNode);
  assert.equal(probes, 1, 'one space read');
  assertHealed();
});

test('createRuntimeNode (every automatic command) heals a leased awaiting-space profile once, without a stall', async () => {
  await leasedAwaitingHome();

  const { value: node, ms } = await timed(() => createRuntimeNode());

  assert.ok(ms < NO_STALL_MS, `createRuntimeNode took ${Math.round(ms)} ms`);
  assert.ok(node instanceof TinyCloudNode);
  assert.equal(probes, 1, 'healed by the preflight; the runtime node needs no second read');
  assertHealed();
});

test('courierNode heals a leased awaiting-space profile inside a profile transaction, and the transaction still saves', async () => {
  await leasedAwaitingHome();

  const { ms } = await timed(() => withProfileTransaction(async (profile, save) => {
    assert.ok(await courierNode(profile) instanceof TinyCloudNode);
    assert.equal(profile.status, 'ready');
    profile.label = 'saved-by-transaction';
    save();
  }));

  assert.ok(ms < NO_STALL_MS, `transaction took ${Math.round(ms)} ms`);
  assert.equal(probes, 1);
  assertHealed();
  assert.equal(loadProfile().label, 'saved-by-transaction');
});
