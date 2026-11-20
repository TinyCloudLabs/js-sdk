import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { issuedFixture } from './issued-fixture.mjs';
import { installCourierRegistryFixture } from './registry-fixture.mjs';
import { AGENT_GRANT, peerReadPermissions } from '../../dist/keys.js';
import { saveProfile, loadProfile, writeSecure } from '../../dist/profile.js';
import { courierNode } from '../../dist/node.js';
import { cmdRevoke } from '../../dist/commands.js';
import { parseArgs } from '../../dist/args.js';

export async function concurrentRevokes(t, samePeer = false) {
  const home = process.env.COURIER_HOME;
  const lock = path.join(home, 'profile.json.lock');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const api = issuedFixture();
  let arrivals = 0;
  let release;
  const queries = new Promise(resolve => { release = resolve; });
  let concurrent = false;
  const server = http.createServer(async (req, res) => {
    if (concurrent && req.url === '/delegation/query') {
      if (++arrivals === 2) release();
      await queries;
    }
    await api.handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `http://127.0.0.1:${server.address().port}`;
  process.env.TC_LINKS_API_ORIGIN = host;
  process.env.COURIER_OPENKEY_API_HOST = host;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, host, 'network stays on the local fixture');
    assert.equal(fs.existsSync(lock), false, `profile lock absent at ${url.pathname}`);
    return realFetch(input, init);
  });
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
  const owner = new PrivateKeySigner('1'.padStart(64, '0'));
  installCourierRegistryFixture(host);
  const address = await owner.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, 'agents');
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: new Date().toISOString(), expirationTime: expiresAt, spaceId, jwk: key.jwk });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const profile = { version: 3, host, openkeyHost: host, label: 'fixture', courierDid: key.did.split('#')[0], ownerDid, spaceId, status: 'ready', peers: {} };
  writeSecure(path.join(home, 'key.json'), key);
  writeSecure(path.join(home, 'grant.json'), { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, siwe: prepared.siwe, signature, expiresAt, spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did });
  saveProfile(profile);
  const node = await courierNode(profile);
  for (const handle of samePeer ? ['bob'] : ['bob', 'carol']) {
    const peerId = manager.createSessionKey(handle);
    const courierDid = manager.getDID(peerId).split('#')[0];
    const { delegation } = await node.delegateTo(courierDid, peerReadPermissions(handle, spaceId), { expiry: '1h', requireActivation: true });
    profile.peers[handle] = { handle, courierDid, ownerDid, spaceId, status: 'paired', pairedAt: new Date().toISOString(), outbound: [{ cid: delegation.cid, issuedAt: new Date().toISOString(), expiresAt: delegation.expiry.toISOString() }] };
  }
  saveProfile(profile);
  concurrent = true;
  const output = [];
  t.mock.method(console, 'log', line => output.push(line));
  await Promise.all(['bob', samePeer ? 'bob' : 'carol'].map(handle => cmdRevoke(parseArgs([handle]))));
  assert.equal(arrivals, 2, 'both commands queried before either revoke completed');
  assert.deepEqual(loadProfile().peers, {}, 'both peer removals land without losing a writer');
  assert.equal(output.length, 2, 'both commands complete successfully');
  assert.equal(fs.existsSync(lock), false);
}
