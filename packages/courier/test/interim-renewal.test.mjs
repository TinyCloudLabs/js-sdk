// Independent policy regressions. Real node authority evidence is a separate local-only matrix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateKey, sign } from 'node:crypto';
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { assertSuccessor, interimLocalState, issuedAuthority } from '../dist/interim-renewal.js';
import { peerReadPermissions } from '../dist/keys.js';

const DAY = 86_400_000;
const now = Date.now();
const manager = new NodeWasmBindings().createSessionManager();
const keyId = manager.createSessionKey('test-issuer');
const signingJwk = JSON.parse(manager.jwk(keyId));
const signingKey = createPrivateKey({ key: signingJwk, format: 'jwk' });
const profile = { courierDid: manager.getDID(keyId).split('#')[0], spaceId: 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents' };
const peer = { handle: 'bob', courierDid: 'did:key:bob', sessionId: 'one-session', status: 'paired', outbound: [{ cid: 'prior', expiresAt: new Date(now + DAY).toISOString() }] };
const resources = peerReadPermissions(peer.handle, profile.spaceId, peer.sessionId).map(entry => ({
  resource: `${entry.space}/${entry.service.replace('tinycloud.', '')}/${entry.path}`, actions: entry.actions, caveats: [],
}));
const prior = { cid: 'prior', direction: 'granted', delegatorDid: profile.courierDid, delegateDid: peer.courierDid,
  resources, parents: ['old-owner-grant'], issuedAt: new Date(now - DAY), notBefore: null, expiresAt: new Date(now + DAY), status: 'active' };
const parent = { cid: 'new-owner-grant', end: now + 20 * DAY };
const successor = () => ({ ...structuredClone(prior), cid: 'new', parents: [parent.cid], expiresAt: new Date(now + 10 * DAY) });

test('same exact signed scope extends time within the actual current parent', () => {
  assert.doesNotThrow(() => assertSuccessor(profile, peer, prior, successor(), parent, now));
});

for (const [name, change] of [
  ['extra action', item => item.resources[0].actions.push('tinycloud.kv/put')],
  ['changed caveat', item => item.resources[0].caveats.push({ limit: 1 })],
  ['another audience', item => { item.delegateDid = 'did:key:stranger'; }],
  ['another issuer', item => { item.delegatorDid = 'did:key:stranger'; }],
  ['changed session', item => { item.resources[0].resource = item.resources[0].resource.replace('one-session', 'another-session'); }],
  ['changed mailbox', item => { item.resources[0].resource = item.resources[0].resource.replace('/to/bob/', '/to/other/'); }],
  ['another parent', item => { item.parents = ['foreign-parent']; }],
  ['an extra parent', item => { item.parents.push('foreign-parent'); }],
  ['parent overrun', item => { item.expiresAt = new Date(parent.end + 1); }],
  ['Month overrun', item => { item.expiresAt = new Date(now + 31 * DAY); }],
  ['same expiry', item => { item.expiresAt = prior.expiresAt; }],
  ['expired result', item => { item.expiresAt = new Date(now); }],
]) test(`refuses ${name}`, () => {
  const next = successor(); change(next);
  assert.throws(() => assertSuccessor(profile, peer, prior, next, parent, now));
});

test('prior material must be issued by this Courier key, never an inbound or another issuer CID', () => {
  for (const altered of [{ ...prior, delegatorDid: peer.courierDid, delegateDid: profile.courierDid }, { ...prior, delegatorDid: 'did:key:other' }]) {
    assert.throws(() => assertSuccessor(profile, peer, altered, successor(), parent, now));
  }
});

test('signed prior caveats are preserved exactly, including refusal to remove them', () => {
  const constrained = structuredClone(prior);
  constrained.resources[0].caveats = [{ limit: 1 }];
  assert.throws(() => assertSuccessor(profile, peer, constrained, successor(), parent, now));
  const same = successor(); same.resources[0].caveats = [{ limit: 1 }];
  assert.doesNotThrow(() => assertSuccessor(profile, peer, constrained, same, parent, now));
});

test('canonical resources compare action sets but retain all conditions', () => {
  assert.equal(issuedAuthority(resources), issuedAuthority([...resources].reverse()));
  assert.notEqual(issuedAuthority(resources), issuedAuthority(resources.map(item => ({ ...item, caveats: [{ limit: 1 }] }))));
});

test('lapsed and latched preflight is a local-only classification', () => {
  assert.equal(interimLocalState(peer, now), 'live');
  assert.equal(interimLocalState(peer, now + DAY), 'lapsed');
  assert.equal(interimLocalState({ ...peer, interim: { latchedAt: new Date(now).toISOString(), cleanup: {} } }, now), 'revoked');
  assert.equal(interimLocalState({ ...peer, interim: { ownerRevoked: true, cleanup: {} } }, now), 'owner-revoked');
});

const { maintainOutbound, successorRecord } = await import('../dist/interim-renewal.js');
const { serializeDelegation } = await import('@tinycloud/node-sdk');

// Only scheduling/publication mechanics are mocked here; no server-authority claim is based on these cases.
function lifecycleFixture() {
  const at = Math.floor(Date.now() / 1000) * 1000;
  const fixtureProfile = { ...profile, version: 3, peers: {} };
  const fixturePeer = { ...structuredClone(peer), interim: undefined, outbound: [{ cid: 'prior', issuedAt: new Date(at - 4 * DAY).toISOString(), expiresAt: new Date(at + 3 * DAY).toISOString() }] };
  fixtureProfile.peers[peer.handle] = fixturePeer;
  let nodeRecord = { ...structuredClone(prior), issuedAt: new Date(at - 4 * DAY), notBefore: new Date(at - 4 * DAY), expiresAt: new Date(at + 3 * DAY) };
  const records = [nodeRecord];
  const counts = { list: 0, sign: 0, publish: 0, revoke: [], saves: [] };
  const portable = (record, proof) => {
    const att = {};
    for (const entry of record.resources) for (const action of entry.actions) (att[entry.resource] ??= {})[action] = entry.caveats.length ? entry.caveats : [{}];
    const payload = { iss: record.delegatorDid, aud: record.delegateDid, nbf: Math.floor(at / 1000), exp: Math.floor(record.expiresAt.getTime() / 1000), prf: [proof], att };
    const header = { alg: 'EdDSA', typ: 'JWT', ucv: '0.10.0', jwk: { kty: 'OKP', crv: 'Ed25519', x: signingJwk.x } };
    const bytes = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const authorization = `${bytes}.${sign(null, Buffer.from(bytes), signingKey).toString('base64url')}`;
    return { cid: record.cid, delegationHeader: { Authorization: authorization },
      ownerAddress: '0x1111111111111111111111111111111111111111', chainId: 1, spaceId: profile.spaceId,
      path: `xyz.tinycloud.courier/to/bob/threads/${peer.sessionId}/`, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'],
      resources: record.resources.map(entry => { const uri = entry.resource.slice(profile.spaceId.length + 1); const slash = uri.indexOf('/'); return { space: profile.spaceId, service: uri.slice(0, slash), path: uri.slice(slash + 1), actions: entry.actions, caveats: entry.caveats }; }),
      expiry: record.expiresAt, delegateDID: peer.courierDid, delegatorDID: profile.courierDid };
  };
  const original = portable(nodeRecord, 'old-owner-grant');
  let failCas = false;
  let externalRevoke = false;
  const node = {
    credentialHolderDid: profile.courierDid,
    restorableSession: { delegationCid: parent.cid, siwe: `courier.test wants you to sign in with your Ethereum account:\n0x1111111111111111111111111111111111111111\n\nCourier renewal test.\n\nURI: did:key:issuer\nVersion: 1\nChain ID: 1\nNonce: abcdefgh\nIssued At: ${new Date(at - DAY).toISOString()}\nExpiration Time: ${new Date(at + 20 * DAY).toISOString()}` },
    computeDelegationCid: authorization => records.find(record => portable(record, record.cid === 'prior' ? 'old-owner-grant' : parent.cid).delegationHeader.Authorization === authorization)?.cid,
    delegationManager: {
      queryAllIssued: async () => { counts.list++; if (externalRevoke && counts.sign) records[0].status = 'revoked'; return { ok: true, data: structuredClone(records) }; },
      revokeIssued: async cid => { counts.revoke.push(cid); const record = records.find(record => record.cid === cid); if (record) record.status = 'revoked'; return { ok: true, data: { revoked: true, cid } }; },
    },
    kv: {
      get: async () => ({ ok: true, data: { data: { delegation: serializeDelegation(original) }, headers: { etag: '"prior"' } } }),
      put: async () => { counts.publish++; return failCas ? { ok: false, error: { code: 'KV_PRECONDITION_FAILED' } } : { ok: true, data: {} }; },
    },
    delegateTo: async (audience, entries, options) => {
      counts.sign++;
      assert.equal(audience, peer.courierDid);
      assert.equal(options.requireActivation, true);
      assert.equal(options.expiry, 30 * DAY);
      nodeRecord = { ...structuredClone(nodeRecord), cid: 'new', parents: [parent.cid], notBefore: new Date(at), expiresAt: new Date(at + 20 * DAY) };
      records.push(nodeRecord);
      return { delegation: portable(nodeRecord, parent.cid) };
    },
  };
  return { node, profile: fixtureProfile, peer: fixturePeer, counts, records,
    save: () => counts.saves.push(structuredClone(fixturePeer)), failCas: () => { failCas = true; }, externalRevoke: () => { externalRevoke = true; } };
}

test('half-life issuance records its successor before conditional publication and honors parent clamp', async () => {
  const f = lifecycleFixture();
  const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save);
  assert.equal(outcome.state, 'renewed');
  assert.equal(f.profile.version, 4, 'older writers are fenced before renewal state is saved');
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.publish, 1);
  assert.equal(f.peer.outbound.at(-1).priorCid, 'prior');
  assert.ok(f.counts.saves.some(peer => peer.outbound.some(entry => entry.cid === 'new')));
});

