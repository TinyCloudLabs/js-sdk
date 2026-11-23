// TC-3522: a marker-triggered authority check can overlap automatic housekeeping in one watcher.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { NodeWasmBindings, PrivateKeySigner, serializeDelegation } from '@tinycloud/node-sdk';
import { defer } from '../dist/defer.js';
import { maintainPeerSet } from '../dist/interim-runtime.js';
import { AGENT_GRANT, COURIER_SPACE, k, peerReadPermissions } from '../dist/keys.js';
import { courierNode } from '../dist/node.js';
import { loadProfile, saveProfile, writeSecure } from '../dist/profile.js';
import { getJson } from '../dist/store.js';
import { issuedFixture } from './support/issued-fixture.mjs';
import { installCourierRegistryFixture } from './support/registry-fixture.mjs';

const START = Date.parse('2026-11-23T12:00:00Z');
const HOUR = 3_600_000;
const iso = ms => new Date(ms).toISOString();

async function setup(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const fixture = issuedFixture();
  const server = http.createServer(fixture.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const host = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  installCourierRegistryFixture(host);

  const originalHome = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, 'outbound-overlap-'));
  process.env.COURIER_HOME = home;
  t.after(() => { process.env.COURIER_HOME = originalHome; });
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const keyOf = (handle) => {
    const id = manager.createSessionKey(handle);
    return { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: iso(START) };
  };
  const key = keyOf('alice');
  const reader = keyOf('bob');
  const signer = new PrivateKeySigner('1'.padStart(64, '0'));
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const expiresAt = iso(START + 46 * HOUR);
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: iso(START),
    expirationTime: expiresAt, spaceId, jwk: key.jwk });
  const signature = await signer.signMessage(prepared.siwe);
  const grant = wasm.completeSessionSetup({ ...prepared, signature });
  writeSecure(path.join(home, 'key.json'), key);
  writeSecure(path.join(home, 'grant.json'), { v: 1, delegationHeader: grant.delegationHeader, delegationCid: grant.delegationCid,
    spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt, receivedAt: iso(START) });
  const profile = { version: 4, host, openkeyHost: host, label: 'alice', selfHandle: 'alice', courierDid: key.did.split('#')[0],
    ownerDid, spaceId, grantExpiresAt: expiresAt, status: 'ready', peers: {} };
  const node = await courierNode(profile);
  const bob = reader.did.split('#')[0];
  const { delegation: original } = await node.delegateTo(bob, peerReadPermissions('bob', spaceId), { expiry: '30h', requireActivation: true });
  fixture.seed(serializeDelegation(original));
  profile.peers.bob = { handle: 'bob', courierDid: bob, spaceId, ownerDid, theirHandleForMe: 'alice', status: 'paired',
    pairedAt: iso(START), inbound: { cid: 'inbound', delegation: 'not used by outbound checks', expiresAt },
    outbound: [{ cid: original.cid, issuedAt: iso(START), expiresAt: original.expiry.toISOString() }] };
  saveProfile(profile);
  t.mock.timers.setTime(START + 25 * HOUR);

  const managerApi = node.delegationManager;
  const list = managerApi.queryAllIssued.bind(managerApi);
  const assertPublished = async (cid) => {
    const after = await list({ space: spaceId });
    assert.equal(after.ok, true);
    assert.equal(after.data.find(record => record.cid === cid)?.status, 'active',
      'an overlapping check revoked the successor as an orphan');
    const peer = loadProfile().peers.bob;
    assert.equal(peer.outbound.at(-1).cid, cid);
    assert.equal(peer.interim?.cleanup[cid], undefined);
    const marker = await getJson(node.kv, k.peerDelegation('bob'));
    assert.equal(JSON.parse(marker.value.delegation).cid, cid);
  };
  return { node, managerApi, list, assertPublished, bob, spaceId, original, fixture };
}

test('an overlapping watcher check does not revoke a successor while housekeeping records it', { timeout: 15000 }, async (t) => {
  const { node, managerApi, list, assertPublished } = await setup(t);

  const issued = defer();
  const release = defer();
  t.after(() => release.resolve());
  const delegateTo = node.delegateTo.bind(node);
  t.mock.method(node, 'delegateTo', async (...args) => {
    const result = await delegateTo(...args);
    issued.resolve(result.delegation.cid); // /delegate succeeded; the receipt has not reached the profile yet.
    await release.promise;
    return result;
  });
  let markerCheckReadNode = false;
  let betweenActivationAndReceipt = false;
  t.mock.method(managerApi, 'queryAllIssued', (...args) => {
    markerCheckReadNode ||= betweenActivationAndReceipt;
    return list(...args);
  });

  const housekeeping = maintainPeerSet(node);
  const successorCid = await issued.promise;
  betweenActivationAndReceipt = true;
  const markerCheck = maintainPeerSet(node, 'bob');
  // If the second check has already read the uncommitted candidate, let it finish this
  // stale-ledger path before restoring housekeeping. A queued check has no node read yet.
  try { if (markerCheckReadNode) await markerCheck; }
  finally { betweenActivationAndReceipt = false; release.resolve(); }
  await Promise.all([housekeeping, markerCheck]);

  await assertPublished(successorCid);
});

test('orphan cleanup cannot revoke a successor just recorded by another writer', { timeout: 15000 }, async (t) => {
  const { node, managerApi, list, assertPublished, bob, spaceId, original, fixture } = await setup(t);
  const inspecting = defer();
  const resume = defer();
  t.after(() => resume.resolve());
  let first = true;
  t.mock.method(managerApi, 'queryAllIssued', async (...args) => {
    if (first) {
      first = false;
      inspecting.resolve();
      await resume.promise; // The check took its profile snapshot before the other writer publishes.
    }
    return list(...args);
  });
  const reconciliation = maintainPeerSet(node);
  await inspecting.promise;
  try {
    // A separate writer records its activated child while the watcher holds the old
    // ledger. Only outbound changes, so the general profile merge cannot fence cleanup.
    const { delegation } = await node.delegateTo(bob, peerReadPermissions('bob', spaceId), { expiry: '7d', requireActivation: true });
    const disk = loadProfile();
    const wire = serializeDelegation(delegation);
    disk.peers.bob.outbound.push({ cid: delegation.cid, priorCid: original.cid, delegation: wire,
      issuedAt: iso(Date.now()), expiresAt: delegation.expiry.toISOString() });
    saveProfile(disk);
    fixture.seed(wire);
    resume.resolve();
    await reconciliation;
    await assertPublished(delegation.cid);
  } finally {
    resume.resolve();
  }
});
