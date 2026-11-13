// TC-2917 / TC-2951, Bobbie's review of #955 at 9170bbbfa: F1 nothing in the caches is read or written through a
// symlinked directory anywhere from the profile down; F3 the watcher's local knowledge is bound to our and each peer's
// identity, is cleared with the read cache and has the same directory checks; F4 batch reads bound each value;
// F5 a positive verdict restarts an inform's deferral clock even if its post then fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { clearLocalCaches, diskThreadCache } from '../dist/thread.js';
import { fileWatchCache } from '../dist/watch-cache.js';
import { readJsonMany } from '../dist/store.js';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { PREFIX, k } from '../dist/keys.js';
import { profileDir } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';
import { privateDir, stillPrivate } from '../dist/private-dir.js';

const AGENT = 'did:key:z6MkAgentR';
const HOUR = 3600_000;

function outsideDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-outside-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('F1: a cached thread is never read through a symlinked cache or agent directory', () => {
  const root = path.join(profileDir(), 'read-cache');
  const threadId = ulid();
  // A real cache written the normal way, then moved out and linked back in.
  const first = diskThreadCache(AGENT, threadId);
  first.set('peer:x:key', { v: 'cached' });
  first.save();
  assert.deepEqual(diskThreadCache(AGENT, threadId).get('peer:x:key'), { v: 'cached' }, 'readable from the real directory');
  const outside = outsideDir();
  const agentDir = path.join(root, 'z6MkAgentR');
  fs.renameSync(agentDir, path.join(outside.dir, 'z6MkAgentR'));
  fs.symlinkSync(path.join(outside.dir, 'z6MkAgentR'), agentDir);
  assert.equal(diskThreadCache(AGENT, threadId).get('peer:x:key'), undefined, 'not read through a symlinked agent directory');
  fs.rmSync(agentDir);
  fs.renameSync(path.join(outside.dir, 'z6MkAgentR'), agentDir);
  fs.renameSync(root, path.join(outside.dir, 'read-cache'));
  fs.symlinkSync(path.join(outside.dir, 'read-cache'), root);
  assert.equal(diskThreadCache(AGENT, threadId).get('peer:x:key'), undefined, 'nor through a symlinked cache root');
  const writer = diskThreadCache(AGENT, ulid());
  writer.set('peer:x:key', { v: 'new' });
  writer.save();
  assert.deepEqual(fs.readdirSync(path.join(outside.dir, 'read-cache', 'z6MkAgentR')).length, 1, 'and nothing new is written through it');
  fs.rmSync(root);
  outside.cleanup();
});

test('F1: a symlinked component is refused when checked, and a component swapped for a link after the check is caught before use', () => {
  const outside = outsideDir();
  fs.mkdirSync(path.join(profileDir(), 'guard-a', 'inner'), { recursive: true, mode: 0o700 });
  const checked = privateDir(['guard-a', 'inner'], false);
  assert.ok(checked && stillPrivate(checked), 'a real chain passes');
  fs.renameSync(path.join(profileDir(), 'guard-a'), path.join(outside.dir, 'guard-a'));
  fs.symlinkSync(path.join(outside.dir, 'guard-a'), path.join(profileDir(), 'guard-a'));
  assert.equal(stillPrivate(checked), false, 'the swap is caught before use');
  assert.equal(privateDir(['guard-a', 'inner'], false), undefined, 'and a fresh check refuses the linked chain');
  assert.equal(privateDir(['guard-a', 'inner'], true), undefined, 'even when asked to create it');
  fs.rmSync(path.join(profileDir(), 'guard-a'));
  outside.cleanup();
});

