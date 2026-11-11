// TC-2802: the SDK retries a node 503 with the same if-match. If the first attempt had been applied, the retry is
// refused 412 and, before this fix, the watcher stopped with state-conflict with nothing logged before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { collectInbound, commitReceipts } from '../dist/inbox.js';
import { k, PREFIX } from '../dist/keys.js';
import { nodeKv } from './support/node-kv.mjs';

const peer = {
  handle: 'bob',
  ownerDid: 'did:pkh:eip155:1:0x02',
  courierDid: 'did:key:zBob',
  spaceId: 'tinycloud:pkh:eip155:1:0x02:agents',
  theirHandleForMe: 'alice',
  inbound: { delegation: 'wire', cid: 'cid-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  outbound: [],
  status: 'paired',
  pairedAt: new Date().toISOString(),
};

function world() {
  const selfKv = nodeKv();
  const peerSide = nodeKv();
  const clock = { t: Date.parse('2026-11-10T22:00:00Z') };
  const mk = (pid = 100) => {
    const wakes = [];
    const events = [];
    const watcher = new Watcher({
      selfKv, spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [peer], kvFor: async () => peerSide,
      wake: async (request) => { wakes.push(request); },
      log: (event, fields) => events.push({ event, ...fields }),
      holder: { profileId: 'profile-1', pid, isAlive: () => true },
      now: () => clock.t,
    }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25 });
    return { watcher, wakes, events };
  };
  const send = (thread) => {
    const message = buildMessage({ threadId: thread, text: 'hi', role: 'ROLE_USER', intent: 'request', from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid(clock.t);
    peerSide.rows.set(`${PREFIX}/to/alice/threads/${thread}/msg/${message.messageId}.json`, { text: JSON.stringify(message), etag: `"m-${message.messageId}"` });
    return message.messageId;
  };
  return { selfKv, peerSide, clock, mk, send };
}

const woken = (wakes) => wakes.flatMap((w) => w.messages.map((m) => m.messageId));

test('a 412 that answers a retry of the watcher\'s own applied write does not stop it, lose receipts or wake twice', async () => {
  const w = world();
  const { watcher, wakes, events } = w.mk();
  await watcher.loadState();
  const thread = ulid(w.clock.t);
  const sent = [];
  for (let cycle = 0; cycle < 30; cycle++) {
    w.clock.t += 61_000;
    sent.push(w.send(thread));
    if (cycle % 2 === 0) w.selfKv.fault(k.watchState, 'retried-after-applied'); // the delivery's write
    await Promise.all([
      watcher.sync(peer, cycle % 2 ? 'hook' : 'poll'),
      collectInbound({ selfKv: w.selfKv, peers: [peer], kvFor: async () => w.peerSide }),
    ]);
    if (cycle % 3 === 0) w.selfKv.fault(k.watchState, 'retried-after-applied'); // the wake's
    await watcher.tick();
    if (cycle % 4 === 0) await commitReceipts(w.selfKv, (await collectInbound({ selfKv: w.selfKv, peers: [peer], kvFor: async () => w.peerSide })).pending);
  }
  assert.equal(watcher.fatalError, undefined, `no state-conflict: ${JSON.stringify(events.filter((e) => /error/.test(e.event)))}`);
  assert.deepEqual([...woken(wakes)].sort(), [...sent].sort(), 'every message woken');
  assert.equal(new Set(woken(wakes)).size, woken(wakes).length, 'no message woken twice');
  assert.deepEqual(w.selfKv.value(k.receipts('bob')).threads[thread].delivered, [...sent].sort(), 'every receipt kept');
  assert.deepEqual(w.selfKv.value(k.watchState).pending, {}, 'nothing left pending');
});

test('a 412 for a body another watcher wrote still stops the watcher, and that state is kept', async () => {
  const w = world();
  const a = w.mk(100);
  const b = w.mk(200);
  await a.watcher.loadState();
  await b.watcher.loadState();
  w.send(ulid(w.clock.t));
  await b.watcher.sync(peer, 'poll'); // B writes first: A's etag is now stale
  const theirs = w.selfKv.rows.get(k.watchState).text;
  w.clock.t += 1000;
  w.send(ulid(w.clock.t));
  await a.watcher.sync(peer, 'poll');
  assert.equal(a.watcher.fatalError?.code, 'state-conflict');
  assert.equal(w.selfKv.rows.get(k.watchState).text, theirs);
});

test('a retried own write that another writer overtook before the retry still stops the watcher', async () => {
  const w = world();
  const a = w.mk(100);
  await a.watcher.loadState();
  const kv = w.selfKv;
  const put = kv.put.bind(kv);
  let overtaken = false;
  // The first attempt is applied, a second watcher then writes its own state, and the SDK's retry is refused.
  kv.put = async (key, value, options) => {
    if (key !== k.watchState || overtaken) return put(key, value, options);
    overtaken = true;
    await put(key, value, options);
    kv.rows.set(key, { text: JSON.stringify({ v: 1, pending: {}, woken: ['OTHER'] }), etag: '"other"' });
    return put(key, value, options);
  };
  w.send(ulid(w.clock.t));
  await a.watcher.sync(peer, 'poll');
  assert.equal(a.watcher.fatalError?.code, 'state-conflict');
  assert.deepEqual(kv.value(k.watchState).woken, ['OTHER'], 'the other writer\'s state is kept');
});

/** The watcher's first state write is applied; before the SDK's retry, another process rewrites it via `rewrite`. */
async function overtakenRetry(rewrite) {
  const w = world();
  const a = w.mk(100);
  await a.watcher.loadState();
  const kv = w.selfKv;
  const put = kv.put.bind(kv);
  let overtaken = false;
  kv.put = async (key, value, options) => {
    if (key !== k.watchState || overtaken) return put(key, value, options);
    overtaken = true;
    await put(key, value, options);
    const stored = kv.value(key);
    kv.rows.set(key, { text: JSON.stringify(rewrite(stored)), etag: '"other"' });
    return put(key, value, options);
  };
  w.send(ulid(w.clock.t));
  await a.watcher.sync(peer, 'poll');
  return { a, kv };
}

test('an older CLI that rewrote the applied write, keeping its writer stamp, still stops the watcher', async () => {
  // Courier 0.5.3 loads the state with `{ ...emptyWatchState(), ...stored }` and writes it back, unknown fields kept.
  const { a, kv } = await overtakenRetry((stored) => ({ ...stored, woken: [...stored.woken, 'OLD'] }));
  assert.ok(kv.value(k.watchState).writer, 'the older writer kept the stamp');
  assert.equal(a.watcher.fatalError?.code, 'state-conflict');
  assert.deepEqual(kv.value(k.watchState).woken, ['OLD']);
});

test('the same body without the writer stamp is not the watcher\'s own write', async () => {
  const { a, kv } = await overtakenRetry(({ writer: _writer, ...rest }) => rest);
  assert.equal(a.watcher.fatalError?.code, 'state-conflict');
  assert.equal(kv.value(k.watchState).writer, undefined);
});

test('a second watcher that makes the same change from the same state still stops the watcher', async () => {
  // `courier pause` while a long watcher runs, then `courier watch --once`: both see the new marker and write the
  // same state as their first write, so only the run ids in their stamps differ.
  const w = world();
  const earlier = w.mk(50);
  await earlier.watcher.loadState();
  w.send(ulid(w.clock.t));
  await earlier.watcher.sync(peer, 'poll');
  const a = w.mk(100);
  const once = w.mk(200);
  await a.watcher.loadState();
  await once.watcher.loadState();
  const thread = ulid(w.clock.t);
  w.selfKv.rows.set(k.paused('bob', thread), { text: JSON.stringify({ v: 1, peer: 'bob', threadId: thread, by: 'human' }), etag: '"p"' });
  await once.watcher.syncPaused();
  const theirs = w.selfKv.rows.get(k.watchState).text;
  await a.watcher.syncPaused();
  assert.equal(a.watcher.fatalError?.code, 'state-conflict');
  assert.equal(w.selfKv.rows.get(k.watchState).text, theirs);
});
