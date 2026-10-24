import { assertIsolated, testHome } from './tc1916-home.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { revokePeer } from '../dist/commands.js';
import { AGENT_GRANT, REVOKE_GRANT_ENTRY, k } from '../dist/keys.js';
import { loadProfile, saveProfile } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

before(() => assertIsolated());

const NOW = Date.parse('2026-10-24T12:00:00Z');
const FUTURE = '2026-10-31T12:00:00.000Z';
const PAST = '2026-10-20T12:00:00.000Z';

const grant = (cid, expiresAt = FUTURE, extra = {}) => ({ cid, issuedAt: '2026-10-23T12:00:00.000Z', expiresAt, ...extra });

async function withHome(outbound, fn) {
  const prior = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(testHome, 'revoke-'));
  process.env.COURIER_HOME = home;
  try {
    assertIsolated();
    const profile = {
      version: 3,
      host: 'https://tee.node.tinycloud.xyz',
      openkeyHost: 'https://openkey.so',
      label: 'test',
      courierDid: 'did:key:z6Mkagent',
      status: 'ready',
      peers: {
        bob: { handle: 'bob', ownerDid: 'did:pkh:bob', courierDid: 'did:key:z6Mkbob', spaceId: 'space', outbound, status: 'paired', pairedAt: '2026-10-23T12:00:00.000Z' },
        carol: { handle: 'carol', ownerDid: 'did:pkh:carol', courierDid: 'did:key:z6Mkcarol', spaceId: 'space', outbound: [grant('carol-1')], status: 'paired', pairedAt: '2026-10-23T12:00:00.000Z' },
      },
    };
    saveProfile(profile);
    return await fn(loadProfile());
  } finally {
    if (prior === undefined) delete process.env.COURIER_HOME; else process.env.COURIER_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A node whose revokeDelegation answers per cid: 'ok', 'refuse', or 'throw'. `caps` is the signed grant. */
function fakeNode(behaviour = {}, caps = AGENT_GRANT) {
  const kv = memoryKv();
  kv.rows.set(k.peerRecord('bob'), { value: { handle: 'bob' }, etag: 'e0' });
  const calls = [];
  return {
    calls,
    kv,
    behaviour,
    getVerifiedSessionCapabilities: () => caps,
    async revokeDelegation(cid) {
      calls.push(cid);
      const mode = this.behaviour[cid] ?? 'ok';
      if (mode === 'throw') throw new Error('socket hang up');
      if (mode === 'refuse') return { ok: false, error: { code: 'REVOCATION_FAILED', message: 'Failed to revoke delegation: 403 - Unauthorized Revoker', service: 'delegation' } };
      return { ok: true, data: { revoked: true, cid } };
    },
  };
}

const revokeFailed = (error) => error.code === 'revoke-failed';

test('every live outbound grant is revoked on the node, then the peer and its record are dropped', async () => {
  await withHome([grant('g1'), grant('g2'), grant('g3')], async (profile) => {
    const node = fakeNode();
    const line = await revokePeer(profile, node, 'bob', NOW);
    assert.deepEqual(node.calls, ['g1', 'g2', 'g3']);
    assert.match(line, /Revoked bob \(did:key:z6Mkbob\): 3 outbound grant\(s\) revoked\.$/);
    assert.equal(loadProfile().peers.bob, undefined);
    assert.ok(loadProfile().peers.carol, 'other peers stay');
    assert.equal(node.kv.rows.has(k.peerRecord('bob')), false);
  });
});

test('a refused grant fails with revoke-failed naming its cid, and keeps the peer and its record', async () => {
  await withHome([grant('g1'), grant('g2'), grant('g3')], async (profile) => {
    const node = fakeNode({ g2: 'refuse' });
    await assert.rejects(revokePeer(profile, node, 'bob', NOW), (error) => {
      assert.ok(revokeFailed(error));
      assert.match(error.message, /g2 \(REVOCATION_FAILED: .*Unauthorized Revoker\)/);
      assert.doesNotMatch(error.message, /g1|g3/);
      return true;
    });
    assert.deepEqual(node.calls, ['g1', 'g2', 'g3'], 'a refusal does not stop the other grants');
    const kept = loadProfile().peers.bob;
    assert.ok(kept, 'peer kept');
    assert.deepEqual(kept.outbound.map((g) => [g.cid, Boolean(g.revokedAt)]), [['g1', true], ['g2', false], ['g3', true]]);
    assert.equal(node.kv.rows.has(k.peerRecord('bob')), true, 'peer record kept');
  });
});

test('a thrown node error counts as a failed grant', async () => {
  await withHome([grant('g1')], async (profile) => {
    const node = fakeNode({ g1: 'throw' });
    await assert.rejects(revokePeer(profile, node, 'bob', NOW), (error) => revokeFailed(error) && /g1 \(error: socket hang up\)/.test(error.message));
    assert.ok(loadProfile().peers.bob);
  });
});

test('a re-run retries only the grants that failed, then drops the peer', async () => {
  await withHome([grant('g1'), grant('g2'), grant('g3')], async (profile) => {
    const first = fakeNode({ g2: 'refuse' });
    await assert.rejects(revokePeer(profile, first, 'bob', NOW), revokeFailed);

    const second = fakeNode();
    const line = await revokePeer(loadProfile(), second, 'bob', NOW);
    assert.deepEqual(second.calls, ['g2']);
    assert.match(line, /1 outbound grant\(s\) revoked, 2 revoked by an earlier run\.$/);
    assert.equal(loadProfile().peers.bob, undefined);
    assert.equal(second.kv.rows.has(k.peerRecord('bob')), false);
  });
});

test('expired grants are skipped without a node call and reported', async () => {
  await withHome([grant('old1', PAST), grant('live'), grant('old2', PAST)], async (profile) => {
    const node = fakeNode();
    const line = await revokePeer(profile, node, 'bob', NOW);
    assert.deepEqual(node.calls, ['live']);
    assert.match(line, /1 outbound grant\(s\) revoked, 2 expired and skipped\.$/);
  });
});

test('only expired grants: no node call, the peer is still dropped', async () => {
  await withHome([grant('old', PAST)], async (profile) => {
    const node = fakeNode();
    const line = await revokePeer(profile, node, 'bob', NOW);
    assert.deepEqual(node.calls, []);
    assert.match(line, /0 outbound grant\(s\) revoked, 1 expired and skipped\.$/);
    assert.equal(loadProfile().peers.bob, undefined);
  });
});

test('a peer with no outbound grants is dropped without a node call', async () => {
  await withHome([], async (profile) => {
    const node = fakeNode();
    const line = await revokePeer(profile, node, 'bob', NOW);
    assert.deepEqual(node.calls, []);
    assert.match(line, /0 outbound grant\(s\) revoked\.$/);
    assert.equal(loadProfile().peers.bob, undefined);
    assert.equal(node.kv.rows.has(k.peerRecord('bob')), false);
  });
});

test('a grant already marked revoked is not sent to the node again', async () => {
  await withHome([grant('g1', FUTURE, { revokedAt: '2026-10-24T11:00:00.000Z' })], async (profile) => {
    const node = fakeNode();
    const line = await revokePeer(profile, node, 'bob', NOW);
    assert.deepEqual(node.calls, []);
    assert.match(line, /0 outbound grant\(s\) revoked, 1 revoked by an earlier run\.$/);
    assert.equal(loadProfile().peers.bob, undefined);
  });
});

test('an unknown peer is unknown-peer and touches nothing', async () => {
  await withHome([grant('g1')], async (profile) => {
    const node = fakeNode();
    await assert.rejects(revokePeer(profile, node, 'nobody', NOW), { code: 'unknown-peer' });
    assert.deepEqual(node.calls, []);
  });
});

const OLD_GRANT = AGENT_GRANT.filter((entry) => entry !== REVOKE_GRANT_ENTRY);

test('a grant without the revoke entry fails revoke-not-enabled before any node call and keeps everything', async () => {
  await withHome([grant('g1'), grant('g2')], async (profile) => {
    const node = fakeNode({}, OLD_GRANT);
    await assert.rejects(revokePeer(profile, node, 'bob', NOW), (error) => {
      assert.equal(error.code, 'revoke-not-enabled');
      assert.equal(error.message, 'This install cannot revoke yet: re-run `courier init` to enable revoke.');
      return true;
    });
    assert.equal(node.calls.length, 0, 'zero revokeDelegation calls');
    const kept = loadProfile().peers.bob;
    assert.deepEqual(kept.outbound.map((g) => g.revokedAt), [undefined, undefined]);
    assert.equal(node.kv.rows.has(k.peerRecord('bob')), true, 'peer record kept');
  });
});

test('a grant without the revoke entry refuses even a peer with no live grants', async () => {
  await withHome([], async (profile) => {
    const node = fakeNode({}, OLD_GRANT);
    await assert.rejects(revokePeer(profile, node, 'bob', NOW), { code: 'revoke-not-enabled' });
    assert.ok(loadProfile().peers.bob);
  });
});

test('a revoke entry with the wrong shape does not enable revoke', async () => {
  const wrong = [
    { ...REVOKE_GRANT_ENTRY, space: 'other' },
    { ...REVOKE_GRANT_ENTRY, path: 'x/' },
    { ...REVOKE_GRANT_ENTRY, actions: ['tinycloud.delegation/status'] },
  ];
  for (const entry of wrong) {
    await withHome([grant('g1')], async (profile) => {
      const node = fakeNode({}, [...OLD_GRANT, entry]);
      await assert.rejects(revokePeer(profile, node, 'bob', NOW), { code: 'revoke-not-enabled' });
      assert.equal(node.calls.length, 0);
    });
  }
});
