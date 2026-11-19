import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { CourierError } from '../dist/errors.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX } from '../dist/keys.js';
import { memoryKv } from './memory-kv.mjs';

const START = Date.parse('2026-11-19T12:00:00.000Z');
const POLL_MS = 60_000;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function world() {
  const selfKv = memoryKv();
  const peerKv = memoryKv();
  const events = [];
  const peer = {
    handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zBob',
    spaceId: 'tinycloud:pkh:eip155:1:0x02:agents', theirHandleForMe: 'alice',
    inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(START + 86_400_000).toISOString() },
    outbound: [], status: 'paired', pairedAt: new Date(START).toISOString(),
  };
  const w = { locked: false, polls: 0, streams: 0, events, selfKv };
  const hooks = {
    subscribe: (_subs, { signal }) => ({
      async *[Symbol.asyncIterator]() {
        w.streams++;
        try {
          if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        } finally { w.streams--; }
      },
    }),
  };
  w.watcher = new Watcher({
    selfKv, spaceId: 'tinycloud:pkh:eip155:1:0x01:agents', selfHooks: hooks,
    peerHooks: async () => hooks, loadPeers: () => [peer], kvFor: async () => peerKv,
    beforePoll: async () => {
      w.polls++;
      if (w.locked) throw new CourierError('profile-locked', 'Profile lock acquisition timed out');
    },
    wake: async () => {}, log: (event, fields) => events.push({ event, at: Date.now(), ...fields }),
    now: () => Date.now(),
  }, { debounceMs: 30_000, pollMs: POLL_MS, ticketSeconds: 600, wakeBudget: 12 });
  w.send = () => {
    const threadId = ulid();
    const message = buildMessage({
      threadId, text: 'queued while the profile is locked', role: 'ROLE_USER', intent: 'inform',
      from: { owner: peer.ownerDid, agent: peer.courierDid, label: 'Bob' },
    });
    message.messageId = ulid();
    peerKv.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'r' });
    return { threadId, id: message.messageId };
  };
  return w;
}

async function flush() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) { mock.timers.tick(1000); await flush(); }
}

function run(w, t) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const stop = new AbortController();
  const status = { settled: false, error: undefined, stop };
  const running = w.watcher.run(stop.signal).then(
    () => { status.settled = true; },
    (error) => { status.settled = true; status.error = error; },
  );
  t.after(async () => {
    stop.abort();
    await flush();
    let timer;
    const stopped = await Promise.race([
      running.then(() => true),
      new Promise((resolve) => { timer = realSetTimeout(resolve, 10_000, false); }),
    ]);
    realClearTimeout(timer);
    mock.timers.reset();
    assert.ok(stopped, 'watcher must stop when aborted during a profile-lock retry');
    assert.equal(status.error, undefined);
    assert.equal(w.streams, 0, 'all hook streams are closed on abort');
  });
  return status;
}

for (const phase of ['startup', 'cycle']) {
  test(`a profile lock timeout during ${phase} is logged and polling delivers queued messages after recovery`, async (t) => {
    const w = world();
    w.locked = phase === 'startup';
    const status = run(w, t);
    await flush();
    if (phase === 'cycle') {
      await advance(3000);
      assert.equal(w.streams, 2, 'the real hook supervisors are running');
      w.locked = true;
      await advance(POLL_MS);
    }
    const queued = w.send();
    assert.equal(status.settled, false, 'a profile lock timeout must not end the service');
    const retries = w.events.filter((event) => event.event === 'poll-error' && event.code === 'profile-locked');
    assert.equal(retries.length, 1, 'the timeout is logged once before retrying');
    assert.match(retries[0].message, /lock acquisition timed out/);
    assert.equal(retries[0].retryInMs, POLL_MS);
    assert.equal(w.events.some((event) => event.event === 'standby'), false, 'a local lock timeout is not a competing state writer');
    const attempts = w.polls;
    await advance(POLL_MS - 2000);
    assert.equal(w.polls, attempts, 'lock contention must not create a tight retry loop');
    assert.equal(w.events.some((event) => event.event === 'delivered' && event.messageId === queued.id), false);
    w.locked = false;
    await advance(5000);
    assert.ok(w.polls > attempts, 'preflight is retried after the normal polling delay');
    assert.ok(w.events.some((event) => event.event === 'delivered' && event.messageId === queued.id));
    assert.ok(w.selfKv.rows.has(k.mirrorMsg('bob', queued.threadId, queued.id)), 'the queued message is mirrored, not just logged');
    const later = w.send();
    await advance(POLL_MS);
    assert.ok(w.events.some((event) => event.event === 'delivered' && event.messageId === later.id), 'subsequent regular polling still delivers');
    assert.equal(status.settled, false);
  });
}

for (const phase of ['startup', 'cycle']) {
  test(`aborting a profile-lock retry during ${phase} stops without another attempt`, async (t) => {
    const w = world();
    w.locked = phase === 'startup';
    const status = run(w, t);
    await flush();
    if (phase === 'cycle') {
      await advance(3000);
      w.locked = true;
      await advance(POLL_MS);
    }
    assert.equal(status.settled, false);
    assert.ok(w.events.some((event) => event.event === 'poll-error' && event.code === 'profile-locked'));
    const attempts = w.polls;
    status.stop.abort();
    await flush();
    assert.equal(status.settled, true, 'abort interrupts the retry sleep');
    assert.equal(status.error, undefined);
    await advance(POLL_MS);
    assert.equal(w.polls, attempts, 'abort must not start another preflight');
  });
}

test('--once still rejects a profile lock timeout without retrying', async () => {
  const w = world();
  w.locked = true;
  await assert.rejects(w.watcher.run(new AbortController().signal, { once: true }), { code: 'profile-locked' });
  assert.equal(w.polls, 1);
  assert.equal(w.events.some((event) => event.event === 'poll-error'), false);
});
