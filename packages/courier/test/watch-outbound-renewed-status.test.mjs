import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maintainOutbound } from '../dist/interim-renewal.js';
import { peerReadPermissions } from '../dist/keys.js';

const hour = 3_600_000;
const edge = Date.parse('2026-11-23T12:00:00Z');
const ownerCid = 'renewed-owner';
const priorCid = 'expired-original-child';
const nextCid = 'installed-successor';
const childEnd = edge + 3 * hour;
const iso = time => new Date(time).toISOString();

function fixture() {
  const profile = { courierDid: 'did:key:alice', spaceId: 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents' };
  const peer = { handle: 'bob', courierDid: 'did:key:bob', sessionId: 'session-id', status: 'paired',
    outbound: [
      { cid: priorCid, issuedAt: iso(edge - hour), expiresAt: iso(edge) },
      { cid: nextCid, priorCid, issuedAt: iso(edge - hour / 2), expiresAt: iso(childEnd) },
    ] };
  const resources = peerReadPermissions(peer.handle, profile.spaceId, peer.sessionId).map(entry => ({
    resource: `${entry.space}/${entry.service.replace('tinycloud.', '')}/${entry.path}`, actions: entry.actions, caveats: [],
  }));
  const requests = [];
  let reportedParent = ownerCid;
  let directVerdict = 'active';
  const node = {
    credentialHolderDid: profile.courierDid,
    restorableSession: { delegationCid: ownerCid },
    sessionEnd: new Date(childEnd), // the already verified effective owner end, not its original signed end
    delegationManager: {
      async queryAllIssued() {
        requests.push('query');
        // v1.26.22 account listing checks ancestor *signed* ends even after owner renewal.
        return { ok: true, data: peer.outbound.map(entry => ({
          cid: entry.cid, delegatorDid: profile.courierDid, delegateDid: peer.courierDid,
          resources, parents: [reportedParent], status: Date.now() < edge ? 'active' : 'expired',
          issuedAt: new Date(entry.issuedAt), notBefore: null, expiresAt: new Date(entry.expiresAt),
        })) };
      },
    },
    async getDelegationStatus(cid) {
      requests.push(cid);
      return { ok: true, data: { cid, status: directVerdict, exists: true, active: directVerdict === 'active',
        revoked: directVerdict === 'revoked', expired: directVerdict === 'expired', effective_expiry: childEnd / 1000 } };
    },
  };
  const check = () => maintainOutbound(node, profile, peer, () => assert.fail('no issuance or cleanup during these checks'));
  return { check, requests, revoke: () => { directVerdict = 'revoked'; }, wrongParent: () => { reportedParent = 'different-parent'; } };
}

test('outbound survives the original deadline only with a confirmed live successor', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: edge - 1_000 });
  const f = fixture();
  assert.equal((await f.check()).state, 'live');
  assert.deepEqual(f.requests, ['query'], 'ordinary active listing needs no status request');

  t.mock.timers.setTime(edge + 7_000);
  assert.equal((await f.check()).state, 'live', 'a confirmed successor remains live past the signed parent/predecessor end');
  assert.deepEqual(f.requests, ['query', 'query', nextCid], 'check the installed successor, not the owner or expired predecessor');

  f.revoke();
  assert.equal((await f.check()).state, 'unavailable', 'the renewal fallback cannot treat a revoked successor as live');
  assert.deepEqual(f.requests.slice(-2), ['query', nextCid]);
});

test('the fallback does not check a successor from an unrelated parent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: edge + 7_000 });
  const f = fixture();
  f.wrongParent();
  assert.equal((await f.check()).state, 'unavailable');
  assert.deepEqual(f.requests, ['query']);
});
