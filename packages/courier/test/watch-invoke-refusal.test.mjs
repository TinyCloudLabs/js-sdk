// TC-3522: a real /invoke denial can complete after another Courier installs its successor.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { NodeWasmBindings, PrivateKeySigner, serializeDelegation } from '@tinycloud/node-sdk';
import { defer } from '../dist/defer.js';
import { Watcher } from '../dist/watch.js';
import { maintainPeerSet } from '../dist/interim-runtime.js';
import { AGENT_GRANT, k, peerReadPermissions } from '../dist/keys.js';
import { courierNode } from '../dist/node.js';
import { loadProfile, saveProfile, writeSecure } from '../dist/profile.js';
import { issuedFixture } from './support/issued-fixture.mjs';
import { installCourierRegistryFixture } from './support/registry-fixture.mjs';

const DAY = 86_400_000;
const START = Date.parse('2026-11-23T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const inbound = d => ({ cid: d.cid, expiresAt: d.expiry.toISOString(), delegation: serializeDelegation(d) });

test('watch attributes /invoke refusals to the signed proof and retries a suspended invocation', { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const fixture = issuedFixture();
  const oldRequest = defer();
  const respondToOld = defer();
  const probes = [];
  const suspended = defer();
  const sendAfterResume = defer();
  const resumeExpiries = [];
  let suspendNext = false;
  let oldCid;
  let refuseCurrent = false;
  let outboundQueries = 0;
  let outboundUnverified = false;
  let keepOutboundUnverified = false;
  let refuseTimeOnce = false;
  let refusePausedOnce = false;
  const pausedProofs = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/delegation/query' && outboundUnverified && (outboundQueries++ === 0 || keepOutboundUnverified)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 2, items: [] }));
      return;
    }
    if (req.url === '/invoke') {
      const authorization = req.headers.authorization;
      const p = JSON.parse(Buffer.from(authorization.split('.')[1], 'base64url'));
      if (Object.entries(p.att).some(([resource, actions]) => resource.endsWith('/paused/') && actions['tinycloud.kv/list'])) {
        pausedProofs.push(...p.prf);
        if (refusePausedOnce) {
          refusePausedOnce = false;
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Invocation expired or not yet valid');
          return;
        }
      }
      if (Object.keys(p.att).some(resource => resource.endsWith(`/kv/${k.peerDelegation('alice')}`))) {
        assert.equal(p.prf.length, 1);
        const [proof] = p.prf;
        probes.push(proof);
        if (suspendNext) resumeExpiries.push(p.exp);
        if (proof === oldCid) { oldRequest.resolve(); await respondToOld.promise; }
        if (refuseTimeOnce) {
          refuseTimeOnce = false;
          assert.ok(p.exp > Date.now() / 1000, 'sender clock still sees a valid invocation');
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Invocation expired or not yet valid');
          return;
        }
        if (proof === oldCid || refuseCurrent || (suspendNext && p.exp <= Date.now() / 1000)) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end(suspendNext ? 'Invocation expired or not yet valid' : 'denied by the loopback fixture');
          return;
        }
      }
    }
    await fixture.handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { respondToOld.resolve(); sendAfterResume.resolve(); server.closeAllConnections(); server.close(); });
  const host = `http://127.0.0.1:${server.address().port}`;
  installCourierRegistryFixture(host);
  const fixtureFetch = globalThis.fetch;
  const registryFetch = Object.assign(async (input, init) => {
    if (suspendNext && String(input) === `${host}/invoke`) {
      const signed = new Headers(init.headers).get('authorization');
      const p = JSON.parse(Buffer.from(signed.split('.')[1], 'base64url'));
      if (!resumeExpiries.length && Object.keys(p.att).some(resource => resource.endsWith(`/kv/${k.peerDelegation('alice')}`))) {
        suspended.resolve(p.exp);
        await sendAfterResume.promise; // Signed, not yet sent to the node.
      }
    }
    return fixtureFetch(input, init);
  }, { preconnect: fixtureFetch.preconnect });
  globalThis.fetch = registryFetch;
  t.after(() => { globalThis.fetch = fixtureFetch; });

  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  async function owner(handle, seed) {
    const home = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, `${handle}-`));
    const id = manager.createSessionKey(handle);
    const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: iso(START) };
    const signer = new PrivateKeySigner(seed.padStart(64, '0'));
    const address = await signer.getAddress();
    const spaceId = wasm.makeSpaceId(address, 1, 'agents');
    const ownerDid = `did:pkh:eip155:1:${address}`;
    const expiresAt = iso(START + 30 * DAY);
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: iso(START),
      expirationTime: expiresAt, spaceId, jwk: key.jwk });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    writeSecure(path.join(home, 'key.json'), key);
    writeSecure(path.join(home, 'grant.json'), { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid,
      spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt, receivedAt: iso(START) });
    const profile = { version: 4, host, openkeyHost: host, label: handle, selfHandle: handle, courierDid: key.did.split('#')[0],
      ownerDid, spaceId, grantExpiresAt: expiresAt, status: 'ready', peers: {} };
    return { home, profile, node: await courierNode(profile, home) };
  }
  const [alice, bob] = [await owner('alice', '1'), await owner('bob', '2')];
  process.env.COURIER_HOME = alice.home;
  const issue = async (from, to, expiry) => (await from.node.delegateTo(to.profile.courierDid,
    peerReadPermissions(to.profile.selfHandle, from.profile.spaceId), { expiry, requireActivation: true })).delegation;
  const fromAlice = await issue(alice, bob, '2d');
  const original = await issue(bob, alice, '1d');
  const successor = await issue(bob, alice, '2d');
  oldCid = original.cid;
  alice.profile.peers.bob = { handle: 'bob', courierDid: bob.profile.courierDid, ownerDid: bob.profile.ownerDid,
    spaceId: bob.profile.spaceId, theirHandleForMe: 'alice', status: 'paired', pairedAt: iso(START), inbound: inbound(original),
    outbound: [{ ...inbound(fromAlice), issuedAt: iso(START) }] };
  saveProfile(alice.profile);

  const collect = () => maintainPeerSet(alice.node, 'bob', true, true);
  const inFlight = collect();
  const settled = inFlight.catch(error => error);
  await oldRequest.promise;
  const latest = loadProfile();
  latest.peers.bob.inbound = inbound(successor);
  saveProfile(latest);
  fixture.seed(serializeDelegation(successor));
  respondToOld.resolve();
  assert.ifError(await settled);
  assert.deepEqual(probes, [oldCid, successor.cid], 'only the installed successor is retried');
  assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, undefined);

  outboundUnverified = true;
  suspendNext = true;
  const whileSuspending = collect().catch(error => error);
  const expiredAt = await suspended.promise;
  assert.ok(loadProfile().peers.bob.interim?.unavailableAt, 'the first outbound check could not verify the child');
  t.mock.timers.setTime((expiredAt + 1) * 1000);
  sendAfterResume.resolve();
  assert.ifError(await whileSuspending);
  suspendNext = false;
  assert.equal(outboundQueries, 2, 'the retry also rechecks outstanding outbound authority');
  assert.equal(loadProfile().peers.bob.interim?.unavailableAt, undefined, 'only the successful outbound recheck clears the marker');
  outboundUnverified = false;
  assert.equal(resumeExpiries.length, 2, 're-signs once after suspend');
  assert.ok(resumeExpiries[1] > Date.now() / 1000, 'the retry uses a fresh signature');
  assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, undefined);

  // The node's exact timestamp reason also applies when the sender's clock still
  // considers the signature valid. An inbound success cannot clear a failed outbound recheck.
  outboundUnverified = keepOutboundUnverified = refuseTimeOnce = true;
  outboundQueries = 0;
  await assert.rejects(collect(), { code: 'authority-unverified' });
  assert.equal(outboundQueries, 2);
  assert.ok(loadProfile().peers.bob.interim?.unavailableAt);
  outboundUnverified = false;
  assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, undefined);

  const watcher = new Watcher({
    selfKv: alice.node.kv, spaceId: alice.profile.spaceId, loadPeers: () => Object.values(loadProfile().peers),
    checkAuthority: async handle => { assert.equal(handle, 'bob'); await collect(); },
    log() {},
  }, { pollMs: 60_000, ticketSeconds: 25, debounceMs: 30_000, wakeBudget: 12 });
  refusePausedOnce = true;
  await watcher.syncPaused();
  assert.deepEqual(pausedProofs, Array(2).fill(alice.node.restorableSession.delegationCid), 're-signs the owner pause-list invocation once');
  assert.equal(loadProfile().peers.bob.interim?.unavailableAt, undefined, 'successful re-sign promptly runs an outbound recheck');

  refuseCurrent = true;
  await collect();
  assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, iso(Date.now()));
  assert.deepEqual(probes, [oldCid, ...Array(7).fill(successor.cid)],
    'only the successor is used after installation, and a genuine denial is not retried');
});

test('an unattributed 401 stays dirty and the next watcher cycle can read again', async () => {
  const peer = { handle: 'bob', theirHandleForMe: 'alice', status: 'paired',
    inbound: { cid: 'current-proof', expiresAt: iso(START + DAY) } };
  const spaceId = 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents';
  let peerLists = 0;
  let refused = true;
  const own = { list: async () => ({ ok: true, data: { keys: [] } }) };
  const watcher = new Watcher({
    selfKv: own, spaceId, loadPeers: () => [peer],
    kvFor: async () => ({ list: async () => {
      peerLists++;
      return refused ? { ok: false, error: { status: 401 } } : own.list();
    } }),
    onAuthorityRefusal: async () => assert.fail('an unattributed 401 must not latch'),
    log() {},
  }, { pollMs: 60_000, ticketSeconds: 25, debounceMs: 30_000, wakeBudget: 12 });
  await watcher.sync(peer, 'hook');
  assert.equal(peerLists, 2, 'one immediate re-sign');
  refused = false;
  await watcher.syncDirty();
  assert.equal(peerLists, 3, 'the next cycle retries the still-dirty peer');
});
