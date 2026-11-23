// TC-3522: the scheduled issuance path must fit inside a short parent-clamped child window.
// Use real SDK signing against loopback storage, and independently restore later parent grants.
// Watcher rollover and same-CID node stamp verification are covered separately.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { deserializeDelegation, NodeWasmBindings, PrivateKeySigner, TinyCloudNode, serializeDelegation } from '@tinycloud/node-sdk';
import { maintainOutbound, successorRecord } from '../dist/interim-renewal.js';
import { AGENT_GRANT, COURIER_SPACE, k, peerReadPermissions } from '../dist/keys.js';
import { nodeOpts } from '../dist/node.js';
import { getJson } from '../dist/store.js';
import { issuedFixture } from './support/issued-fixture.mjs';
import { installCourierRegistryFixture } from './support/registry-fixture.mjs';

const MINUTE = 60_000;
const START = Date.parse('2026-11-23T12:00:00Z');
const at = (minutes) => START + minutes * MINUTE;

test('a parent-clamped 30-minute child renews after half-life without force or manual issuance', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const fixture = issuedFixture();
  const server = http.createServer(fixture.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const host = `http://127.0.0.1:${server.address().port}`;
  installCourierRegistryFixture(host);

  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const issuerId = manager.createSessionKey('courier');
  const readerId = manager.createSessionKey('peer');
  const jwk = JSON.parse(manager.jwk(issuerId));
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const courierDid = manager.getDID(issuerId).split('#')[0];
  const peer = { handle: 'bob', courierDid: manager.getDID(readerId).split('#')[0], status: 'paired', outbound: [] };
  const courier = { version: 4, spaceId, courierDid, peers: { bob: peer } };
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  async function restoreParent(end) {
    const expiresAt = new Date(end).toISOString();
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test',
      issuedAt: new Date(START).toISOString(), expirationTime: expiresAt, spaceId, jwk });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    const node = new TinyCloudNode(nodeOpts(host));
    await node.restoreSession({ ...session, spaceId, address, chainId: 1, jwk, verificationMethod: manager.getDID(issuerId),
      siwe: prepared.siwe, signature, expiresAt, tinycloudHosts: [host] });
    return node;
  }

  const initialParent = await restoreParent(at(30));
  const { delegation: original } = await initialParent.delegateTo(peer.courierDid, peerReadPermissions(peer.handle, spaceId),
    { expiry: '7d', requireActivation: true });
  assert.equal(original.expiry.getTime(), at(30));
  const delegation = serializeDelegation(original);
  peer.outbound.push({ cid: original.cid, delegation, expiresAt: original.expiry.toISOString(), issuedAt: new Date(START).toISOString() });
  fixture.seed(delegation);
  let node = await restoreParent(at(46));
  const marker = k.peerDelegation(peer.handle);
  const published = async () => deserializeDelegation((await getJson(node.kv, marker)).value.delegation);
  const maintain = (options) => maintainOutbound(node, courier, peer, () => {}, options);

  t.mock.timers.setTime(at(15) - 1000);
  assert.equal((await maintain()).state, 'live');
  assert.equal((await published()).cid, original.cid, 'the half-life wait still applies');
  t.mock.timers.setTime(at(15));
  assert.equal((await maintain({ manual: true })).state, 'live');
  assert.equal((await published()).cid, original.cid, 'explicit pairing commands retain their existing throttle');
  const result = await maintain();
  assert.equal(result.state, 'renewed', 'a 24h cooldown cannot outlive the 30m child');
  const successor = await published();
  assert.equal(successor.cid, result.delegation.cid);
  assert.equal(successor.expiry.getTime(), at(46));
  assert.deepEqual(successorRecord(node, successor).resources, successorRecord(node, original).resources);
  assert.equal(peer.outbound.at(-1).priorCid, original.cid);

  // Another short window carries its own cooldown, even after the first child has expired.
  t.mock.timers.setTime(at(31));
  node = await restoreParent(at(61));
  const next = await maintain();
  assert.equal(next.state, 'renewed');
  assert.equal((await published()).cid, next.delegation.cid);
  assert.equal(next.delegation.expiry.getTime(), at(61));
  assert.equal(peer.outbound.at(-1).priorCid, successor.cid);
});
