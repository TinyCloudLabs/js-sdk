// TC-2802: one watcher stopped with state-conflict while `read`/`inbox` ran beside it. The only writer of
// me/state/watch.json is the watcher itself; a state write whose reply is lost after the node applied it left the
// watcher holding the old etag, so its next write was refused and reported as "a second watch".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { collectInbound, commitReceipts } from '../dist/inbox.js';
import { k, PREFIX } from '../dist/keys.js';

/**
 * The node's KV as Courier sees it: bodies stored as JSON text, a content-hash etag (the node's is BLAKE3 of the
 * bytes), if-match/if-none-match answered 412. `fault(key)` can make one put of a key apply and then lose its reply
 * ('lost-reply'), or fail before reaching the node ('unsent').
 */
function nodeKv() {
  const rows = new Map();
  const faults = [];
  const etagOf = (text) => `"sha256-${createHash('sha256').update(text).digest('hex')}"`;
  return {
    rows,
    fault(key, kind) { faults.push({ key, kind }); },
    value(key) { return rows.has(key) ? JSON.parse(rows.get(key).text) : undefined; },
    async list({ prefix }) {
      return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async get(key) {
      const row = rows.get(key);
      return row
        ? { ok: true, data: { data: row.text, headers: { etag: row.etag } } }
        : { ok: false, error: { code: 'KV_NOT_FOUND', message: `Key not found: ${key}`, service: 'kv' } };
    },
    async put(key, value, options = {}) {
      const at = faults.findIndex((f) => f.key === key);
      const fault = at >= 0 ? faults.splice(at, 1)[0].kind : undefined;
      const lost = { ok: false, error: { code: 'NODE_NOT_RESPONDING', message: 'The place your data is stored isn\'t responding right now.', service: 'kv' } };
      if (fault === 'unsent') return lost;
      const prior = rows.get(key);
      if ((options.ifNoneMatch === '*' && prior) || (options.ifMatch && options.ifMatch !== prior?.etag)) {
        return { ok: false, error: { code: 'KV_PRECONDITION_FAILED', message: `KV precondition failed for key ${JSON.stringify(key)}`, service: 'kv', meta: { status: 412 } } };
      }
      const text = JSON.stringify(value);
      const etag = etagOf(text);
      rows.set(key, { text, etag });
      if (fault === 'lost-reply') return lost;
      return { ok: true, data: { data: undefined, headers: { etag } } };
    },
    async delete(key) {
      rows.delete(key);
      return { ok: true, data: undefined };
    },
  };
}

/** A second handle on the same space that records every write: what `courier read` and `courier inbox` do. */
function recording(kv) {
  const writes = [];
  return {
    writes,
    kv: {
      list: (...args) => kv.list(...args),
      get: (...args) => kv.get(...args),
      put: (key, ...rest) => { writes.push(key); return kv.put(key, ...rest); },
      delete: (key, ...rest) => { writes.push(key); return kv.delete(key, ...rest); },
    },
  };
}

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
  const send = (thread, intent = 'request') => {
    const message = buildMessage({ threadId: thread, text: 'hi', role: 'ROLE_USER', intent, from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid(clock.t);
    peerSide.rows.set(`${PREFIX}/to/alice/threads/${thread}/msg/${message.messageId}.json`, { text: JSON.stringify(message), etag: `"m-${message.messageId}"` });
    return message.messageId;
  };
  return { selfKv, peerSide, clock, mk, send };
}

const woken = (wakes) => wakes.flatMap((w) => w.messages.map((m) => m.messageId));

test('state writes whose replies are lost after they were applied do not stop the watcher, lose receipts or wake twice, with read and inbox running beside it', async () => {
  const w = world();
  const { watcher, wakes, events } = w.mk();
  await watcher.loadState();
  const reader = recording(w.selfKv);
  const thread = ulid(w.clock.t);
  const sent = [];
  for (let cycle = 0; cycle < 30; cycle++) {
    w.clock.t += 61_000;
    sent.push(w.send(thread));
    // Every third cycle the delivery's state write is applied but its reply is lost; every fifth, the wake's.
    if (cycle % 3 === 0) w.selfKv.fault(k.watchState, 'lost-reply');
    await Promise.all([
      watcher.sync(peer, cycle % 2 ? 'hook' : 'poll'),
      // `courier inbox --peek` and `courier read` beside the watcher: they only read.
      collectInbound({ selfKv: reader.kv, peers: [peer], kvFor: async () => w.peerSide }),
      reader.kv.list({ prefix: `${k.threadRoot('bob', thread)}/` }),
    ]);
    // A plain `courier inbox` advances receipts with its own CAS, never the watcher's state.
    if (cycle % 4 === 0) await commitReceipts(reader.kv, (await collectInbound({ selfKv: reader.kv, peers: [peer], kvFor: async () => w.peerSide })).pending);
    if (cycle % 5 === 0) w.selfKv.fault(k.watchState, 'lost-reply');
    await watcher.tick().catch(() => {});
    await watcher.sync(peer, 'poll'); // the next poll redelivers anything whose receipt did not land
    await watcher.tick().catch(() => {});
  }
  assert.equal(watcher.fatalError, undefined, `no state-conflict: ${JSON.stringify(events.filter((e) => e.code === 'state-conflict'))}`);
  assert.deepEqual([...woken(wakes)].sort(), [...sent].sort(), 'every message woken');
  assert.equal(new Set(woken(wakes)).size, woken(wakes).length, 'no message woken twice');
  assert.deepEqual(w.selfKv.value(k.receipts('bob')).threads[thread].delivered, [...sent].sort(), 'every receipt kept');
  assert.deepEqual(w.selfKv.value(k.watchState).pending, {}, 'nothing left pending');
  assert.ok(!reader.writes.includes(k.watchState), 'read and inbox never write the watcher state');
  assert.ok(events.filter((e) => e.event === 'sync-error' && e.code === 'NODE_NOT_RESPONDING').length >= 10, 'the lost replies did happen');
});

test('a state write that never reached the node is written again by the next one', async () => {
  const w = world();
  const { watcher, wakes } = w.mk();
  await watcher.loadState();
  const thread = ulid(w.clock.t);
  const id = w.send(thread);
  w.selfKv.fault(k.watchState, 'unsent');
  await watcher.sync(peer, 'poll');
  assert.equal(w.selfKv.value(k.watchState), undefined, 'not applied');
  await watcher.sync(peer, 'poll');
  assert.deepEqual(w.selfKv.value(k.watchState).pending[`bob/${thread}`].messages.map((m) => m.messageId), [id]);
  await watcher.tick();
  assert.deepEqual(woken(wakes), [id]);
  assert.equal(watcher.fatalError, undefined);
});

test('another writer after a lost reply still stops the watcher, and its state is kept', async () => {
  const w = world();
  const a = w.mk(100);
  await a.watcher.loadState();
  const thread = ulid(w.clock.t);
  w.send(thread);
  w.selfKv.fault(k.watchState, 'lost-reply');
  await a.watcher.sync(peer, 'poll'); // applied; A never learns it
  // A second watcher on the same profile (e.g. `courier watch --once`) loads that state and writes its own.
  const b = w.mk(200);
  await b.watcher.loadState();
  const other = ulid(w.clock.t);
  w.send(other);
  await b.watcher.sync(peer, 'poll');
  const theirs = w.selfKv.rows.get(k.watchState).text;
  assert.ok(theirs.includes(other));

  w.send(ulid(w.clock.t));
  await a.watcher.sync(peer, 'poll');
  assert.equal(a.watcher.fatalError?.code, 'state-conflict');
  assert.equal(w.selfKv.rows.get(k.watchState).text, theirs, 'the other writer\'s state is not overwritten');
});

test('a competing write is reported at the watcher\'s next own state write, which a timer can make an hour or a day later', async () => {
  const w = world();
  const a = w.mk(100);
  await a.watcher.loadState();
  const thread = ulid(w.clock.t);
  w.send(thread);
  await a.watcher.sync(peer, 'poll');
  await a.watcher.tick(); // woken: the day's wake count is now in A's state

  // A `courier watch --once` on the same profile runs to completion and exits.
  w.clock.t += 60_000;
  const once = w.mk(200);
  w.send(ulid(w.clock.t));
  await once.watcher.run(new AbortController().signal, { once: true });
  const theirs = w.selfKv.rows.get(k.watchState).text;

  // Quiet hours: A keeps polling and nothing it holds changes, so it writes nothing and notices nothing.
  for (let poll = 0; poll < 60; poll++) {
    w.clock.t += 60_000;
    await a.watcher.pollOnce('poll');
  }
  assert.equal(a.watcher.fatalError, undefined, 'no write, no conflict yet');
  // The next UTC day A prunes yesterday's wake count: its first write since the other run, refused.
  w.clock.t = Date.parse('2026-11-11T00:00:30Z');
  await a.watcher.pollOnce('poll').catch(() => {});
  assert.equal(a.watcher.fatalError?.code, 'state-conflict');
  assert.equal(w.selfKv.rows.get(k.watchState).text, theirs);
});