test('publication CAS loss records cleanup before revoking the signed successor', async () => {
  const f = lifecycleFixture(); f.failCas();
  await assert.rejects(maintainOutbound(f.node, f.profile, f.peer, f.save), /changed|conflict/);
  assert.deepEqual(f.counts.revoke, ['new']);
  assert.ok(f.counts.saves.some(peer => peer.interim?.cleanup.new?.intentAt && !peer.interim.cleanup.new.revokedAt));
  assert.ok(f.peer.interim.cleanup.new.revokedAt);
  assert.equal(f.peer.outbound.at(-1).revokedAt, f.peer.interim.cleanup.new.revokedAt);
});

test('single-sibling external revoke between signing and publication latches and cleans every live successor', async () => {
  const f = lifecycleFixture(); f.externalRevoke();
  await assert.rejects(maintainOutbound(f.node, f.profile, f.peer, f.save));
  assert.ok(f.peer.interim.latchedAt);
  assert.equal(f.counts.publish, 0);
  assert.deepEqual(f.counts.revoke, ['new']);
  const before = structuredClone(f.counts);
  assert.equal((await maintainOutbound(f.node, f.profile, f.peer, f.save)).state, 'revoked');
  assert.deepEqual(f.counts, before, 'restart of latched peer is local only');
});

