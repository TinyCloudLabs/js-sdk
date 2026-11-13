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
import { PREFIX } from '../dist/keys.js';
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

const peer = (handle, extra = {}) => ({
  handle, ownerDid: 'did:pkh:eip155:1:0x02', courierDid: `did:key:z${handle}`, spaceId: `space-${handle}`, theirHandleForMe: 'me',
  inbound: { delegation: 'wire', cid: `cid-${handle}`, expiresAt: new Date(Date.now() + 24 * HOUR).toISOString() }, outbound: [], status: 'paired',
  ...extra,
});
const facts = (handles) => ({
  v: 1, claimsPrunedAt: 5,
  markerReadAt: Object.fromEntries(handles.map((h) => [h, 7])),
  receipted: Object.fromEntries(handles.map((h) => [h, [`T/${h}`]])),
  metaMirrored: [`${PREFIX}/to/me/threads/T/meta.json`],
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
  assert.deepEqual(after.metaMirrored, []);
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

test('F4: every batch read asks the node to bound each value at 8 MiB', async () => {
  const seen = [];
  const kv = { async batchGet(keys, options) { seen.push(options); return { ok: true, data: { results: keys.map((key) => ({ key, result: { ok: false, error: { code: 'KV_NOT_FOUND', message: 'none' } } })), count: keys.length } }; } };
  await readJsonMany(kv, ['a', 'b']);
  assert.equal(seen[0].maxResponseBytes, 8 * 1024 * 1024);
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
