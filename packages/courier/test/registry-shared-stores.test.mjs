// TC-2970: every node a Courier process creates shares one registry verdict cache, one sequence store and one
// saved-settings store. The SDK serves a cached verdict only to a node whose own stores agree with it, so for an owner
// with a registry record, nodes that each kept their own stores would each look the owner up again. Synthetic owner
// key; the registry answers with a record that owner signed, routing its space to the loopback fixture node.
import { issuedFixture } from './support/issued-fixture.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL, registryOwnerSubjectV1, signLocationRecordV2 } from '@tinycloud/sdk-core';
import { AGENT_GRANT, COURIER_SPACE, PREFIX } from '../dist/keys.js';
import { courierNode } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';

const wasm = new NodeWasmBindings();
const fixtureApi = issuedFixture({});
const stub = http.createServer((req, res) => { void fixtureApi.handle(req, res); });
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());

test('two Courier nodes of one process look a registered owner up once: they share the cache and the registry stores', async () => {
  const home = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, 'shared-stores-'));
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
  const abilities = {};
  for (const permission of AGENT_GRANT) (abilities[permission.service.replace(/^tinycloud\./, '')] ??= {})[permission.path] = permission.actions;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: now.toISOString(), expirationTime: expiresAt.toISOString(), spaceId, jwk: key.jwk });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, ownerDid, address, chainId: 1,
    verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt: expiresAt.toISOString(), receivedAt: now.toISOString() };
  const profile = { version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: 'registered', selfHandle: 'registered', courierDid: key.did.split('#', 1)[0],
    ownerDid, spaceId, grantExpiresAt: grant.expiresAt, status: 'ready', peers: {} };
  for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) fs.writeFileSync(path.join(home, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });

  const { nodeId } = await (await fetch(`${HOST}/info`)).json();
  const record = await signLocationRecordV2({
    version: 2, subject: registryOwnerSubjectV1(address), nodes: [{ did: nodeId, url: HOST }],
    spaces: [{ space: spaceId, nodes: [{ did: nodeId, mode: 'read-write' }] }], encryptionNode: null,
    updated_at: now.toISOString(), sequence: 1,
  }, { type: 'did:pkh', signMessage: (message) => signer.signMessage(message) });

  // The registry: this owner's signed record on v2, no record for anyone else. Nothing else leaves the loopback host.
  const registry = new URL(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).origin;
  const lookups = { v2: 0, v1: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === registry) {
      const version = url.pathname.split('/')[1];
      const owner = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1)).split(':').at(-1).toLowerCase();
      if (owner === address.toLowerCase()) lookups[version]++;
      return version === 'v2' && owner === address.toLowerCase()
        ? Response.json({ record })
        : Response.json({ error: 'location record not found' }, { status: 404 });
    }
    if (url.origin !== HOST) throw new Error(`Non-fixture origin refused: ${url.origin}`);
    return real(input, init);
  }, { preconnect: real.preconnect });
  try {
    process.env.COURIER_HOME = home;
    const loaded = loadProfile();
    const first = await courierNode(loaded, home);
    for (let i = 0; i < 5; i++) await first.kv.get(`${PREFIX}/me/probe/a${i}.json`);
    const second = await courierNode(loaded, home);
    for (let i = 0; i < 5; i++) await second.kv.get(`${PREFIX}/me/probe/b${i}.json`);
    assert.deepEqual(lookups, { v2: 1, v1: 0 });
  } finally {
    globalThis.fetch = real;
  }
});
