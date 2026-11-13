// TC-2917 (Bobbie P1): an action-time authority check that cannot give a positive verdict (a 503, a timeout, anything
// but "live") fails closed: no wake, import or inform runs; the item stays queued and is retried on the next pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { AGENT_GRANT, k, PREFIX } from '../dist/keys.js';
import { maintainPeerSet } from '../dist/interim-runtime.js';
import { memoryKv } from './memory-kv.mjs';

const unavailable = () => Object.assign(new Error('node busy'), { status: 503 });

function side({ budget = 12 } = {}) {
  const clock = { t: Date.parse('2026-11-13T12:00:00Z') };
  const selfKv = memoryKv();
  const peerKv = memoryKv();
  const peer = {
    handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zBob', spaceId: 'space-bob', theirHandleForMe: 'alice',
    inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(clock.t + 86_400_000).toISOString() }, outbound: [], status: 'paired',
  };
  const state = { failing: false, wakes: [], informs: [], events: [], checks: 0 };
  const watcher = new Watcher({
    selfKv, spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [peer], kvFor: async () => peerKv,
    checkAuthority: async (handle) => { if (handle === undefined) return; state.checks++; if (state.failing) throw unavailable(); },
    wake: async (request) => { state.wakes.push(request); },
    postInform: async (...args) => { state.informs.push(args); },
    log: (event, fields) => state.events.push({ event, ...fields }),
    now: () => clock.t,
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: budget });
  const say = (threadId = ulid(), intent = 'request') => {
    const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent, from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid(clock.t);
    peerKv.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'm' });
    return message.messageId;
  };
  return { watcher, state, clock, selfKv, peer, say };
}

test('a 503 from the check before a wake: no wake, the request stays queued, the next pass wakes it', async () => {
  const s = side();
  await s.watcher.loadState();
  s.say();
  await s.watcher.pollOnce('poll');
  assert.equal(Object.keys(s.watcher.snapshot().pending).length, 1);
  s.state.failing = true;
  await s.watcher.tick(true);
  assert.equal(s.state.wakes.length, 0, '0 wakes on a 503');
  assert.equal(Object.keys(s.watcher.snapshot().pending).length, 1, 'still queued');
  assert.ok(s.state.events.some((e) => e.event === 'wake-deferred' && e.reason === 'authority-unverified'));
  assert.equal([...s.selfKv.rows.keys()].some((key) => key.includes('/wake-claims/')), false, 'no claim left behind');
  s.state.failing = false;
  s.clock.t += 60_000;
  await s.watcher.tick();
  assert.equal(s.state.wakes.length, 1, 'woken once the check succeeds');
});

test('a 503 from the check before an import: nothing is mirrored or receipted; the next pass delivers it', async () => {
  const s = side();
  await s.watcher.loadState();
  s.state.failing = true;
  const id = s.say();
  await s.watcher.sync(s.peer, 'hook');
  assert.equal([...s.selfKv.rows.keys()].some((key) => key.includes('/mirror/')), false, 'nothing imported');
  assert.equal(s.selfKv.rows.has(k.receipts('bob')), false, 'no receipt');
  assert.ok(s.state.events.some((e) => e.event === 'sync-error'), 'logged');
  s.state.failing = false;
  await s.watcher.pollOnce('poll');
  assert.ok(s.state.events.some((e) => e.event === 'delivered' && e.messageId === id));
});

test('a 503 from the check before an inform: not posted, not dropped and not counted as a failed attempt; posted after', async () => {
  const s = side({ budget: 1 });
  await s.watcher.loadState();
  const thread = ulid();
  s.say(thread, 'update');
  await s.watcher.pollOnce('poll'); await s.watcher.tick();
  s.clock.t += 1000;
  s.say(thread, 'update');
  await s.watcher.pollOnce('poll'); // imported while the check still succeeds
  s.state.failing = true;
  await s.watcher.tick(); // over budget: paused, inform queued
  for (let i = 0; i < 10; i++) { s.clock.t += 61_000; await s.watcher.tick(); }
  assert.deepEqual(s.state.informs, [], 'nothing posted while unverified');
  const queued = s.watcher.snapshot().outbox.filter((item) => item.kind === 'inform');
  assert.equal(queued.length, 1, 'still queued after ten deferrals');
  assert.equal(queued[0].tries ?? 0, 0, 'deferrals are not failed attempts');
  assert.ok(s.state.events.some((e) => e.event === 'inform-deferred'));
  s.state.failing = false;
  s.clock.t += 61_000;
  await s.watcher.tick();
  assert.equal(s.state.informs.length, 1, 'posted once the check succeeds');
});

test('maintainPeerSet: a strict check of a peer whose issued listing answers 503 throws authority-unverified; a plain one does not', async () => {
  const wasm = new NodeWasmBindings();
  const owner = new PrivateKeySigner('2'.padStart(64, '0'));
  const home = path.join(process.env.COURIER_TEST_HOME, 'fail-closed');
  fs.mkdirSync(home, { mode: 0o700 });
  process.env.COURIER_HOME = home;
  const manager = wasm.createSessionManager(); const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
  const address = await owner.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, 'agents');
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const expiresAt = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: new Date().toISOString(), expirationTime: expiresAt, spaceId, jwk: key.jwk });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const courierDid = key.did.split('#')[0];
  const peer = { handle: 'bob', status: 'paired', courierDid: 'did:key:zBob', spaceId: 'space-bob', theirHandleForMe: 'alice', ownerDid: 'did:pkh:eip155:1:0x02',
    inbound: { delegation: 'wire', cid: 'cid-in', expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString() },
    outbound: [{ cid: 'prior', issuedAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }] };
  const profile = { version: 3, host: 'https://node.fixture.invalid', openkeyHost: 'https://openkey.fixture.invalid', courierDid, ownerDid, spaceId, status: 'ready', peers: { bob: peer } };
  const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, siwe: prepared.siwe, signature, expiresAt, spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did };
  for (const [file, value] of [['profile.json', profile], ['grant.json', grant], ['key.json', key]]) fs.writeFileSync(path.join(home, file), JSON.stringify(value), { mode: 0o600 });
  let queries = 0;
  const node = {
    credentialHolderDid: courierDid,
    restorableSession: { delegationCid: session.delegationCid, siwe: prepared.siwe },
    delegationManager: { queryAllIssued: async () => { queries++; return { ok: false, error: { meta: { status: 503 } } }; } },
  };
  await assert.rejects(maintainPeerSet(node, 'bob', false, true), { code: 'authority-unverified' });
  assert.equal(queries, 1);
  await maintainPeerSet(node, 'bob'); // housekeeping notes it and carries on
  assert.equal(queries, 2);
});
