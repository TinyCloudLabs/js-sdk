import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { memoryKv } from './memory-kv.mjs';
import { k } from '../dist/keys.js';
import { buildMessage } from '../dist/a2a.js';

function side(selfKv, courierDid, handle = 'bob', profileId = 'home-a') {
  const remote = memoryKv(), events = [], wakes = [];
  const peer = { handle, theirHandleForMe: 'me', status: 'paired', inbound: { cid: handle }, spaceId: 's' };
  const deps = { courierDid, selfKv, spaceId: 'same-owner-agents', selfHooks: {}, peerHooks: async () => ({}),
    loadPeers: () => [peer], kvFor: async () => remote, wake: async request => { wakes.push(request); },
    holder: { profileId }, log: (event, fields) => events.push({ event, ...fields }) };
  const watcher = new Watcher(deps, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25 });
  const send = () => {
    const threadId = ulid();
    const body = buildMessage({ threadId, text: 'new work', role: 'ROLE_USER', intent: 'request' });
    remote.rows.set(k.msg('me', threadId, body.messageId), { value: body, etag: 'remote' });
    return { threadId, messageId: body.messageId };
  };
  return { watcher, peer, events, wakes, send, deps };
}

test('distinct authenticated identities in one owner space maintain separate watcher state', async () => {
  const selfKv = memoryKv();
  const a = side(selfKv, 'did:key:zAgentA', 'peer-a'), b = side(selfKv, 'did:key:zAgentB', 'peer-b');
  a.send(); b.send();
  await Promise.all([a.watcher.loadState(), b.watcher.loadState()]);
  await Promise.all([a.watcher.sync(a.peer, 'hook'), b.watcher.sync(b.peer, 'poll')]);
  await Promise.all([a.watcher.tick(true), b.watcher.tick(true)]);
  assert.equal(a.wakes.length, 1);
  assert.equal(b.wakes.length, 1);
  assert.ok(![...a.events, ...b.events].some(event => event.code === 'state-conflict'));
  const states = [...selfKv.rows.entries()].filter(([key]) => key.includes('/me/state/watch/'));
  assert.equal(states.length, 2);
  assert.equal(selfKv.rows.has(k.watchState), false);
});

test('the same authenticated identity in different homes still shares a CAS guard', async () => {
  const selfKv = memoryKv();
  const a = side(selfKv, 'did:key:zSame', 'peer-a', 'home-a'), b = side(selfKv, 'did:key:zSame', 'peer-b', 'home-b');
  a.send(); b.send();
  await Promise.all([a.watcher.loadState(), b.watcher.loadState()]);
  await a.watcher.sync(a.peer, 'hook');
  await b.watcher.sync(b.peer, 'poll');
  assert.ok(b.events.some(event => event.code === 'state-conflict'));
  assert.equal([...selfKv.rows.keys()].filter(key => key.includes('/me/state/watch/')).length, 1);
});

test('new state does not read, adopt, change or delete legacy global state', async () => {
  const selfKv = memoryKv();
  const legacy = { value: { v: 1, pending: { ambiguous: 'old work' }, woken: ['old-message'] }, etag: 'legacy-etag' };
  selfKv.rows.set(k.watchState, structuredClone(legacy));
  for (const op of ['get', 'put', 'delete']) {
    const original = selfKv[op].bind(selfKv);
    selfKv[op] = async (key, ...args) => { assert.notEqual(key, k.watchState); return original(key, ...args); };
  }
  const a = side(selfKv, 'did:key:zNew');
  a.send();
  await a.watcher.loadState();
  await a.watcher.sync(a.peer, 'poll');
  await a.watcher.tick(true);
  assert.equal(a.wakes.length, 1);
  assert.deepEqual(selfKv.rows.get(k.watchState), legacy);
  assert.equal(Object.hasOwn(a.watcher.snapshot().pending, 'ambiguous'), false);
});

test('identity state retains pending work across restarts and woken dedup when receipts fail', async () => {
  const selfKv = memoryKv();
  const put = selfKv.put.bind(selfKv);
  selfKv.put = async (key, ...args) => {
    if (key.endsWith('/receipts.json')) throw new Error('receipt unavailable');
    return put(key, ...args);
  };
  const a = side(selfKv, 'did:key:zPersistent');
  const sent = a.send();
  await a.watcher.loadState();
  await a.watcher.sync(a.peer, 'poll');
  const resumed = new Watcher(a.deps, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25 });
  await resumed.loadState();
  assert.equal(resumed.snapshot().pending[`bob/${sent.threadId}`].messages[0].messageId, sent.messageId);
  await resumed.tick(true);
  assert.equal(a.wakes.length, 1);
  const restarted = new Watcher(a.deps, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25 });
  await restarted.loadState();
  await restarted.sync(a.peer, 'hook');
  await restarted.tick(true);
  assert.equal(a.wakes.length, 1);
  assert.ok(restarted.snapshot().woken.includes(sent.messageId));
});