test('unledgered child from another HOME is revoked, never adopted', async () => {
  const f = lifecycleFixture();
  f.records.push({ ...structuredClone(f.records[0]), cid: 'other-home' });
  assert.equal((await maintainOutbound(f.node, f.profile, f.peer, f.save)).state, 'unavailable');
  assert.deepEqual(f.counts.revoke, ['other-home']);
  assert.equal(f.counts.sign, 0);
  assert.deepEqual(f.peer.outbound.map(item => item.cid), ['prior']);
});

test('revoked ancestor is terminal and does not make a replacement request or sign', async () => {
  const f = lifecycleFixture(); f.records[0].status = 'ancestor_revoked'; f.records[0].revokedAncestorCid = parent.cid;
  assert.equal((await maintainOutbound(f.node, f.profile, f.peer, f.save)).state, 'owner-revoked');
  assert.equal(f.peer.interim.ownerRevokedCid, parent.cid);
  assert.equal(f.counts.sign, 0);
  const before = structuredClone(f.counts);
  assert.equal((await maintainOutbound(f.node, f.profile, f.peer, f.save)).state, 'owner-revoked');
  assert.deepEqual(f.counts, before);
});

test('a parent end within the same signed second causes no sign, publication or cleanup', async () => {
  const f = lifecycleFixture();
  const end = f.records[0].expiresAt.getTime();
  f.node.restorableSession.siwe = f.node.restorableSession.siwe.replace(/Expiration Time: .*/, `Expiration Time: ${new Date(end + 500).toISOString()}`);
  assert.equal((await maintainOutbound(f.node, f.profile, f.peer, f.save, { force: true })).state, 'live');
  assert.equal(f.counts.sign, 0);
  assert.equal(f.counts.publish, 0);
  assert.deepEqual(f.counts.revoke, []);
});
