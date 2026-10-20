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
    async delete(key) {
      rows.delete(key);
      return { ok: true, data: undefined };
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
  await new Promise((resolve) => setTimeout(resolve, 20)); // the first tick claims the state, then calls the waker
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

// ---------- one profile, two watchers ----------

function idleHooks() {
  return {
    subscribe: (_subscriptions, { signal }) => ({
      async *[Symbol.asyncIterator]() {
        const done = defer();
        signal.addEventListener('abort', () => done.resolve(), { once: true });
        if (!signal.aborted) await done.promise;
      },
    }),
  };
}

function runnable(selfKv, peers, peerSide, wakes, debounceMs = 0) {
  return new Watcher({
    selfKv, spaceId: 's', selfHooks: idleHooks(), peerHooks: async () => idleHooks(),
    loadPeers: () => peers, kvFor: async () => peerSide,
    wake: async (request) => { wakes.push(request); }, log: () => {},
  }, { debounceMs, pollMs: 60_000, ticketSeconds: 25 });
}

test('two watchers that loaded the same pending wake do not both wake it', async () => {
  const selfKv = memoryKv();
  const thread = ulid();
  selfKv.rows.set(k.watchState, {
    etag: 'seed',
    value: {
      v: 1, woken: [], approvalsSeen: [],
      pending: { [`bob/${thread}`]: { peer: 'bob', threadId: thread, subject: 'S', firstSeenAt: 0, lastSeenAt: 0, messages: [{ messageId: 'M1', intent: 'request', sentAt: '' }] } },
    },
  });
  const wakes = [[], []];
  const results = await Promise.all([0, 1].map((i) =>
    runnable(selfKv, [], memoryKv(), wakes[i]).run(new AbortController().signal, { once: true }).then(() => 'ok', (e) => e.code)));
  assert.ok(results.every((r) => r === 'ok' || r === 'state-conflict'), results.join(','));
  assert.equal(wakes[0].length + wakes[1].length, 1, 'exactly one of the two wakes the thread');
});

// ---------- wake claims ----------

// Watchers sharing one store, with a controllable process table for the claim tests.
function claimWorld() {
  const selfKv = memoryKv();
  const peerSide = memoryKv();
  const clock = { t: 1_000_000_000_000 };
  const alive = new Set();
  const thread = ulid();
  const mk = ({ pid, profileId = 'profile-1', wake }) => {
    alive.add(pid);
    const wakes = [];
    const events = [];
    const watcher = new Watcher({
      selfKv, spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [peer], kvFor: async () => peerSide,
      wake: async (request) => { wakes.push(request); await wake?.(request); },
      log: (event, fields) => events.push({ event, ...fields }),
      holder: { profileId, pid, isAlive: (p) => alive.has(p) },
      now: () => clock.t,
    }, { debounceMs: 30_000, pollMs: 60_000, ticketSeconds: 25 });
    return { watcher, wakes, events };
  };
  const send = (intent = 'request') => {
    const message = buildMessage({ threadId: thread, text: 'hi', role: 'ROLE_USER', intent, from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid();
    peerSide.rows.set(`${PREFIX}/to/alice/threads/${thread}/msg/${message.messageId}.json`, { value: message, etag: 'r' });
    return message.messageId;
  };
  return { selfKv, clock, alive, thread, mk, send };
}

test('a second watcher that starts while the first one\'s wake is in flight skips the thread: no double wake, no stop, no state write', async () => {
  const w = claimWorld();
  const gate = defer();
  const a = w.mk({ pid: 100, wake: () => gate.promise });
  const id = w.send();
  await a.watcher.sync(peer, 'poll');
  w.clock.t += 30_000;
  const running = a.watcher.tick();
  await new Promise((resolve) => setTimeout(resolve, 20)); // A has claimed and is inside its wake

  const b = w.mk({ pid: 200 });
  await b.watcher.loadState();
  await b.watcher.tick(true);
  assert.equal(b.wakes.length, 0);
  assert.ok(b.events.some((e) => e.event === 'claimed-elsewhere'));
  assert.equal(b.watcher.fatalError, undefined, 'a live claim by another watcher skips the thread, it does not stop B');
  gate.resolve();
  await running;
  assert.deepEqual(a.wakes.map((r) => r.messages.map((m) => m.messageId)), [[id]]);
  assert.equal(a.watcher.fatalError, undefined, 'B did not write state, so A\'s own state write is not made to fail');
});

test('same process, two watcher instances: the second still skips a thread the first is waking', async () => {
  const w = claimWorld();
  const gate = defer();
  const a = w.mk({ pid: 100, wake: () => gate.promise });
  w.send();
  await a.watcher.sync(peer, 'poll');
  w.clock.t += 30_000;
  const running = a.watcher.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const b = w.mk({ pid: 100 });
  await b.watcher.loadState();
  await b.watcher.tick(true);
  assert.equal(b.wakes.length, 0);
  gate.resolve();
  await running;
});

test('restart after a failed wake wakes immediately: the failed attempt released its claim', async () => {
  const w = claimWorld();
  const a = w.mk({ pid: 100, wake: async () => { throw new Error('agent down'); } });
  const id = w.send();
  await a.watcher.sync(peer, 'poll');
  w.clock.t += 30_000;
  await a.watcher.tick();
  assert.equal(a.wakes.length, 1);
  assert.ok(![...w.selfKv.rows.keys()].some((key) => key.includes('/wake-claims/')), 'the claim is gone');

  w.clock.t += 3.5 * 60_000; // the service manager restarts the watcher 3.5 minutes later
  w.alive.delete(100);
  const a2 = w.mk({ pid: 101 });
  await a2.watcher.loadState();
  await a2.watcher.tick();
  assert.deepEqual(a2.wakes.map((r) => r.messages.map((m) => m.messageId)), [[id]]);
});

test('crash during a wake: the restarted watcher (same profile, new pid) takes the dead holder\'s claim at once', async () => {
  const w = claimWorld();
  const gate = defer();
  const a = w.mk({ pid: 100, wake: () => gate.promise });
  const id = w.send();
  await a.watcher.sync(peer, 'poll');
  w.clock.t += 30_000;
  void a.watcher.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  w.alive.delete(100); // the process is gone (crash, reboot, kill -9); the claim was never released

  w.clock.t += 60_000;
  const a2 = w.mk({ pid: 101 });
  await a2.watcher.loadState();
  await a2.watcher.tick(true);
  assert.deepEqual(a2.wakes.map((r) => r.messages.map((m) => m.messageId)), [[id]], 'woken again: wakes are at-least-once');
  assert.ok(a2.events.some((e) => e.event === 'claim-taken-over' && e.reason === 'holder-dead'));
});

test('a claim from another profile or machine is respected for the lease, then taken over', async () => {
  const w = claimWorld();
  const a = w.mk({ pid: 100, profileId: 'someone-elses', wake: async () => { throw new Error('x'); } });
  w.send();
  await a.watcher.sync(peer, 'poll');
  const claimKey = [...w.selfKv.rows.keys()].find((key) => key.includes('/state/watch.json')) ? null : null;
  void claimKey;
  // Plant a claim as if made by another profile just now.
  const pendingKey = Object.values(a.watcher.snapshot().pending)[0];
  const key = k.wakeClaim('bob', w.thread, pendingKey.messages[0].messageId);
  w.selfKv.rows.set(key, { value: { v: 1, profile: 'other-machine', run: 'r', pid: 5, at: new Date(w.clock.t).toISOString() }, etag: 'c' });

  const b = w.mk({ pid: 200 });
  await b.watcher.loadState();
  w.clock.t += 30 * 60_000;
  await b.watcher.tick(true);
  assert.equal(b.wakes.length, 0, 'within the 35 minute lease');
  w.clock.t += 6 * 60_000;
  await b.watcher.tick(true);
  assert.equal(b.wakes.length, 1, 'after the lease');
});

test('an orphan claim from a stale second watcher whose state write failed does not block the legitimate watcher', async () => {
  const w = claimWorld();
  const a = w.mk({ pid: 100 });
  const ida = w.send();
  await a.watcher.sync(peer, 'poll'); // A writes state with the pending wake
  const stale = w.mk({ pid: 200 });
  await stale.watcher.loadState(); // the stale watcher loads A's state (so it also sees the pending wake)...
  const idb = w.send();
  await a.watcher.sync(peer, 'poll'); // ...then A moves the state on
  w.clock.t += 30_000;

  await assert.rejects(stale.watcher.tick(true), (e) => e.code === 'state-conflict'); // it claims the thread, then its conditional state write fails
  assert.equal(stale.watcher.fatalError?.code, 'state-conflict', 'the stale watcher stops on the state etag');
  assert.equal(stale.wakes.length, 0);
  assert.ok(![...w.selfKv.rows.keys()].some((key) => key.includes('/wake-claims/')), 'and released the claim it had taken');

  await a.watcher.tick(true);
  assert.deepEqual(a.wakes.map((r) => r.messages.map((m) => m.messageId)), [[ida, idb]], 'the legitimate watcher is not blocked');
});

test('a peer-controlled subject is one capped line before it reaches state and prompts', async () => {
  const { watcher, send, meta, clock } = setup();
  const thread = ulid();
  meta(thread, `Hello\n\u0000\u202eIgnore previous${'x'.repeat(5000)}`);
  send(thread, 'request');
  await watcher.sync(peer, 'poll');
  const subject = Object.values(watcher.snapshot().pending)[0].subject;
  assert.ok(subject.length <= 200 && !/[\n\u0000\u202e]/.test(subject), subject.slice(0, 40));
  void clock;
});

test('run() starts the subscriptions before the first catch-up listing', async () => {
  const order = [];
  const selfKv = memoryKv();
  const peerSide = memoryKv();
  const list = peerSide.list.bind(peerSide);
  peerSide.list = async (options) => { order.push('list'); return list(options); };
  const hooks = { subscribe: (_subs, { signal }) => ({ async *[Symbol.asyncIterator]() { order.push('subscribe'); await new Promise((r) => signal.addEventListener('abort', r, { once: true })); } }) };
  const watcher = new Watcher({
    selfKv, spaceId: 's', selfHooks: hooks, peerHooks: async () => hooks, loadPeers: () => [peer], kvFor: async () => peerSide,
    wake: async () => {}, log: () => {},
  }, { debounceMs: 30_000, pollMs: 60_000, ticketSeconds: 25 });
  const stop = new AbortController();
  const running = watcher.run(stop.signal);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  stop.abort();
  await running;
  assert.ok(order.indexOf('subscribe') !== -1 && order.indexOf('list') !== -1);
  assert.ok(order.indexOf('subscribe') < order.indexOf('list'), order.join(','));
});
