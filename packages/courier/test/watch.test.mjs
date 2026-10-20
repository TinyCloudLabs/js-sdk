import { test } from 'node:test';
import { defer } from '../dist/defer.js';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher, wakeDueAt } from '../dist/watch.js';
import { buildMessage, buildTask } from '../dist/a2a.js';
import { k, PREFIX } from '../dist/keys.js';

function memoryKv() {
  const rows = new Map();
  let sequence = 0;
  return {
    rows,
    async list({ prefix }) {
      return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async get(key) {
      const row = rows.get(key);
      return row
        ? { ok: true, data: { data: row.value, headers: { etag: row.etag } } }
        : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async put(key, value, options = {}) {
      const prior = rows.get(key);
      if (options.ifNoneMatch === '*' && prior) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      if (options.ifMatch && options.ifMatch !== prior?.etag) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      const etag = `e${++sequence}`;
      rows.set(key, { value: structuredClone(value), etag });
      return { ok: true, data: { data: undefined, headers: { etag } } };
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

function setup({ wake, selfKv = memoryKv() } = {}) {
  const peerSide = memoryKv();
  const clock = { t: 1_000_000 };
  const wakes = [];
  const events = [];
  const watcher = new Watcher({
    selfKv,
    spaceId: 'tinycloud:pkh:eip155:1:0x01:agents',
    selfHooks: {}, peerHooks: async () => ({}),
    loadPeers: () => [peer],
    kvFor: async () => peerSide,
    wake: wake ?? (async (request) => { wakes.push(request); }),
    log: (event, fields) => events.push({ event, ...fields }),
    now: () => clock.t,
  }, { debounceMs: 30_000, pollMs: 60_000, ticketSeconds: 25 });
  const send = (threadId, intent, text = 'hi') => {
    const message = buildMessage({
      threadId, text, role: 'ROLE_USER', intent,
      from: { owner: 'did:pkh:bob', agent: 'did:key:zBob', label: 'Bob' },
    });
    message.messageId = ulid();
    peerSide.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'r' });
    return message.messageId;
  };
  const meta = (threadId, subject) => {
    peerSide.rows.set(`${PREFIX}/to/alice/threads/${threadId}/meta.json`, { value: { threadId, subject }, etag: 'm' });
  };
  return { selfKv, peerSide, clock, wakes, events, watcher, send, meta };
}

test('messages in one thread inside the debounce window produce one wake with every message', async () => {
  const { watcher, clock, wakes, send, meta } = setup();
  const thread = ulid();
  meta(thread, 'Handoff');
  const first = send(thread, 'request');
  await watcher.sync(peer, 'hook');
  clock.t += 20_000;
  const second = send(thread, 'ask');
  await watcher.sync(peer, 'hook');

  clock.t += 29_000; // 49 s after the first message, 29 s after the second: not yet
  await watcher.tick();
  assert.equal(wakes.length, 0);
  clock.t += 2_000; // 31 s after the second
  await watcher.tick();
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].messages.map((m) => m.messageId), [first, second]);
  assert.equal(wakes[0].subject, 'Handoff');

  // A later poll must not wake for messages already woken.
  await watcher.sync(peer, 'poll');
  clock.t += 120_000;
  await watcher.tick();
  assert.equal(wakes.length, 1);
});

test('a steady stream cannot postpone the wake past twice the debounce', () => {
  const pending = { firstSeenAt: 0, lastSeenAt: 55_000 };
  assert.equal(wakeDueAt(pending, 30_000), 60_000);
});

test('inform is mirrored and receipted but never wakes', async () => {
  const { watcher, clock, wakes, send, selfKv } = setup();
  const thread = ulid();
  const id = send(thread, 'inform');
  await watcher.sync(peer, 'poll');
  clock.t += 300_000;
  await watcher.tick();
  assert.equal(wakes.length, 0);
  assert.ok(selfKv.rows.has(k.mirrorMsg('bob', thread, id)));
  assert.deepEqual(selfKv.rows.get(k.receipts('bob')).value.threads[thread].delivered, [id]);
});

test('peer tasks are mirrored and refreshed until terminal', async () => {
  const { watcher, peerSide, selfKv, meta } = setup();
  const thread = ulid();
  meta(thread, 'T');
  const taskKey = `${PREFIX}/to/alice/threads/${thread}/task/T1.json`;
  const put = (state) => peerSide.rows.set(taskKey, {
    value: buildTask({ threadId: thread, taskId: 'T1', state }), etag: `t-${state}`,
  });
  put('TASK_STATE_WORKING');
  await watcher.sync(peer, 'poll');
  const mirrored = k.mirrorTask('bob', thread, 'T1');
  assert.equal(selfKv.rows.get(mirrored).value.status.state, 'TASK_STATE_WORKING');
  assert.ok(selfKv.rows.has(k.mirrorMeta('bob', thread)));

  put('TASK_STATE_COMPLETED');
  await watcher.sync(peer, 'poll');
  assert.equal(selfKv.rows.get(mirrored).value.status.state, 'TASK_STATE_COMPLETED');

  // Terminal tasks are final: a later (impossible) change is not re-read.
  put('TASK_STATE_WORKING');
  await watcher.sync(peer, 'poll');
  assert.equal(selfKv.rows.get(mirrored).value.status.state, 'TASK_STATE_COMPLETED');
});

test('a wake that fails stays pending and is retried', async () => {
  const { selfKv, peerSide, clock, events, send } = setup();
  let fail = true;
  const calls = [];
  const watcher = new Watcher({
    selfKv, spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [peer], kvFor: async () => peerSide,
    wake: async (request) => { calls.push(request); if (fail) throw new Error('paseo down'); },
    log: (event, fields) => events.push({ event, ...fields }),
    now: () => clock.t,
  }, { debounceMs: 1000, pollMs: 60_000, ticketSeconds: 25 });
  const thread = ulid();
  send(thread, 'request');
  await watcher.sync(peer, 'poll');
  clock.t += 1000;
  await watcher.tick();
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(watcher.snapshot().pending).length, 1);
  fail = false;
  clock.t += 30_000; // still inside the retry hold-off
  await watcher.tick();
  assert.equal(calls.length, 1);
  clock.t += 31_000;
  await watcher.tick();
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(watcher.snapshot().pending).length, 0);
});

