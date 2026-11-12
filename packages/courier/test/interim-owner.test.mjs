import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { AGENT_GRANT } from '../dist/keys.js';
import { loadProfile, loadGrant, loadKey, writeSecure } from '../dist/profile.js';
import { preflightOwner, loadOwnerEpisode, markOwnerRefused, OWNER_ASK_AHEAD_MS } from '../dist/interim-owner.js';
import { approvalIntent } from '../dist/grant-request.js';
import { requestHash } from '../dist/canonical.js';

const DAY = 86_400_000;
const wasm = new NodeWasmBindings();
const owner = new PrivateKeySigner('1'.padStart(64, '0'));
let count = 0;
async function fixture(days) {
  const home = path.join(process.env.COURIER_TEST_HOME, `owner-episode-${++count}`);
  fs.mkdirSync(home, { mode: 0o700 }); process.env.COURIER_HOME = home;
  process.env.TC_LINKS_API_ORIGIN = 'https://links.fixture.invalid';
  process.env.COURIER_OPENKEY_API_HOST = 'https://openkey.fixture.invalid';
  const manager = wasm.createSessionManager(); const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
  const address = await owner.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, 'agents');
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const expiresAt = new Date(Date.now() + days * DAY).toISOString();
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: new Date().toISOString(), expirationTime: expiresAt, spaceId, jwk: key.jwk });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const profile = { version: 3, host: 'https://node.fixture.invalid', openkeyHost: 'https://openkey.fixture.invalid', courierDid: key.did.split('#')[0], ownerDid, spaceId, status: 'ready', peers: {} };
  const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, siwe: prepared.siwe, signature, expiresAt, spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did };
  for (const [file, value] of [['profile.json', profile], ['grant.json', grant], ['key.json', key]]) fs.writeFileSync(path.join(home, file), JSON.stringify(value), { mode: 0o600 });
  return { home, profile, grant, key };
}
async function withoutNetwork(fn) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('synthetic network unavailable'); };
  try { await fn(() => calls); } finally { globalThis.fetch = original; }
}

test('eight-day threshold asks with at least seven days lead on a daily cadence', async () => {
  assert.equal(OWNER_ASK_AHEAD_MS, 8 * DAY);
  await fixture(20);
  await withoutNetwork(async calls => { assert.equal((await preflightOwner({ request: true })).state, 'live'); assert.equal(calls(), 0); });
});

