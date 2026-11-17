// A renewal never outlives what the peer itself accepts: 7 days unless the peer's own signed delegation shows more.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateKey, sign } from 'node:crypto';
import { NodeWasmBindings, serializeDelegation } from '@tinycloud/node-sdk';
import { assertSuccessor, INTERIM_PERIOD_MS, maintainOutbound, peerLimitNote, peerRenewalLimitMs } from '../dist/interim-renewal.js';
import { peerReadPermissions } from '../dist/keys.js';
import { peerExpiryStatus } from '../dist/status.js';

const DAY = 86_400_000;
const SKEW = 5 * 60 * 1000;
const manager = new NodeWasmBindings().createSessionManager();
const keyId = manager.createSessionKey('test-issuer');
const signingJwk = JSON.parse(manager.jwk(keyId));
const signingKey = createPrivateKey({ key: signingJwk, format: 'jwk' });
const spaceId = 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents';
const courierDid = manager.getDID(keyId).split('#')[0];
const peerDid = 'did:key:bob';

function jwt(payload) {
  const header = { alg: 'EdDSA', typ: 'JWT', ucv: '0.10.0', jwk: { kty: 'OKP', crv: 'Ed25519', x: signingJwk.x } };
  const bytes = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${bytes}.${sign(null, Buffer.from(bytes), signingKey).toString('base64url')}`;
}

/** The delegation the peer gave us, with a signed lifetime of `lifetimeMs`; `signedNbf: false` matches Courier's real delegations, which carry no issued-at. */
function inboundOf(lifetimeMs, at = Math.floor(Date.now() / 1000) * 1000, signedNbf = true) {
  const authorization = jwt({ iss: peerDid, aud: courierDid, ...(signedNbf ? { nbf: Math.floor(at / 1000) } : {}), exp: Math.floor((at + lifetimeMs) / 1000), prf: ['x'], att: {} });
  const delegation = { cid: 'inbound', delegationHeader: { Authorization: authorization }, expiry: new Date(at + lifetimeMs) };
  return { delegation: serializeDelegation(delegation), cid: 'inbound', expiresAt: delegation.expiry.toISOString() };
}

test('peer limit comes from the signed lifetime of the inbound delegation', () => {
  assert.equal(peerRenewalLimitMs({ inbound: inboundOf(7 * DAY) }), 7 * DAY);
  assert.equal(peerRenewalLimitMs({ inbound: inboundOf(7 * DAY + SKEW) }), 7 * DAY, 'clock skew above 7 days is still a 7-day peer');
  assert.equal(peerRenewalLimitMs({ inbound: inboundOf(2 * DAY) }), 7 * DAY);
  assert.equal(peerRenewalLimitMs({ inbound: inboundOf(10 * DAY) }), 10 * DAY);
  assert.equal(peerRenewalLimitMs({ inbound: inboundOf(30 * DAY) }), 30 * DAY);
  assert.equal(peerRenewalLimitMs({ inbound: inboundOf(90 * DAY) }), INTERIM_PERIOD_MS, 'capped at the interim period');
});

test('without a signed issued-at, what remains of the signed expiry decides', () => {
  const limit = remaining => peerRenewalLimitMs({ inbound: inboundOf(remaining, Date.now(), false) });
  assert.equal(limit(30 * DAY), INTERIM_PERIOD_MS, 'more than 7 days left proves a long-lived peer');
  assert.equal(limit(7 * DAY), 7 * DAY);
  assert.equal(limit(2 * DAY), 7 * DAY);
  assert.equal(limit(7 * DAY + SKEW - 5_000), 7 * DAY, 'clock skew above 7 days is still a 7-day peer');
  assert.equal(limit(7 * DAY + 2 * SKEW), INTERIM_PERIOD_MS);
});

test('unknown or unparseable inbound gets 7 days', () => {
  assert.equal(peerRenewalLimitMs({}), 7 * DAY);
  for (const delegation of ['not json', '{}', JSON.stringify({ delegationHeader: { Authorization: 'a.b' } }),
    JSON.stringify({ delegationHeader: { Authorization: `a.${Buffer.from('{}').toString('base64url')}.c` }, expiry: new Date().toISOString() })]) {
    assert.equal(peerRenewalLimitMs({ inbound: { delegation, cid: 'c', expiresAt: new Date().toISOString() } }), 7 * DAY);
  }
  // Local expiry metadata alone never lengthens the limit.
  assert.equal(peerRenewalLimitMs({ inbound: { ...inboundOf(30 * DAY), delegation: '{}' } }), 7 * DAY);
});

test('limit note appears only when it shortens a renewal', () => {
  assert.equal(peerLimitNote({ inbound: inboundOf(7 * DAY) }), 'peer limit 7d');
  assert.equal(peerLimitNote({}), 'peer limit 7d');
  assert.equal(peerLimitNote({ inbound: inboundOf(7 * DAY, undefined, false) }), 'peer limit 7d');
  assert.equal(peerLimitNote({ inbound: inboundOf(30 * DAY, undefined, false) }), undefined);
  assert.equal(peerLimitNote({ inbound: inboundOf(30 * DAY) }), undefined);
  const peer = { handle: 'bob', status: 'paired', outbound: [], inbound: inboundOf(7 * DAY) };
  assert.equal(peerExpiryStatus(peer).peerLimit, '7d');
  assert.equal('peerLimit' in peerExpiryStatus({ ...peer, inbound: inboundOf(30 * DAY) }), false);
});

// Scheduling/publication mechanics are mocked; the signer clamps to the parent end like the node does unless `clamp` is false.
function fixture({ inboundLifetime, tipEndsAt = 3 * DAY, parentEndsAt = 40 * DAY, clamp = true }) {
  const at = Math.floor(Date.now() / 1000) * 1000;
  const peer = { handle: 'bob', courierDid: peerDid, sessionId: 'one-session', status: 'paired', inbound: inboundLifetime === undefined ? undefined : inboundOf(inboundLifetime, at),
    outbound: [{ cid: 'prior', issuedAt: new Date(at - 4 * DAY).toISOString(), expiresAt: new Date(at + tipEndsAt).toISOString() }] };
  const profile = { courierDid, spaceId, version: 3, peers: { bob: peer } };
  const parent = { cid: 'new-owner-grant', end: at + parentEndsAt };
  const resources = peerReadPermissions(peer.handle, spaceId, peer.sessionId).map(entry => ({
    resource: `${entry.space}/${entry.service.replace('tinycloud.', '')}/${entry.path}`, actions: entry.actions, caveats: [],
  }));
  let record = { cid: 'prior', direction: 'granted', delegatorDid: courierDid, delegateDid: peerDid, resources, parents: ['old-owner-grant'],
    issuedAt: new Date(at - 4 * DAY), notBefore: new Date(at - 4 * DAY), expiresAt: new Date(at + tipEndsAt), status: 'active' };
  const records = [record];
  const counts = { sign: 0, revoke: [], expiries: [], published: [] };
  const portable = (item, proof) => {
    const att = {};
    for (const entry of item.resources) for (const action of entry.actions) (att[entry.resource] ??= {})[action] = [{}];
    const authorization = jwt({ iss: item.delegatorDid, aud: item.delegateDid, nbf: Math.floor(at / 1000), exp: Math.floor(item.expiresAt.getTime() / 1000), prf: [proof], att });
    return { cid: item.cid, delegationHeader: { Authorization: authorization }, ownerAddress: '0x1111111111111111111111111111111111111111', chainId: 1, spaceId,
      path: `xyz.tinycloud.courier/to/bob/threads/${peer.sessionId}/`, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'],
      resources: item.resources.map(entry => { const uri = entry.resource.slice(spaceId.length + 1); const slash = uri.indexOf('/'); return { space: spaceId, service: uri.slice(0, slash), path: uri.slice(slash + 1), actions: entry.actions, caveats: entry.caveats }; }),
      expiry: item.expiresAt, delegateDID: peerDid, delegatorDID: courierDid };
  };
  const original = portable(record, 'old-owner-grant');
  const node = {
    credentialHolderDid: courierDid,
    restorableSession: { delegationCid: parent.cid, siwe: `courier.test wants you to sign in with your Ethereum account:\n0x1111111111111111111111111111111111111111\n\nCourier renewal test.\n\nURI: did:key:issuer\nVersion: 1\nChain ID: 1\nNonce: abcdefgh\nIssued At: ${new Date(at - DAY).toISOString()}\nExpiration Time: ${new Date(parent.end).toISOString()}` },
    computeDelegationCid: authorization => records.find(item => portable(item, item.cid === 'prior' ? 'old-owner-grant' : parent.cid).delegationHeader.Authorization === authorization)?.cid,
    delegationManager: {
      queryAllIssued: async () => ({ ok: true, data: structuredClone(records) }),
      revokeIssued: async cid => { counts.revoke.push(cid); const found = records.find(item => item.cid === cid); if (found) found.status = 'revoked'; return { ok: true, data: { revoked: true, cid } }; },
    },
    kv: {
      get: async () => ({ ok: true, data: { data: { delegation: serializeDelegation(original) }, headers: { etag: '"prior"' } } }),
      put: async (key, value) => { counts.published.push({ key, value }); return { ok: true, data: {} }; },
    },
    delegateTo: async (audience, entries, options) => {
      counts.sign++;
      counts.expiries.push(options.expiry);
      const end = Math.floor((clamp ? Math.min(Date.now() + options.expiry, parent.end) : Date.now() + options.expiry) / 1000) * 1000;
      record = { ...structuredClone(record), cid: 'new', parents: [parent.cid], notBefore: new Date(at), expiresAt: new Date(end) };
      records.push(record);
      return { delegation: portable(record, parent.cid) };
    },
  };
  return { node, profile, peer, parent, counts, at, save: () => {} };
}

test('a 7-day peer gets at most a 7-day renewal', async () => {
  const f = fixture({ inboundLifetime: 7 * DAY });
  const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save);
  assert.equal(outcome.state, 'renewed');
  assert.deepEqual(f.counts.expiries, [7 * DAY]);
  assert.ok(outcome.delegation.expiry.getTime() <= Date.now() + 7 * DAY);
});

test('a 30-day peer gets 30 days', async () => {
  const f = fixture({ inboundLifetime: 30 * DAY });
  const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save);
  assert.equal(outcome.state, 'renewed');
  assert.deepEqual(f.counts.expiries, [30 * DAY]);
  assert.ok(outcome.delegation.expiry.getTime() > Date.now() + 29 * DAY);
});

test('an unknown inbound gets 7 days', async () => {
  const f = fixture({ inboundLifetime: undefined });
  const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save);
  assert.equal(outcome.state, 'renewed');
  assert.deepEqual(f.counts.expiries, [7 * DAY]);
});

test('a renewal never exceeds the parent end, for a 30-day peer', async () => {
  const f = fixture({ inboundLifetime: 30 * DAY, parentEndsAt: 10 * DAY });
  const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save);
  assert.equal(outcome.state, 'renewed');
  assert.equal(outcome.delegation.expiry.getTime(), f.parent.end);
});

test('a renewal that would outlive the parent end is refused and revoked', async () => {
  const f = fixture({ inboundLifetime: 30 * DAY, parentEndsAt: 10 * DAY, clamp: false });
  await assert.rejects(maintainOutbound(f.node, f.profile, f.peer, f.save), /safely renew/);
  assert.deepEqual(f.counts.revoke, ['new']);
});

test('a renewal beyond the peer limit is refused and revoked', async () => {
  const f = fixture({ inboundLifetime: 7 * DAY, clamp: false });
  const original = f.node.delegateTo;
  f.node.delegateTo = (audience, entries, options) => original(audience, entries, { ...options, expiry: 8 * DAY });
  await assert.rejects(maintainOutbound(f.node, f.profile, f.peer, f.save), /safely renew/);
  assert.deepEqual(f.counts.revoke, ['new']);
});

test('assertSuccessor accepts the bounded renewal and refuses one past the peer limit', () => {
  const now = Date.now();
  const resources = peerReadPermissions('bob', spaceId, 'one-session').map(entry => ({
    resource: `${entry.space}/${entry.service.replace('tinycloud.', '')}/${entry.path}`, actions: entry.actions, caveats: [],
  }));
  const parent = { cid: 'new-owner-grant', end: now + 60 * DAY };
  const prior = { cid: 'prior', direction: 'granted', delegatorDid: courierDid, delegateDid: peerDid, resources, parents: ['old-owner-grant'],
    issuedAt: new Date(now - DAY), notBefore: null, expiresAt: new Date(now + DAY), status: 'active' };
  const next = days => ({ ...structuredClone(prior), cid: 'new', parents: [parent.cid], expiresAt: new Date(now + days * DAY) });
  const profile = { courierDid, spaceId };
  const sevenDay = { handle: 'bob', courierDid: peerDid, sessionId: 'one-session', status: 'paired', outbound: [], inbound: inboundOf(7 * DAY) };
  const thirtyDay = { ...sevenDay, inbound: inboundOf(30 * DAY) };
  assert.doesNotThrow(() => assertSuccessor(profile, sevenDay, prior, next(7), parent, now));
  assert.throws(() => assertSuccessor(profile, sevenDay, prior, next(8), parent, now), /safely renew/);
  assert.doesNotThrow(() => assertSuccessor(profile, thirtyDay, prior, next(30), parent, now));
  assert.throws(() => assertSuccessor(profile, thirtyDay, prior, next(31), parent, now), /safely renew/);
});

test('no extension when a 7-day peer already holds access up to the bound', async () => {
  const f = fixture({ inboundLifetime: 7 * DAY, tipEndsAt: 7 * DAY + 60_000 });
  const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save, { force: true, manual: true });
  assert.deepEqual(outcome, { state: 'live', reason: 'no-extension' });
  assert.equal(f.counts.sign, 0);
  assert.deepEqual(f.counts.revoke, []);
});

for (const options of [{ force: true, manual: true }, { manual: true }, {}]) {
  test(`a current delegation longer than the peer accepts is replaced by a bounded one and published (${JSON.stringify(options)})`, async () => {
    const f = fixture({ inboundLifetime: 7 * DAY, tipEndsAt: 30 * DAY });
    const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save, options);
    assert.equal(outcome.state, 'renewed');
    assert.deepEqual(f.counts.expiries, [7 * DAY]);
    const expiry = outcome.delegation.expiry.getTime();
    assert.ok(expiry <= Date.now() + 7 * DAY && expiry > Date.now() + 6 * DAY, 'shorter than the 30-day delegation it replaces');
    assert.equal(f.counts.published.length, 1);
    assert.equal(JSON.parse(f.counts.published[0].value.delegation).cid, 'new');
    assert.equal(f.peer.outbound.at(-1).cid, 'new');
    assert.deepEqual(f.counts.revoke, []);
  });
}

test('replacing an over-long delegation is still capped by the parent end', async () => {
  const f = fixture({ inboundLifetime: 7 * DAY, tipEndsAt: 30 * DAY, parentEndsAt: 31 * DAY });
  const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save, { force: true, manual: true });
  assert.equal(outcome.state, 'renewed');
  assert.ok(outcome.delegation.expiry.getTime() <= f.parent.end);
});

test('assertSuccessor accepts a shorter successor only when the prior outlives the peer limit', () => {
  const now = Date.now();
  const resources = peerReadPermissions('bob', spaceId, 'one-session').map(entry => ({
    resource: `${entry.space}/${entry.service.replace('tinycloud.', '')}/${entry.path}`, actions: entry.actions, caveats: [],
  }));
  const parent = { cid: 'new-owner-grant', end: now + 60 * DAY };
  const record = (cid, days, parents) => ({ cid, direction: 'granted', delegatorDid: courierDid, delegateDid: peerDid, resources, parents,
    issuedAt: new Date(now - DAY), notBefore: null, expiresAt: new Date(now + days * DAY), status: 'active' });
  const profile = { courierDid, spaceId };
  const peer = { handle: 'bob', courierDid: peerDid, sessionId: 'one-session', status: 'paired', outbound: [], inbound: inboundOf(7 * DAY) };
  assert.doesNotThrow(() => assertSuccessor(profile, peer, record('prior', 30, ['old']), record('new', 7, [parent.cid]), parent, now));
  assert.throws(() => assertSuccessor(profile, peer, record('prior', 30, ['old']), record('new', 8, [parent.cid]), parent, now), /safely renew/);
  assert.throws(() => assertSuccessor(profile, peer, record('prior', 6, ['old']), record('new', 5, [parent.cid]), parent, now), /safely renew/, 'within the limit, a shorter successor is no renewal');
});

test('the shorter grant is published once; later ticks only extend', async () => {
  const first = fixture({ inboundLifetime: 7 * DAY, tipEndsAt: 30 * DAY });
  assert.equal((await maintainOutbound(first.node, first.profile, first.peer, first.save, { force: true, manual: true })).state, 'renewed');
  assert.equal(first.counts.published.length, 1);
  assert.ok(first.peer.interim.shortenedAt);
  // The new tip ends within the peer limit: the next tick extends nothing and signs nothing.
  assert.deepEqual(await maintainOutbound(first.node, first.profile, first.peer, first.save, { force: true, manual: true }), { state: 'live', reason: 'no-extension' });
  assert.equal(first.counts.sign, 1);
  assert.equal(first.counts.published.length, 1);

  // A fresh process: the marker survives a profile reload, and an over-long tip is no longer replaced by a shorter one.
  const reloaded = fixture({ inboundLifetime: 7 * DAY, tipEndsAt: 30 * DAY });
  reloaded.peer.interim = JSON.parse(JSON.stringify(first.peer.interim));
  assert.deepEqual(await maintainOutbound(reloaded.node, reloaded.profile, reloaded.peer, reloaded.save, { force: true, manual: true }), { state: 'live', reason: 'no-extension' });
  assert.equal(reloaded.counts.sign, 0);
  assert.equal(reloaded.counts.published.length, 0);
});

test('a renewal that does not extend is skipped now and issued, extending, on a later tick', async () => {
  const f = fixture({ inboundLifetime: 7 * DAY, tipEndsAt: 7 * DAY + 60_000 });
  const options = { force: true, manual: true };
  assert.deepEqual(await maintainOutbound(f.node, f.profile, f.peer, f.save, options), { state: 'live', reason: 'no-extension' });
  assert.equal(f.counts.sign, 0);
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60_000;
  try {
    const outcome = await maintainOutbound(f.node, f.profile, f.peer, f.save, options);
    assert.equal(outcome.state, 'renewed');
    assert.ok(outcome.delegation.expiry.getTime() > f.at + 7 * DAY + 60_000, 'extends the current delegation');
    assert.ok(outcome.delegation.expiry.getTime() <= Date.now() + 7 * DAY);
    assert.equal(f.peer.interim?.shortenedAt, undefined, 'the shorter-grant exception was not used');
  } finally { Date.now = realNow; }
});
