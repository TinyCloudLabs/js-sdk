// TC-2917: two Courier agents of one owner share the space, never one watcher state; the shared pre-TC-2917 state is
// copied once per agent; a second watcher of the same agent stands by instead of exiting into a restart loop.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX, stateKeys } from '../dist/keys.js';

const JULIE = 'did:key:z6MkJuLie';
const ORCHARD = 'did:key:z6MkorcHard';
const START = Date.parse('2026-11-13T12:00:00.000Z');

function memoryKv() {
  const rows = new Map();
  let sequence = 0;
  const kv = {
    rows,
    lists: [],
    async list({ prefix }) {
      kv.lists.push(prefix);
      return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async get(key) {
      const row = rows.get(key);
      return row ? { ok: true, data: { data: row.value, headers: { etag: row.etag } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async put(key, value, options = {}) {
      const prior = rows.get(key);
      if (options.ifNoneMatch === '*' && prior) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      if (options.ifMatch && options.ifMatch !== prior?.etag) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      const etag = `e${++sequence}`;
      rows.set(key, { value: structuredClone(value), etag });
      return { ok: true, data: { data: undefined, headers: { etag } } };
    },
    async delete(key) { rows.delete(key); return { ok: true, data: undefined }; },
  };
  return kv;
}

const peerRecord = (handle) => ({
  handle, ownerDid: 'did:pkh:eip155:1:0x02', courierDid: `did:key:z${handle}`, spaceId: `space-${handle}`, theirHandleForMe: 'me',
  inbound: { delegation: 'wire', cid: `cid-${handle}`, expiresAt: new Date(START + 30 * 86_400_000).toISOString() },
  outbound: [], status: 'paired', pairedAt: new Date(START).toISOString(),
});

function say(kv, threadId, intent = 'request') {
  const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent, from: { owner: 'o', agent: 'a' } });
  message.messageId = ulid();
  kv.rows.set(`${PREFIX}/to/me/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'm' });
  return message.messageId;
}

function agent({ did, selfKv, peer, peerKv, hooks = {}, budget = 12 }) {
  const events = [];
  const wakes = [];
  const watcher = new Watcher({
    selfKv, agent: did, spaceId: 'space-owner', selfHooks: hooks, peerHooks: async () => hooks,
    loadPeers: () => [peer], kvFor: async () => peerKv,
    wake: async (request) => { wakes.push(request); },
    log: (event, fields) => events.push({ event, at: Date.now(), ...fields }),
    now: () => Date.now(),
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: budget });
  return { watcher, events, wakes };
}

test('two agents of one owner run at once on one space: no state conflict, no shared pending wake or pause', async () => {
  const selfKv = memoryKv();
  const bobKv = memoryKv();
  const carolKv = memoryKv();
  const julie = agent({ did: JULIE, selfKv, peer: peerRecord('bob'), peerKv: bobKv, budget: 1 });
  const orchard = agent({ did: ORCHARD, selfKv, peer: peerRecord('carol'), peerKv: carolKv });
  await Promise.all([julie.watcher.loadState(), orchard.watcher.loadState()]);
  const bobThread = ulid();
  const carolThread = ulid();
  for (let round = 0; round < 3; round++) {
    say(bobKv, bobThread, 'update');
    say(carolKv, carolThread, 'update');
    await Promise.all([julie.watcher.pollOnce('poll'), orchard.watcher.pollOnce('poll')]);
    await Promise.all([julie.watcher.tick(), orchard.watcher.tick()]);
  }
  for (const side of [julie, orchard]) {
    assert.equal(side.events.filter((e) => e.code === 'state-conflict').length, 0, JSON.stringify(side.events.filter((e) => e.event === 'sync-error')));
  }
  assert.equal(julie.wakes.length, 1, 'julie woke for bob once, then her budget of 1 paused the thread');
  assert.equal(orchard.wakes.length, 3, "orchard's wakes are its own");
  assert.ok(selfKv.rows.has(stateKeys(JULIE).paused('bob', bobThread)), "julie's pause marker is hers");
  assert.equal(selfKv.rows.has(k.paused('bob', bobThread)), false, 'nothing written to the shared keys');
  assert.deepEqual(orchard.watcher.snapshot().paused, [], "orchard does not see julie's pause");
  assert.notEqual(stateKeys(JULIE).watch, stateKeys(ORCHARD).watch);
  assert.ok(selfKv.rows.has(stateKeys(JULIE).watch) && selfKv.rows.has(stateKeys(ORCHARD).watch));
  assert.equal(selfKv.rows.has(k.watchState), false);
});

test('the shared pre-TC-2917 state is copied once per agent, filtered to its own peers, and never copied again', async () => {
  const selfKv = memoryKv();
  const pending = (peer, thread) => ({ peer, threadId: thread, subject: 'S', firstSeenAt: 0, lastSeenAt: 0, messages: [{ messageId: ulid(), intent: 'request', sentAt: '' }] });
  selfKv.rows.set(k.watchState, { etag: 'legacy', value: {
    v: 1, woken: ['W1'], approvalsSeen: ['A1'], wakes: {}, paused: ['bob/T1', 'carol/T2'], wakeRetries: {}, approvalRetries: {}, outbox: [], held: {},
    threadNotices: {}, peerNotices: {}, noticeGlobalLog: [], noticeLog: {},
    pending: { 'bob/T3': pending('bob', 'T3'), 'carol/T4': pending('carol', 'T4') },
  } });
  selfKv.rows.set(k.paused('bob', 'T1'), { etag: 'p1', value: { v: 1, peer: 'bob', threadId: 'T1', by: 'human', at: 'x', reason: 'r' } });
  selfKv.rows.set(k.paused('carol', 'T2'), { etag: 'p2', value: { v: 1, peer: 'carol', threadId: 'T2', by: 'human', at: 'x', reason: 'r' } });
  const legacyRows = JSON.stringify([...selfKv.rows.entries()]);
  const julie = agent({ did: JULIE, selfKv, peer: peerRecord('bob'), peerKv: memoryKv() });
  await julie.watcher.run(new AbortController().signal, { once: true });
  assert.equal(julie.wakes.length, 1, 'her pending wake for bob survived the move');
  assert.equal(julie.wakes[0].peer, 'bob');
  const mine = selfKv.rows.get(stateKeys(JULIE).watch).value;
  assert.deepEqual(mine.paused, ['bob/T1']);
  assert.ok(mine.woken.includes('W1'), 'which messages already woke is kept');
  assert.deepEqual(mine.approvalsSeen, ['A1']);
  assert.ok(selfKv.rows.has(stateKeys(JULIE).paused('bob', 'T1')));
  assert.equal(selfKv.rows.has(stateKeys(JULIE).paused('carol', 'T2')), false, "carol's pause is not julie's");
  for (const [key, row] of JSON.parse(legacyRows)) assert.deepEqual(selfKv.rows.get(key)?.value, row.value, `shared key ${key} left in place`);
  assert.equal(julie.events.filter((e) => e.event === 'state-migrated').length, 1);

  // A human resume after the move deletes her marker; the next start must not bring the shared copy back.
  selfKv.rows.delete(stateKeys(JULIE).paused('bob', 'T1'));
  const again = agent({ did: JULIE, selfKv, peer: peerRecord('bob'), peerKv: memoryKv() });
  await again.watcher.run(new AbortController().signal, { once: true });
  assert.equal(selfKv.rows.has(stateKeys(JULIE).paused('bob', 'T1')), false);
  assert.equal(again.events.filter((e) => e.event === 'state-migrated').length, 0);
  assert.deepEqual(again.watcher.snapshot().paused, []);

  const orchard = agent({ did: ORCHARD, selfKv, peer: peerRecord('carol'), peerKv: memoryKv() });
  await orchard.watcher.run(new AbortController().signal, { once: true });
  assert.deepEqual(orchard.wakes.map((w) => w.peer), ['carol']);
  assert.deepEqual(selfKv.rows.get(stateKeys(ORCHARD).watch).value.paused, ['carol/T2']);
});

function idleHooks() {
  return {
    subscribe: (_subs, { signal }) => ({
      async *[Symbol.asyncIterator]() { if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); },
    }),
  };
}

async function flush() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) { mock.timers.tick(1000); await flush(); }
}

test('a second watcher of the same agent stands by: no exit, no restart loop, at most one catch-up per window', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const selfKv = memoryKv();
  const bobKv = memoryKv();
  const b = agent({ did: JULIE, selfKv, peer: peerRecord('bob'), peerKv: bobKv, hooks: idleHooks() });
  const stop = new AbortController();
  let settled = false;
  const running = b.watcher.run(stop.signal).finally(() => { settled = true; });
  try {
    await flush();
    await advance(3000);
    const other = async () => { // the other process of the same agent writes watch.json
      const row = selfKv.rows.get(stateKeys(JULIE).watch);
      await selfKv.put(stateKeys(JULIE).watch, { ...row.value, other: Date.now() }, { ifMatch: row.etag });
    };
    await other();
    say(bobKv, ulid());
    await advance(300_000); // b's next full catch-up delivers it; its state write conflicts
    assert.equal(b.events.filter((e) => e.event === 'standby').length, 1);
    assert.match(b.events.find((e) => e.event === 'standby').message, /Another `watch` is writing/);
    const catchUps = () => bobKv.lists.length;
    const before = catchUps();
    for (let minute = 0; minute < 40; minute += 4) { await other(); await advance(240_000); } // the other stays active 40 min
    assert.equal(settled, false, 'the watcher is still running: systemd has nothing to restart');
    assert.equal(catchUps(), before, 'no catch-up while the other writer is active');
    assert.equal(b.events.filter((e) => e.event === 'start').length, 1);
    await advance(60 * 60_000); // the other goes quiet
    assert.equal(b.events.filter((e) => e.event === 'standby-over').length, 1, 'it took over after one quiet window');
    assert.equal(b.events.filter((e) => e.event === 'start').length, 2);
    const sent = say(bobKv, ulid());
    await advance(300_000);
    assert.ok(b.events.some((e) => e.event === 'delivered' && e.messageId === sent), 'and watches again');
  } finally {
    stop.abort();
    await flush();
    await running;
    mock.timers.reset();
  }
});
