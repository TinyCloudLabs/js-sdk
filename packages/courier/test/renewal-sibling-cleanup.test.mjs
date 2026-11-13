// TC-2917 ruling (3): sibling cleanup runs immediately after a renewal creates a new grant, in the same call, not on
// the 300 s housekeeping schedule. Only scheduling mechanics are mocked (as in interim-renewal.test.mjs's fixture).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateKey, sign } from 'node:crypto';
import { NodeWasmBindings, serializeDelegation } from '@tinycloud/node-sdk';
import { maintainOutbound } from '../dist/interim-renewal.js';
import { peerReadPermissions } from '../dist/keys.js';

const DAY = 86_400_000;
const manager = new NodeWasmBindings().createSessionManager();
const keyId = manager.createSessionKey('test-issuer');
const signingJwk = JSON.parse(manager.jwk(keyId));
const signingKey = createPrivateKey({ key: signingJwk, format: 'jwk' });
const profile = { courierDid: manager.getDID(keyId).split('#')[0], spaceId: 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents' };
const peerBase = { handle: 'bob', courierDid: 'did:key:bob', sessionId: 'one-session', status: 'paired' };
const resources = peerReadPermissions(peerBase.handle, profile.spaceId, peerBase.sessionId).map(entry => ({
  resource: `${entry.space}/${entry.service.replace('tinycloud.', '')}/${entry.path}`, actions: entry.actions, caveats: [],
}));
const parent = { cid: 'new-owner-grant' };

function fixture({ siblingAfterSign = false } = {}) {
  const at = Math.floor(Date.now() / 1000) * 1000;
  const peer = { ...structuredClone(peerBase), outbound: [{ cid: 'prior', issuedAt: new Date(at - 4 * DAY).toISOString(), expiresAt: new Date(at + 3 * DAY).toISOString() }] };
  const fixtureProfile = { ...profile, version: 3, peers: { bob: peer } };
  const prior = { cid: 'prior', direction: 'granted', delegatorDid: profile.courierDid, delegateDid: peer.courierDid, resources,
    parents: ['old-owner-grant'], issuedAt: new Date(at - 4 * DAY), notBefore: new Date(at - 4 * DAY), expiresAt: new Date(at + 3 * DAY), status: 'active' };
  const records = [prior];
  const counts = { list: 0, sign: 0, publish: 0, revoke: [] };
  const portable = (record, proof) => {
    const att = {};
    for (const entry of record.resources) for (const action of entry.actions) (att[entry.resource] ??= {})[action] = entry.caveats.length ? entry.caveats : [{}];
    const payload = { iss: record.delegatorDid, aud: record.delegateDid, nbf: Math.floor(at / 1000), exp: Math.floor(record.expiresAt.getTime() / 1000), prf: [proof], att };
    const header = { alg: 'EdDSA', typ: 'JWT', ucv: '0.10.0', jwk: { kty: 'OKP', crv: 'Ed25519', x: signingJwk.x } };
    const bytes = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return { cid: record.cid, delegationHeader: { Authorization: `${bytes}.${sign(null, Buffer.from(bytes), signingKey).toString('base64url')}` },
      ownerAddress: '0x1111111111111111111111111111111111111111', chainId: 1, spaceId: profile.spaceId,
      path: `xyz.tinycloud.courier/to/bob/threads/${peer.sessionId}/`, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'],
      resources: record.resources.map(entry => { const uri = entry.resource.slice(profile.spaceId.length + 1); const slash = uri.indexOf('/'); return { space: profile.spaceId, service: uri.slice(0, slash), path: uri.slice(slash + 1), actions: entry.actions, caveats: entry.caveats }; }),
      expiry: record.expiresAt, delegateDID: peer.courierDid, delegatorDID: profile.courierDid };
  };
  const original = portable(prior, 'old-owner-grant');
  const node = {
    credentialHolderDid: profile.courierDid,
    restorableSession: { delegationCid: parent.cid, siwe: `courier.test wants you to sign in with your Ethereum account:\n0x1111111111111111111111111111111111111111\n\nCourier renewal test.\n\nURI: did:key:issuer\nVersion: 1\nChain ID: 1\nNonce: abcdefgh\nIssued At: ${new Date(at - DAY).toISOString()}\nExpiration Time: ${new Date(at + 20 * DAY).toISOString()}` },
    computeDelegationCid: authorization => records.find(record => portable(record, record.cid === 'prior' ? 'old-owner-grant' : parent.cid).delegationHeader.Authorization === authorization)?.cid,
    delegationManager: {
      queryAllIssued: async () => {
        counts.list++;
        // Another HOME of this key signs a sibling child while our renewal is in flight.
        if (siblingAfterSign && counts.sign && !records.some(record => record.cid === 'sibling')) records.push({ ...structuredClone(records.at(-1)), cid: 'sibling' });
        return { ok: true, data: structuredClone(records) };
      },
      revokeIssued: async cid => { counts.revoke.push(cid); const record = records.find(item => item.cid === cid); if (record) record.status = 'revoked'; return { ok: true, data: { revoked: true, cid } }; },
    },
    kv: {
      get: async () => ({ ok: true, data: { data: { delegation: serializeDelegation(original) }, headers: { etag: '"prior"' } } }),
      put: async () => { counts.publish++; return { ok: true, data: {} }; },
    },
    delegateTo: async () => {
      counts.sign++;
      const next = { ...structuredClone(prior), cid: 'new', parents: [parent.cid], notBefore: new Date(at), expiresAt: new Date(at + 20 * DAY) };
      records.push(next);
      return { delegation: portable(next, parent.cid) };
    },
  };
  return { node, profile: fixtureProfile, peer, counts, save: () => {} };
}

test('a renewal re-checks the issued siblings in the same call, right after signing', async () => {
  const f = fixture();
  assert.equal((await maintainOutbound(f.node, f.profile, f.peer, f.save)).state, 'renewed');
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.list, 2, 'one check before signing and one right after it, not 300 s later');
});

test('a sibling grant found right after a renewal is revoked in that same call, before anything is published', async () => {
  const f = fixture({ siblingAfterSign: true });
  await assert.rejects(maintainOutbound(f.node, f.profile, f.peer, f.save));
  assert.ok(f.counts.revoke.includes('sibling'), `revoked at once: ${JSON.stringify(f.counts.revoke)}`);
  assert.ok(f.counts.revoke.includes('new'), 'and the just-signed successor is cleaned up too');
  assert.equal(f.counts.publish, 0, 'nothing published');
});
