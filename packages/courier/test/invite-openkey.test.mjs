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

// ---- the result's own binding to this request (independent of the owner-signed Request ID) -----------------------------------

import { createCipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

const RELAY_REQUEST = { requestId: 'r'.repeat(26), bodyCid: 'bafy-request-digest' };
const relay = createECDH('prime256v1');
relay.generateKeys();
const relayPoint = relay.getPublicKey();

/** What OpenKey returns: the result JSON, encrypted to this request's relay key with the request id as HKDF salt and AAD. */
function sealResult(inner, aad = RELAY_REQUEST.requestId) {
  const ephemeral = createECDH('prime256v1');
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(relayPoint);
  const extracted = createHmac('sha256', Buffer.from(aad)).update(shared).digest();
  const aes = createHmac('sha256', extracted).update('openkey-device-relay-v1').update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aes, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(inner), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const point = ephemeral.getPublicKey();
  return { version: 1, algorithm: 'ECDH-P256-A256GCM', ephemeralPublicJwk: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

const goodInner = () => ({
  resultVersion: 1, requestId: RELAY_REQUEST.requestId, requestDigest: RELAY_REQUEST.bodyCid, requesterDid: key.did, targetDid: key.did,
  delegation: { delegationCid: 'cid', siwe: 'siwe', signature: 'sig' },
});

const resultPoll = (inner, outer = {}) => openKeyInviteTransport({
  fetch: async (input) => {
    const url = String(input);
    if (url.endsWith('/result')) return Response.json({ resultRef: 'ref'.repeat(10), expiresAt: '2030-01-01T00:00:00.000Z' });
    return Response.json({ requestId: RELAY_REQUEST.requestId, bodyCid: RELAY_REQUEST.bodyCid, resultRef: 'ref'.repeat(10), expiresAt: '2030-01-01T00:00:00.000Z', relay: sealResult(inner), ...outer });
  },
}).poll({
  transport: {
    ...RELAY_REQUEST, record: { header: {}, signature: 'sig' }, request: { issuer: key.did, targetDid: key.did }, apiOrigin: 'https://openkey.example',
    relayPrivateKey: relay.getPrivateKey().toString('base64url'), ackId: 'ack',
  },
}, key);

test('a result sealed for this request with every field right is approved', async () => {
  const result = await resultPoll(goodInner());
  assert.equal(result.status, 'approved');
  assert.equal(result.payload.delegationCid, 'cid');
});

for (const [name, change] of [
  ['the wrong request digest', { requestDigest: 'bafy-another-request' }],
  ['the wrong request id', { requestId: 'z'.repeat(26) }],
  ['another requester', { requesterDid: 'did:key:z6MkOtherRequester' }],
  ['another target', { targetDid: 'did:key:z6MkOtherTarget' }],
  ['another result version', { resultVersion: 2 }],
  ['no delegation', { delegation: undefined }],
]) {
  test(`a result whose inner binding has ${name} is refused even though everything else about it is valid`, async () => {
    await assert.rejects(resultPoll({ ...goodInner(), ...change }), { code: 'bad-grant' });
  });
}

test('a result envelope sealed with another request id as its AAD cannot be opened', async () => {
  const wrong = openKeyInviteTransport({
    fetch: async (input) => String(input).endsWith('/result')
      ? Response.json({ resultRef: 'ref'.repeat(10), expiresAt: '2030-01-01T00:00:00.000Z' })
      : Response.json({ requestId: RELAY_REQUEST.requestId, bodyCid: RELAY_REQUEST.bodyCid, resultRef: 'ref'.repeat(10), expiresAt: '2030-01-01T00:00:00.000Z', relay: sealResult(goodInner(), 'z'.repeat(26)) }),
  });
  await assert.rejects(wrong.poll({ transport: { ...RELAY_REQUEST, record: { header: {}, signature: 'sig' }, request: { issuer: key.did, targetDid: key.did }, apiOrigin: 'https://openkey.example', relayPrivateKey: relay.getPrivateKey().toString('base64url'), ackId: 'ack' } }, key), { code: 'approval-unavailable' });
});

test('a fetch answer for another request id or digest is refused before decrypting', async () => {
  await assert.rejects(resultPoll(goodInner(), { requestId: 'q'.repeat(26) }), { code: 'approval-unavailable' });
  await assert.rejects(resultPoll(goodInner(), { bodyCid: 'bafy-elsewhere' }), { code: 'approval-unavailable' });
});