test('F1: a COURIER_HOME under a group/other-writable non-sticky directory, or itself a symlink, gets no cache and is never chmodded', () => {
  const saved = process.env.COURIER_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-strict-'));
  try {
    const loose = path.join(base, 'loose');
    fs.mkdirSync(path.join(loose, 'home'), { recursive: true });
    fs.chmodSync(loose, 0o777); // writable by anyone, not sticky
    fs.chmodSync(path.join(loose, 'home'), 0o755);
    process.env.COURIER_HOME = path.join(loose, 'home');
    assert.equal(privateDir(['read-cache'], true), undefined, 'refused under a writable ancestor');
    assert.equal(fs.statSync(path.join(loose, 'home')).mode & 0o777, 0o755, 'and COURIER_HOME was not touched');
    const target = path.join(base, 'target');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(base, 'linked'));
    process.env.COURIER_HOME = path.join(base, 'linked');
    assert.equal(privateDir(['read-cache'], true), undefined, 'refused when COURIER_HOME is a symlink');
    assert.equal(fs.statSync(target).mode & 0o777, 0o755, 'and what it points at is never chmodded');
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    process.env.COURIER_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('F1: clearing the caches never deletes through a symlinked cache directory', () => {
  const outside = outsideDir();
  fs.writeFileSync(path.join(outside.dir, 'keep.json'), '{}');
  fs.rmSync(path.join(profileDir(), 'read-cache'), { recursive: true, force: true });
  fs.symlinkSync(outside.dir, path.join(profileDir(), 'read-cache'));
  clearLocalCaches();
  assert.ok(fs.existsSync(path.join(outside.dir, 'keep.json')), 'the target keeps its files');
  assert.equal(fs.existsSync(path.join(profileDir(), 'read-cache')), false, 'only the link is removed');
  outside.cleanup();
});

const peer = (handle, extra = {}) => ({
  handle, ownerDid: 'did:pkh:eip155:1:0x02', courierDid: `did:key:z${handle}`, spaceId: `space-${handle}`, theirHandleForMe: 'me',
  inbound: { delegation: 'wire', cid: `cid-${handle}`, expiresAt: new Date(Date.now() + 24 * HOUR).toISOString() }, outbound: [], status: 'paired',
  ...extra,
});
const facts = (handles, identityOf = (h) => ({ did: `did:key:z${h}`, space: `space-${h}`, session: null })) => ({
  v: 1, claimsPrunedAt: 5,
  markerReadAt: Object.fromEntries(handles.map((h) => [h, 7])),
  receipted: Object.fromEntries(handles.map((h) => [h, [`T/${h}`]])),
  metaMirrored: Object.fromEntries(handles.map((h) => [h, [`${PREFIX}/to/me/threads/T/meta.json`]])),
  identities: Object.fromEntries(handles.map((h) => [h, identityOf(h)])),
});

test("F3: the watcher's local knowledge is bound to our DID and space and to each peer's DID, space and session", () => {
  clearLocalCaches();
  let peers = [peer('bob'), peer('carol')];
  const cache = fileWatchCache(AGENT, 'space-mine', () => peers);
  cache.save(facts(['bob', 'carol']));
  const loaded = cache.load();
  assert.deepEqual(Object.keys(loaded.receipted).sort(), ['bob', 'carol']);
  assert.equal(fileWatchCache(AGENT, 'space-reinit', () => peers).load(), undefined, 'another space of ours starts empty');
  // bob is re-paired to another agent under the same handle; carol starts a new session.
  peers = [peer('bob', { courierDid: 'did:key:zMallory' }), peer('carol', { sessionId: ulid() })];
  const after = fileWatchCache(AGENT, 'space-mine', () => peers).load();
  assert.deepEqual(after.receipted, {}, 'neither keeps its receipted ids');
  assert.deepEqual(after.markerReadAt, {});
  assert.deepEqual(after.metaMirrored, {});
});

test('F3: the local knowledge is cleared with the read cache and never written through a symlinked directory', () => {
  clearLocalCaches();
  const peers = [peer('bob')];
  const cache = fileWatchCache(AGENT, 'space-mine', () => peers);
  cache.save(facts(['bob']));
  assert.ok(cache.load());
  clearLocalCaches();
  assert.equal(cache.load(), undefined, 'revoke, refusal, owner revocation and rotation clear it');
  const outside = outsideDir();
  fs.symlinkSync(outside.dir, path.join(profileDir(), 'watch-cache'));
  cache.save(facts(['bob']));
  assert.deepEqual(fs.readdirSync(outside.dir), [], 'nothing written through the link');
  assert.equal(cache.load(), undefined);
  fs.rmSync(path.join(profileDir(), 'watch-cache'));
  outside.cleanup();
});

test('F4: batch reads ask the node to bound each value, and size batches to at most 32 MiB a response', async () => {
  const seen = [];
  const kv = { async batchGet(keys, options) { seen.push({ keys: keys.length, cap: options.maxResponseBytes }); return { ok: true, data: { results: keys.map((key) => ({ key, result: { ok: false, error: { code: 'KV_NOT_FOUND', message: 'none' } } })), count: keys.length } }; } };
  const messages = Array.from({ length: 20 }, (_, i) => `x/threads/T/msg/${i}.json`);
  const tasks = Array.from({ length: 5 }, (_, i) => `x/threads/T/task/${i}.json`);
  await readJsonMany(kv, [...messages, ...tasks]);
  assert.deepEqual(seen, [
    { keys: 16, cap: 2 * 1024 * 1024 }, { keys: 4, cap: 2 * 1024 * 1024 },
    { keys: 4, cap: 8 * 1024 * 1024 }, { keys: 1, cap: 8 * 1024 * 1024 },
  ]);
  for (const { keys, cap } of seen) assert.ok(keys * cap <= 32 * 1024 * 1024);
});

test("F3: facts learned for one peer are never saved, loaded or used under another identity of the same handle", async () => {
  clearLocalCaches();
  const peerA = peer('bob', { theirHandleForMe: 'alice' });
  const peerB = peer('bob', { theirHandleForMe: 'alice', courierDid: 'did:key:zMallory', spaceId: 'space-mallory' });
  // Saving: facts learned under A, saved while the handle is now B, are dropped, not stamped with B.
  let current = peerB;
  const cache = fileWatchCache(AGENT, 'space-mine', () => [current]);
  cache.save(facts(['bob'], () => ({ did: peerA.courierDid, space: peerA.spaceId, session: null })));
  assert.equal(cache.load().receipted.bob, undefined, 'saved for B: nothing');

  // Using: a live watcher that learned A's message does not skip B's message under the same key.
  clearLocalCaches();
  current = peerA;
  const peerKv = memoryKv();
  const selfKv = memoryKv();
  const events = [];
  const watcher = new Watcher({
    selfKv, agent: AGENT, spaceId: 'space-mine', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [current], kvFor: async () => peerKv,
    wake: async () => {}, log: (event, fields) => events.push({ event, ...fields }), localCache: cache,
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 12 });
  const thread = ulid();
  const messageId = ulid();
  const key = `${PREFIX}/to/alice/threads/${thread}/msg/${messageId}.json`;
  const say = (text) => {
    const message = buildMessage({ threadId: thread, text, role: 'ROLE_USER', intent: 'update', from: { owner: 'o', agent: 'a' } });
    message.messageId = messageId;
    peerKv.rows.set(key, { value: message, etag: text });
  };
  await watcher.loadState();
  say('from A');
  await watcher.pollOnce('poll');
  assert.equal(events.filter((e) => e.event === 'delivered').length, 1, "A's message is delivered and receipted");
  // The handle is re-paired to B. Its own records start fresh (no receipts or mirror for the new pairing yet).
  current = peerB;
  for (const row of [...selfKv.rows.keys()]) if (row.includes('/receipts') || row.includes('/mirror/')) selfKv.rows.delete(row);
  say('from B');
  await watcher.pollOnce('poll');
  assert.equal(events.filter((e) => e.event === 'delivered').length, 2, "B's message under the same key is delivered, not skipped on A's facts");
});

test('P3-1: two peers that use the same name for us keep their own mirrored meta, live and on disk', async () => {
  clearLocalCaches();
  const peers = [peer('bob'), peer('carol')]; // both call us "me"
  const kvs = { bob: memoryKv(), carol: memoryKv() };
  const selfKv = memoryKv();
  const cache = fileWatchCache(AGENT, 'space-mine', () => peers);
  const thread = ulid();
  const metaKey = `${PREFIX}/to/me/threads/${thread}/meta.json`;
  kvs.bob.rows.set(metaKey, { value: { threadId: thread, subject: 'from bob' }, etag: 'b' });
  const watcher = new Watcher({
    selfKv, agent: AGENT, spaceId: 'space-mine', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => peers,
    kvFor: async (p) => kvs[p.handle], wake: async () => {}, log: () => {}, localCache: cache,
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 12 });
  await watcher.loadState();
  await watcher.pollOnce('poll');
  assert.ok(selfKv.rows.has(k.mirrorMeta('bob', thread)));
  // carol's thread meta under the very same key path, after bob's was mirrored, is mirrored too.
  kvs.carol.rows.set(metaKey, { value: { threadId: thread, subject: 'from carol' }, etag: 'c' });
  await watcher.pollOnce('poll');
  assert.equal(selfKv.rows.get(k.mirrorMeta('carol', thread))?.value.subject, 'from carol', "carol's meta is not skipped on bob's");
  // Saved: each peer's key only under the peer it was learned from.
  cache.save({
    v: 1, markerReadAt: {}, receipted: {}, metaMirrored: { bob: [metaKey] },
    identities: { bob: { did: 'did:key:zbob', space: 'space-bob', session: null }, carol: { did: 'did:key:zcarol', space: 'space-carol', session: null } },
  });
  assert.deepEqual(cache.load().metaMirrored, { bob: [metaKey], carol: [] }, "bob's key is never saved under carol");
  clearLocalCaches();
});

test('P3-2: a refused fchmod skips the cache: courier read neither throws nor uses it', () => {
  clearLocalCaches();
  const threadId = ulid();
  const seed = diskThreadCache(AGENT, threadId);
  seed.set('peer:x:key', { v: 'cached' });
  seed.save();
  const dir = path.join(profileDir(), 'read-cache');
  fs.chmodSync(dir, 0o755); // needs tightening, and the fchmod is refused
  const realFchmod = fs.fchmodSync;
  fs.fchmodSync = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  try {
    assert.equal(privateDir(['read-cache'], false), undefined, 'refused, not thrown');
    const cache = diskThreadCache(AGENT, threadId);
    cache.set('peer:x:key', { v: 1 });
    assert.doesNotThrow(() => cache.save());
  } finally { fs.fchmodSync = realFchmod; }
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755, 'nothing chmodded by any other route');
  clearLocalCaches();
});

test('F5: a positive verdict restarts an inform\'s 24 h clock, even when its post then fails', async () => {
  const clock = { t: Date.parse('2026-11-13T12:00:00Z') };
  const peerKv = memoryKv();
  const state = { failing: false, postFails: 0, informs: [], events: [] };
  const bob = peer('bob', { theirHandleForMe: 'alice' });
  const watcher = new Watcher({
    selfKv: memoryKv(), spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [bob], kvFor: async () => peerKv,
    checkAuthority: async (handle) => { if (handle !== undefined && state.failing) throw Object.assign(new Error('busy'), { status: 503 }); },
    wake: async () => {},
    postInform: async (...args) => { if (state.postFails > 0) { state.postFails--; throw new Error('post failed'); } state.informs.push(args); },
    log: (event, fields) => state.events.push({ event, ...fields }),
    now: () => clock.t,
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 1 });
  const say = (threadId) => {
    const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'update', from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid(clock.t);
    peerKv.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'm' });
  };
  await watcher.loadState();
  const thread = ulid();
  say(thread);
  await watcher.pollOnce('poll'); await watcher.tick();
  clock.t += 1000;
  say(thread);
  await watcher.pollOnce('poll');
  state.failing = true;
  await watcher.tick(); // over budget: paused, inform queued
  clock.t += 61_000;
  await watcher.tick(); // the inform is put off
  clock.t += 23 * HOUR;
  state.failing = false;
  state.postFails = 1;
  await watcher.tick(); // a positive verdict; the post then fails
  const queued = () => watcher.snapshot().outbox.filter((item) => item.kind === 'inform');
  assert.equal(queued().length, 1, 'the failed post stays queued');
  assert.equal(queued()[0].deferredSince, undefined, 'the verdict ended the deferral');
  state.failing = true;
  for (const step of [2 * HOUR, 60_000]) { clock.t += step; await watcher.tick(); }
  assert.equal(queued().length, 1, 'not dropped on the old clock');
  assert.equal(state.events.some((e) => e.event === 'inform-dropped'), false);
  state.failing = false;
  clock.t += 16 * 60_000;
  await watcher.tick();
  assert.equal(state.informs.length, 1, 'posted once the check succeeds');
});
