import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revokePeer } from '../dist/revoke.js';
import { peerReadPermissions } from '../dist/keys.js';

const space = 'tinycloud:pkh:eip155:1:0x1:agents';
function fixture() {
  const profile = { version: 3, host: 'http://127.0.0.1', courierDid: 'did:key:issuer', spaceId: space, peers: {
    bob: { handle: 'bob', courierDid: 'did:key:bob', outbound: [{ cid: 'one', issuedAt: '2026-01-01', expiresAt: '2027-01-01' }] },
  } };
  const record = (cid, changes = {}) => ({ cid, delegatorDid: profile.courierDid, delegateDid: 'did:key:bob',
    resources: peerReadPermissions('bob', space).map((p) => ({ resource: `${space}/${p.service.replace('tinycloud.', '')}/${p.path}`, actions: p.actions, caveats: p.actions.map(() => ({})) })), ...changes });
  return { profile, record };
}

test('all children and unrecorded current replacement revoked, progress survives failure and retry', async () => {
  const { profile, record } = fixture();
  const calls = [];
  let fail = true;
  const node = { delegationManager: {
    queryAllIssued: async (opts) => { assert.deepEqual(opts, { space }); return { ok: true, data: [record('one'), record('replacement'), record('foreign', { delegateDid: 'did:key:other' }), record('other-mailbox', { resources: [] })] }; },
    revokeIssued: async (cid) => { calls.push(cid); return cid === 'replacement' && fail ? { ok: false, error: { code: 'NETWORK_ERROR', message: 'https://private.invalid/?secret=unsafe' } } : { ok: true, data: { cid, revoked: true } }; },
  } };
  let disk;
  const save = () => { disk = structuredClone(profile); };
  await assert.rejects(revokePeer(node, profile, 'bob', save), /the node couldn.t be reached/);
  assert.ok(disk.peers.bob.outbound[0].revokedAt);
  assert.equal(disk.peers.bob.outbound[1].revokedAt, undefined);
  fail = false;
  await revokePeer(node, disk, 'bob', () => {});
  assert.deepEqual(calls, ['one', 'replacement', 'replacement']);
  assert.ok(disk.peers.bob.outbound.every((e) => e.revokedAt));
});

test('listing failure and wrong holder/scope keep pairing and revoke nothing', async () => {
  for (const change of [null, { delegateDid: 'did:key:other' }, { delegatorDid: 'did:key:other' }, { resources: [] }]) {
    const { profile, record } = fixture();
    let calls = 0;
    const node = { delegationManager: {
      queryAllIssued: async () => change ? { ok: true, data: [record('one', change)] } : { ok: false, error: { code: 'NETWORK_ERROR', message: 'https://private.invalid/?secret=unsafe' } },
      revokeIssued: async () => { calls++; },
    } };
    await assert.rejects(revokePeer(node, profile, 'bob', () => assert.fail('must not save')));
    assert.equal(calls, 0);
    assert.ok(profile.peers.bob);
  }
});

test('concurrent revokes keep both removals and never hold the profile lock during network work', async t => {
  const { concurrentRevokes } = await import('./support/concurrent-revoke.mjs');
  await concurrentRevokes(t);
});


test('node failure text and peer controls are never echoed', async () => {
  for (const [code, reason] of [['PERMISSION_DENIED', 'the node refused'], ['NETWORK_ERROR', "the node couldn't be reached"], ['CHAIN_TOO_DEEP', "the node couldn't be reached"], ['OTHER', 'unexpected node response']]) {
    const { profile } = fixture();
    const handle = 'bob\n\x1b[31m';
    profile.peers[handle] = profile.peers.bob;
    const node = { delegationManager: { queryAllIssued: async () => ({ ok: false, error: { code, message: 'https://private.invalid/?secret=unsafe\n' } }) } };
    await assert.rejects(revokePeer(node, profile, handle, () => {}), (e) => {
      assert.ok(e.message.includes(reason));
      assert.ok(!/[\n\x1b]/.test(e.message));
      assert.ok(!e.message.includes('private.invalid'));
      assert.ok(!e.message.includes('unsafe'));
      return true;
    });
  }
});
