// TC-2951 item 2 (Naomi's ruling): an action put off because its authority check gives no verdict is put off for at
// most 24 hours. A wake or inform held that long is dropped and logged; an import keeps retrying (nothing is dropped).
// The peer's human gets one notice per outage, never repeated; a verdict ends the outage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { PREFIX } from '../dist/keys.js';
import { memoryKv } from './memory-kv.mjs';

const HOUR = 3600_000;
const unavailable = () => Object.assign(new Error('node busy'), { status: 503 });

function side({ budget = 12 } = {}) {
  const clock = { t: Date.parse('2026-11-13T12:00:00Z') };
  const selfKv = memoryKv();
  const peerKv = memoryKv();
  const peer = {
    handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zBob', spaceId: 'space-bob', theirHandleForMe: 'alice',
    inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(clock.t + 30 * 24 * HOUR).toISOString() }, outbound: [], status: 'paired',
  };
  const state = { failing: false, wakeFails: 0, wakes: [], informs: [], notices: [], events: [] };
  const watcher = new Watcher({
    selfKv, spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [peer], kvFor: async () => peerKv,
    checkAuthority: async (handle) => { if (handle !== undefined && state.failing) throw unavailable(); },
    wake: async (request) => { if (state.wakeFails > 0) { state.wakeFails--; throw new Error('adapter down'); } state.wakes.push(request); },
    postInform: async (...args) => { state.informs.push(args); },
    notify: async (notice) => { state.notices.push(notice); },
    log: (event, fields) => state.events.push({ event, ...fields }),
    now: () => clock.t,
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: budget });
  const say = (threadId = ulid(), intent = 'request') => {
    const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent, from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid(clock.t);
    peerKv.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'm' });
    return message.messageId;
  };
  const access = () => state.notices.filter((notice) => notice.kind === 'access-unverified');
  return { watcher, state, clock, say, access };
}

test('wakes put off for 24 h are dropped and logged; the human is told once per outage, not per wake or again later', async () => {
  const s = side();
  await s.watcher.loadState();
  s.say();
  s.say();
  await s.watcher.pollOnce('poll');
  assert.equal(Object.keys(s.watcher.snapshot().pending).length, 2);
  s.state.failing = true;
  await s.watcher.tick(true);
  s.clock.t += 24 * HOUR - 60_000;
  await s.watcher.tick(true);
  assert.equal(Object.keys(s.watcher.snapshot().pending).length, 2, 'still queued just short of 24 h');
  assert.equal(s.access().length, 0);
  s.clock.t += 2 * 60_000;
  await s.watcher.tick(true);
  assert.equal(Object.keys(s.watcher.snapshot().pending).length, 0, 'dropped after 24 h');
  assert.equal(s.state.wakes.length, 0);
  assert.equal(s.state.events.filter((e) => e.event === 'wake-dropped' && e.reason === 'authority-unverified-24h').length, 2);
  await s.watcher.tick(true);
  assert.equal(s.access().length, 1, 'one notice for the outage');
  assert.equal(s.access()[0].peer, 'bob');
  for (const step of [HOUR, 24 * HOUR, 24 * HOUR]) { s.clock.t += step; await s.watcher.pollOnce('poll'); await s.watcher.tick(true); }
  assert.equal(s.access().length, 1, 'no repeat while the outage lasts');
});

test('an inform put off for 24 h is dropped and logged, without counting as a failed attempt', async () => {
  const s = side({ budget: 1 });
  await s.watcher.loadState();
  const thread = ulid();
  s.say(thread, 'update');
  await s.watcher.pollOnce('poll'); await s.watcher.tick();
  s.clock.t += 1000;
  s.say(thread, 'update');
  await s.watcher.pollOnce('poll');
  s.state.failing = true;
  await s.watcher.tick(); // over budget: paused, inform queued
  s.clock.t += 61_000;
  await s.watcher.tick(); // its first attempt is put off
  assert.ok(s.state.events.some((e) => e.event === 'inform-deferred'));
  s.clock.t += 24 * HOUR - 60_000;
  await s.watcher.tick();
  assert.equal(s.watcher.snapshot().outbox.filter((item) => item.kind === 'inform').length, 1, 'still queued just short of 24 h');
  assert.equal(s.watcher.snapshot().outbox.find((item) => item.kind === 'inform').tries ?? 0, 0, 'deferrals are not failed attempts');
  s.clock.t += 2 * 60_000;
  await s.watcher.tick();
  assert.equal(s.watcher.snapshot().outbox.filter((item) => item.kind === 'inform').length, 0, 'dropped after 24 h');
  assert.deepEqual(s.state.informs, []);
  assert.ok(s.state.events.some((e) => e.event === 'inform-dropped' && e.reason === 'authority-unverified-24h'));
  await s.watcher.tick();
  assert.equal(s.access().length, 1);
});

test('imports are never dropped: after 24 h the human is told once, and a verdict ends the outage so a later one notifies again', async () => {
  const s = side();
  await s.watcher.loadState();
  s.state.failing = true;
  const first = s.say();
  for (const step of [0, 12 * HOUR, 12 * HOUR + 60_000, 60_000]) { s.clock.t += step; await s.watcher.pollOnce('poll'); await s.watcher.tick(); }
  assert.equal(s.access().length, 1, 'one notice after 24 h');
  assert.ok(s.state.events.some((e) => e.event === 'access-unverified' && e.peer === 'bob'), 'logged once');
  assert.equal(s.state.events.filter((e) => e.event === 'access-unverified').length, 1);
  assert.equal(s.state.events.some((e) => e.event === 'delivered'), false, 'nothing imported while unverified');
  s.state.failing = false;
  s.clock.t += 60_000;
  await s.watcher.pollOnce('poll');
  assert.ok(s.state.events.some((e) => e.event === 'delivered' && e.messageId === first), 'imported once a check succeeds');
  assert.deepEqual(s.watcher.snapshot().unverified, {}, 'the verdict ended the outage');
  // A new outage starts its own 24 h and its own single notice.
  s.state.failing = true;
  s.say();
  for (const step of [60_000, 24 * HOUR, 60_000]) { s.clock.t += step; await s.watcher.pollOnce('poll'); await s.watcher.tick(); }
  assert.equal(s.access().length, 2);
});

test('a verdict within 24 h restarts the clock: a wake whose adapter then fails is not dropped on the old clock', async () => {
  const s = side();
  await s.watcher.loadState();
  s.say();
  await s.watcher.pollOnce('poll');
  s.state.failing = true;
  await s.watcher.tick(true);
  s.clock.t += 23 * HOUR;
  s.state.failing = false;
  s.state.wakeFails = 1;
  await s.watcher.tick(true); // a verdict, then the adapter fails: the wake stays queued
  assert.equal(Object.keys(s.watcher.snapshot().pending).length, 1);
  assert.equal(s.access().length, 0);
  s.state.failing = true;
  for (const step of [2 * HOUR, 60_000]) { s.clock.t += step; await s.watcher.tick(true); }
  assert.equal(Object.keys(s.watcher.snapshot().pending).length, 1, 'still queued: its 24 h started again after the verdict');
  assert.equal(s.state.events.some((e) => e.event === 'wake-dropped'), false);
  s.state.failing = false;
  s.clock.t += 60_000;
  await s.watcher.tick(true);
  assert.equal(s.state.wakes.length, 1, 'woken once a check succeeds');
});