test('overlapping ticks do not wake a thread again while a slow wake is still running', async () => {
  const gate = defer();
  const calls = [];
  const { watcher, clock, send } = setup({ wake: async (request) => { calls.push(request); await gate.promise; } });
  const thread = ulid();
  send(thread, 'request');
  await watcher.sync(peer, 'poll');
  clock.t += 30_000;
  const first = watcher.tick();
  await watcher.tick(); // the 1 s interval fires again mid-wake
  await watcher.tick();
  assert.equal(calls.length, 1);
  gate.resolve();
  await first;
  clock.t += 120_000;
  await watcher.tick();
  assert.equal(calls.length, 1, 'the woken message is not woken again');
});

test('a message that lands during a wake is woken next, and only the woken snapshot is cleared', async () => {
  const gate = defer();
  const calls = [];
  const { watcher, clock, send } = setup({ wake: async (request) => { calls.push(request.messages.map((m) => m.messageId)); await gate.promise; } });
  const thread = ulid();
  const first = send(thread, 'request');
  await watcher.sync(peer, 'poll');
  clock.t += 30_000;
  const running = watcher.tick();
  const second = send(thread, 'ask');
  await watcher.sync(peer, 'hook');
  gate.resolve();
  await running;
  assert.deepEqual(calls, [[first]]);
  clock.t += 30_000;
  await watcher.tick();
  assert.deepEqual(calls, [[first], [second]]);
});

test('a peer task that cannot be mirrored never blocks receipts or wakes', async () => {
  const base = memoryKv();
  const selfKv = Object.assign(Object.create(base), {
    rows: base.rows,
    put: (key, value, options) => key.includes('/task/')
      ? Promise.resolve({ ok: false, error: { status: 503, message: 'mirror down' } })
      : base.put(key, value, options),
  });
  const { watcher, clock, wakes, send, meta, peerSide, events } = setup({ selfKv });
  const thread = ulid();
  meta(thread, 'Handoff');
  peerSide.rows.set(`${PREFIX}/to/alice/threads/${thread}/task/T1.json`, {
    value: buildTask({ threadId: thread, taskId: 'T1', state: 'TASK_STATE_WORKING' }), etag: 't',
  });
  const id = send(thread, 'request');
  await watcher.sync(peer, 'poll');
  assert.ok(events.some((e) => e.event === 'mirror-error'));
  assert.deepEqual(base.rows.get(k.receipts('bob')).value.threads[thread].delivered, [id]);
  clock.t += 30_000;
  await watcher.tick();
  assert.equal(wakes.length, 1);
});

test('a message whose mirror write fails is retried, not receipted, and does not hold back the others', async () => {
  const base = memoryKv();
  let failFor;
  const selfKv = Object.assign(Object.create(base), {
    rows: base.rows,
    put: (key, value, options) => failFor && key.includes(failFor)
      ? Promise.resolve({ ok: false, error: { status: 503, message: 'mirror down' } })
      : base.put(key, value, options),
  });
  const { watcher, clock, wakes, send } = setup({ selfKv });
  const thread = ulid();
  const bad = send(thread, 'request');
  failFor = `/msg/${bad}.json`;
  const other = send(ulid(), 'request');
  await watcher.sync(peer, 'poll');
  const receipts = Object.values(base.rows.get(k.receipts('bob')).value.threads).flatMap((t) => t.delivered);
  assert.deepEqual(receipts, [other]);
  failFor = undefined;
  await watcher.sync(peer, 'poll');
  clock.t += 30_000;
  await watcher.tick();
  assert.deepEqual(wakes.flatMap((w) => w.messages.map((m) => m.messageId)).sort(), [bad, other].sort());
});

test('a second watcher on the same profile fails with state-conflict instead of overwriting pending wakes', async () => {
  const selfKv = memoryKv();
  const a = setup({ selfKv });
  const b = setup({ selfKv });
  await a.watcher.loadState();
  await b.watcher.loadState();
  const thread = ulid();
  a.send(thread, 'request');
  await a.watcher.sync(peer, 'poll');
  b.send(ulid(), 'request');
  await b.watcher.sync(peer, 'poll');
  assert.ok(b.events.some((e) => e.event === 'sync-error' && e.code === 'state-conflict'));
  assert.deepEqual(Object.keys(selfKv.rows.get(k.watchState).value.pending), [`bob/${thread}`]);
});