test('one failed automatic create is durable across concurrent turns and restart; no repeat or polling', async () => {
  const { home } = await fixture(7);
  await withoutNetwork(async calls => {
    const results = await Promise.all([preflightOwner({ request: true }), preflightOwner({ request: true })]);
    assert.equal(results[0].state, 'approval-unavailable');
    assert.equal(results[1].state, 'approval-unavailable');
    assert.equal(calls(), 1);
    const episode = loadOwnerEpisode();
    assert.equal(episode.phase, 'unavailable');
    assert.equal(episode.ownerGrantCid, loadGrant().delegationCid);
    assert.equal(episode.courierDid, loadProfile().courierDid);
    assert.equal(loadProfile().version, 4);
    assert.equal(fs.statSync(path.join(home, 'renewal-owner.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    await preflightOwner({ request: true });
    assert.equal(calls(), 1);
  });
});

test('lapsed startup makes zero network calls even without a saved episode', async () => {
  const f = await fixture(7);
  writeSecure(path.join(f.home, 'grant.json'), { ...f.grant, expiresAt: new Date(0).toISOString() });
  await withoutNetwork(async calls => {
    assert.equal((await preflightOwner({ request: true })).state, 'approval-required');
    assert.equal((await preflightOwner({ request: true })).state, 'approval-required');
    assert.equal(calls(), 0);
    assert.equal(loadOwnerEpisode(), undefined);
  });
});

test('ambiguous creating episode never creates a second request', async () => {
  const f = await fixture(7);
  writeSecure(path.join(f.home, 'renewal-owner.json'), { ownerGrantCid: f.grant.delegationCid, expiresAt: f.grant.expiresAt,
    courierDid: f.profile.courierDid, intentHash: requestHash(approvalIntent(f.profile, f.key)), requestId: null, requestHash: null, phase: 'creating' });
  await withoutNetwork(async calls => { assert.equal((await preflightOwner({ request: true })).state, 'approval-unavailable'); assert.equal(calls(), 0); });
});

test('owner revocation or a terminal authorization refusal never auto-asks or polls', async () => {
  const f = await fixture(7);
  await markOwnerRefused();
  await withoutNetwork(async calls => {
    assert.equal((await preflightOwner({ request: true })).state, 'revoked');
    assert.equal((await preflightOwner({ request: true })).state, 'revoked');
    assert.equal(calls(), 0);
  });
  assert.equal(loadOwnerEpisode().phase, 'refused');
  assert.equal(loadOwnerEpisode().ownerGrantCid, f.grant.delegationCid);
});

test('a changed installed owner CID closes the old episode instead of reusing its request', async () => {
  const f = await fixture(20);
  writeSecure(path.join(f.home, 'renewal-owner.json'), { ownerGrantCid: 'prior-owner-grant', expiresAt: f.grant.expiresAt,
    courierDid: f.profile.courierDid, intentHash: 'prior-intent', requestId: 'old-request', requestHash: 'old-hash', phase: 'requested' });
  await withoutNetwork(async calls => { assert.equal((await preflightOwner({ request: true })).state, 'live'); assert.equal(calls(), 0); });
  assert.equal(loadOwnerEpisode().phase, 'complete');
  assert.equal(loadOwnerEpisode().requestId, 'old-request');
});

test('structured owner 401/403 stops issuance and makes subsequent runtime startup local-only', async () => {
  const { maintainPeerSet, createRuntimeNode } = await import('../dist/interim-runtime.js');
  for (const status of [401, 403]) {
    const f = await fixture(20);
    const profile = loadProfile();
    profile.peers.bob = { handle: 'bob', status: 'paired', courierDid: 'did:key:bob', spaceId: f.profile.spaceId,
      theirHandleForMe: 'alice', inbound: { cid: 'inbound', delegation: 'not-read', expiresAt: f.grant.expiresAt },
      outbound: [{ cid: 'prior', expiresAt: f.grant.expiresAt, issuedAt: new Date().toISOString() }] };
    writeSecure(path.join(f.home, 'profile.json'), profile);
    let queries = 0;
    const node = { credentialHolderDid: profile.courierDid, restorableSession: { delegationCid: f.grant.delegationCid, siwe: f.grant.siwe },
      delegationManager: { queryAllIssued: async () => { queries++; return { ok: false, error: { meta: { status } } }; } } };
    await assert.rejects(maintainPeerSet(node), { code: 'owner-authority-refused' });
    assert.equal(queries, 1);
    await withoutNetwork(async calls => {
      for (let i = 0; i < 2; i++) await assert.rejects(createRuntimeNode(), { code: 'owner-revoked' });
      assert.equal(calls(), 0);
    });
  }
});

test('an unavailable issued listing cannot cause an automatic owner approval before authority is checked', async () => {
  const { maintainPeerSet } = await import('../dist/interim-runtime.js');
  const f = await fixture(7); const profile = loadProfile();
  profile.peers.bob = { handle: 'bob', status: 'paired', courierDid: 'did:key:bob', spaceId: f.profile.spaceId,
    theirHandleForMe: 'alice', inbound: { cid: 'inbound', delegation: 'not-read', expiresAt: f.grant.expiresAt },
    outbound: [{ cid: 'prior', expiresAt: f.grant.expiresAt, issuedAt: new Date().toISOString() }] };
  writeSecure(path.join(f.home, 'profile.json'), profile);
  const node = { credentialHolderDid: profile.courierDid, restorableSession: { delegationCid: f.grant.delegationCid, siwe: f.grant.siwe },
    delegationManager: { queryAllIssued: async () => ({ ok: false, error: { meta: { status: 503 } } }) } };
  await withoutNetwork(async calls => { await maintainPeerSet(node); assert.equal(calls(), 0); });
  assert.equal(loadOwnerEpisode(), undefined);
  assert.ok(loadProfile().peers.bob.interim.unavailableAt);
});

test('zero eligible peers require authenticated own-space read; refused or unknown read never asks', async () => {
  const { maintainPeerSet } = await import('../dist/interim-runtime.js');
  for (const status of [401, 403, 503]) {
    await fixture(7); let reads = 0;
    const node = { kv: { get: async () => { reads++; return { ok: false, error: { meta: { status } } }; } } };
    await withoutNetwork(async calls => {
      if (status === 503) {
        await maintainPeerSet(node);
        assert.equal(loadOwnerEpisode(), undefined);
      } else {
        await assert.rejects(maintainPeerSet(node), { code: 'owner-authority-refused' });
        assert.equal(loadOwnerEpisode().phase, 'refused');
      }
      assert.equal(calls(), 0);
    });
    assert.equal(reads, 1);
  }
});

test('an authorized own-space missing key permits one ask; failed creation is not retried or reprobed', async () => {
  const { maintainPeerSet } = await import('../dist/interim-runtime.js');
  await fixture(7); let reads = 0;
  const node = { kv: { get: async () => { reads++; return { ok: false, error: { status: 404, code: 'KV_NOT_FOUND' } }; } } };
  await withoutNetwork(async calls => {
    await maintainPeerSet(node);
    assert.equal(reads, 1);
    assert.equal(calls(), 1);
    assert.equal(loadOwnerEpisode().phase, 'unavailable');
    await maintainPeerSet(node);
    assert.equal(reads, 1);
    assert.equal(calls(), 1);
  });
});


test('owner preflight defaults to local-only even when an owner request is due', async () => {
  await fixture(7);
  await withoutNetwork(async calls => { assert.equal((await preflightOwner()).state, 'live'); assert.equal(calls(), 0); });
  assert.equal(loadOwnerEpisode(), undefined);
});
