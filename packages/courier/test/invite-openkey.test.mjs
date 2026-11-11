import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { openKeyInviteTransport } from '../dist/invite-openkey.js';

const manager = new NodeWasmBindings().createSessionManager();
const keyId = manager.createSessionKey('agent');
const key = { v: 1, did: manager.getDID(keyId).split('#')[0], jwk: JSON.parse(manager.jwk(keyId)), createdAt: new Date().toISOString() };

const pending = () => ({
  transport: {
    requestId: 'r'.repeat(26), bodyCid: 'bafy-test', record: { header: {}, signature: 'sig' }, request: {},
    apiOrigin: 'https://openkey.example', relayPrivateKey: 'x', ackId: 'ack',
  },
});

const poll = (status, body) => openKeyInviteTransport({
  fetch: async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
}).poll(pending(), key);

test('OpenKey reports a denied approval as 410 expired_request with status denied: Courier reads it as denied', async () => {
  assert.deepEqual(await poll(410, { code: 'expired_request', status: 'denied', deniedAt: new Date().toISOString() }), { status: 'denied' });
});

test('a request that simply ran out of time is expired, not denied', async () => {
  assert.deepEqual(await poll(410, { code: 'expired_request' }), { status: 'expired' });
  assert.deepEqual(await poll(410, { code: 'expired_result' }), { status: 'expired' });
});

test('a request that is not yet approved stays pending, and an unknown one is refused', async () => {
  assert.deepEqual(await poll(202, { status: 'pending' }), { status: 'pending' });
  await assert.rejects(poll(404, { code: 'not_found' }), { code: 'approval-unavailable' });
});
