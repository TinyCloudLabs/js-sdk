import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maintainOutbound } from '../dist/interim-renewal.js';
import { peerReadPermissions } from '../dist/keys.js';

const now = Date.parse('2026-11-23T15:30:07Z');
const end = now + 15 * 60_000;
const ownerCid = 'renewed-owner';
const priorCid = 'original-child';
const nextCid = 'live-successor';
const iso = ms => new Date(ms).toISOString();

function fixture({ priorStatus = 'expired', status = 'active', effectiveEnd = end } = {}) {
  const profile = { courierDid: 'did:key:alice', spaceId: 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents' };
  const peer = { handle: 'bob', courierDid: 'did:key:bob', status: 'paired',
    outbound: [
      { cid: priorCid, issuedAt: iso(now - 1_800_000), expiresAt: iso(now - 7_000) },
      { cid: nextCid, priorCid, issuedAt: iso(now - 600_000), expiresAt: iso(end) },
    ] };
  const resources = peerReadPermissions(peer.handle, profile.spaceId).map(entry => ({
    resource: `${entry.space}/${entry.service.replace('tinycloud.', '')}/${entry.path}`, actions: entry.actions, caveats: [],
  }));
  const events = [];
  const node = {
    credentialHolderDid: profile.courierDid,
    restorableSession: { delegationCid: ownerCid }, sessionEnd: new Date(end),
    delegationManager: {
      async queryAllIssued() {
        return { ok: true, data: peer.outbound.map(entry => ({
          cid: entry.cid, delegatorDid: profile.courierDid, delegateDid: peer.courierDid,
          resources, parents: [ownerCid], status: entry.cid === priorCid ? priorStatus : 'expired',
          issuedAt: new Date(entry.issuedAt), notBefore: null, expiresAt: new Date(entry.expiresAt),
        })) };
      },
      async revokeIssued(cid) {
        events.push(['revoke', cid]);
        return { ok: true, data: { cid, revoked: true } };
      },
    },
    async getDelegationStatus(cid) {
      events.push(['status', cid]);
      return { ok: true, data: { cid, status, exists: status !== 'not_found', active: status === 'active',
        revoked: status === 'revoked', expired: status === 'expired', effective_expiry: effectiveEnd === null ? null : effectiveEnd / 1000 } };
    },
  };
  const check = () => maintainOutbound(node, profile, peer, () => events.push(['save', structuredClone(peer.interim)]));
  return { check, peer, events };
}

test('an explicit sibling revocation latches and revokes the renewed successor despite its raw expired listing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture({ priorStatus: 'revoked' });
  assert.equal((await f.check()).state, 'revoked');
  assert.deepEqual(f.events.filter(([event]) => event !== 'save'), [['status', nextCid], ['revoke', nextCid]]);
  const revokeIndex = f.events.findIndex(([event]) => event === 'revoke');
  assert.ok(f.events.slice(0, revokeIndex).some(([event, state]) =>
    event === 'save' && state.latchedAt === iso(now) && state.cleanup[nextCid]?.intentAt === iso(now)));
  assert.equal(f.peer.outbound[1].revokedAt, iso(now));
});

for (const [name, options] of [
  ['revoked', { status: 'revoked', effectiveEnd: null }],
  ['missing', { status: 'not_found', effectiveEnd: null }],
  ['non-active', { status: 'unavailable', effectiveEnd: null }],
  ['mismatched expiry', { effectiveEnd: end - 1_000 }],
]) {
  test(`exact status ${name} neither reopens authority nor authorizes cleanup`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const ordinary = fixture(options);
    assert.equal((await ordinary.check()).state, 'unavailable');
    assert.deepEqual(ordinary.events, [['status', nextCid]]);

    const latched = fixture({ ...options, priorStatus: 'revoked' });
    assert.equal((await latched.check()).state, 'revoked', 'the explicit sibling revocation stays terminal');
    assert.equal(latched.peer.interim.latchedAt, iso(now));
    assert.deepEqual(latched.events.filter(([event]) => event !== 'save'), [['status', nextCid]]);
    assert.deepEqual(latched.peer.interim.cleanup, {});
  });
}
