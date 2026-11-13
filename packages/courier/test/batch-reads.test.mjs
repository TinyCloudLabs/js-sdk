// TC-2917 (Naomi, from Orchard's finding): Courier reads N entries with the SDK's batch get, in bounded batches (16 messages
// or meta of ≤2 MiB, or 4 tasks of ≤8 MiB, per invocation: ≤32 MiB a response), instead of one get each. Every entry is still
// checked on its own, and a failure stays as narrow as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { collectThread } from '../dist/thread.js';
import { collectInbound } from '../dist/inbox.js';
import { intakeCycle } from '../dist/intake/intake.js';
import { ensureRealDir } from '../dist/intake/queue.js';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX } from '../dist/keys.js';
import { getJsonMany } from '../dist/store.js';

/** A KV that answers batch gets like the node and counts invocations: `get` is one key, `batch` one batch call. */
function batchKv() {
  const rows = new Map();
  const calls = { list: 0, get: 0, batch: 0, batchKeys: [] };
  const fail = new Map();
  const huge = new Set(); // values over any cap: the node refuses them with KV_RESPONSE_TOO_LARGE
  const tooLarge = { ok: false, error: { code: 'KV_RESPONSE_TOO_LARGE', message: 'A KV batch value exceeds the requested response limit' } };
  const answer = (key) => {
    if (fail.has(key)) return { ok: false, error: { status: fail.get(key), message: 'down' } };
    const row = rows.get(key);
    return row ? { ok: true, data: { data: row, headers: { etag: 'e' } } } : { ok: false, error: { code: 'KV_NOT_FOUND', message: 'Key not found' } };
  };
  return {
    rows, calls, fail, huge, failBatch: false,
    async list({ prefix }) { calls.list++; return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } }; },
    async get(key, options = {}) { calls.get++; return huge.has(key) && options.maxResponseBytes ? tooLarge : answer(key); },
    async batchGet(keys, options = {}) {
      calls.batch++;
      calls.batchKeys.push(keys.length);
      if (keys.length > 100) return { ok: false, error: { code: 'INVALID_INPUT', message: 'at most 100 keys' } };
      if (this.failBatch) return { ok: false, error: { status: 400, message: 'bad batch' } };
      if (options.maxResponseBytes && keys.some((key) => huge.has(key))) return tooLarge;
      return { ok: true, data: { results: keys.map((key) => ({ key, result: answer(key) })), count: keys.length } };
    },
    async put(key, value) { rows.set(key, structuredClone(value)); return { ok: true, data: { data: undefined, headers: { etag: 'p' } } }; },
    async delete(key) { rows.delete(key); return { ok: true, data: undefined }; },
  };
}

function message(threadId, at = Date.now()) {
  const body = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'inform', from: { owner: 'o', agent: 'a' } });
  body.messageId = ulid(at);
  return body;
}

const peer = {
  handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zBob', spaceId: 'space-bob', theirHandleForMe: 'alice',
  inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, outbound: [], status: 'paired',
};

test('a 260-entry read is 2 listings and bounded batch calls, no single gets; every entry is still checked on its own', async () => {
  const mine = batchKv();
  const theirs = batchKv();
  const threadId = ulid();
  mine.rows.set(k.threadMeta('bob', threadId), { threadId, subject: 'S' });
  for (let i = 0; i < 130; i++) {
    const own = message(threadId); mine.rows.set(k.msg('bob', threadId, own.messageId), own);
    const their = message(threadId); theirs.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${their.messageId}.json`, their);
  }
  const malformed = ulid();
  theirs.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${malformed}.json`, { messageId: malformed, parts: 'not parts' });
  const result = await collectThread({ threadId, selfKv: mine, peers: [peer], exactPeer: true, kvFor: async () => theirs });
  assert.equal(result.entries.length, 262);
  assert.deepEqual([mine.calls.list, theirs.calls.list], [1, 1]);
  assert.deepEqual([mine.calls.get, theirs.calls.get], [0, 0], 'no entry is read on its own');
  const sixteens = (n) => [...Array(Math.floor(n / 16)).fill(16), ...(n % 16 ? [n % 16] : [])];
  assert.deepEqual(mine.calls.batchKeys, sixteens(131), 'our meta and 130 messages, 16 per invocation');
  assert.deepEqual(theirs.calls.batchKeys, sixteens(131), "the peer's 130 messages and the malformed one");
  assert.ok(result.entries.find((entry) => entry.id === malformed).invalid?.length, 'a malformed entry is still flagged');
});

test("a batch read keeps getJson's per-key answers: missing is absent, any other failure fails the read", async () => {
  const kv = batchKv();
  kv.rows.set('a', { v: 1 });
  const got = await getJsonMany(kv, ['a', 'missing']);
  assert.deepEqual(got.values.get('a').value, { v: 1 });
  assert.equal(got.values.get('missing'), undefined);
  kv.fail.set('a', 403);
  await assert.rejects(getJsonMany(kv, ['a', 'missing']));
});

function watcherSide() {
  const selfKv = batchKv();
  const peerKv = batchKv();
  const events = [];
  const watcher = new Watcher({
    selfKv, spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [peer], kvFor: async () => peerKv,
    wake: async () => {}, log: (event, fields) => events.push({ event, ...fields }), now: () => Date.now(),
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 12 });
  const say = (threadId) => {
    const body = message(threadId);
    peerKv.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${body.messageId}.json`, body);
    return body.messageId;
  };
  return { watcher, selfKv, peerKv, events, say };
}

test('the watcher imports 130 messages with 2 batch calls; one failing message is retried alone, a failed batch call delays all', async () => {
  const s = watcherSide();
  await s.watcher.loadState();
  const thread = ulid();
  const ids = Array.from({ length: 130 }, () => s.say(thread));
  const flaky = `${PREFIX}/to/alice/threads/${thread}/msg/${ids[7]}.json`;
  s.peerKv.fail.set(flaky, 500);
  await s.watcher.pollOnce('poll');
  const delivered = () => s.events.filter((e) => e.event === 'delivered').map((e) => e.messageId);
  assert.equal(s.peerKv.calls.get, 0);
  assert.ok(s.peerKv.calls.batchKeys.every((n) => n <= 16) && s.peerKv.calls.batchKeys.length >= 9, '130 messages in batches of at most 16');
  assert.equal(delivered().length, 129, 'the others are delivered');
  assert.ok(!delivered().includes(ids[7]));
  s.peerKv.fail.delete(flaky);
  await s.watcher.pollOnce('poll');
  assert.ok(delivered().includes(ids[7]), 'the failed one is delivered on the next sync');

  const t = watcherSide();
  await t.watcher.loadState();
  const other = ulid();
  t.say(other);
  t.peerKv.failBatch = true;
  await t.watcher.pollOnce('poll');
  assert.equal(t.events.filter((e) => e.event === 'delivered').length, 0);
  assert.ok(t.events.some((e) => e.event === 'sync-error'));
  t.peerKv.failBatch = false;
  await t.watcher.pollOnce('poll');
  assert.equal(t.events.filter((e) => e.event === 'delivered').length, 1, 'delivered once the batch call succeeds');
});

test('courier inbox and intake read their messages in batches', async () => {
  const peerKv = batchKv();
  const thread = ulid();
  for (let i = 0; i < 130; i++) { const body = message(thread); peerKv.rows.set(`${PREFIX}/to/alice/threads/${thread}/msg/${body.messageId}.json`, body); }
  const inbox = await collectInbound({ selfKv: batchKv(), peers: [peer], kvFor: async () => peerKv });
  assert.equal(inbox.items.length, 130);
  assert.equal(peerKv.calls.get, 0);
  assert.deepEqual(peerKv.calls.batchKeys, [16, 16, 16, 16, 16, 16, 16, 16, 2]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-batch-intake-'));
  const dirs = { queueRoot: path.join(root, 'queue'), stateDir: path.join(root, 'state'), doneRoot: path.join(root, 'done'), overflowRoot: path.join(root, 'overflow') };
  ensureRealDir(dirs.queueRoot, 0o750); ensureRealDir(dirs.stateDir, 0o700); ensureRealDir(dirs.doneRoot, 0o700); ensureRealDir(dirs.overflowRoot, 0o700);
  const kv = batchKv();
  const now = Date.now();
  for (let i = 0; i < 130; i++) { const body = message(thread, now - 60_000 + i); kv.rows.set(k.mirrorMsg('bob', thread, body.messageId), body); }
  const queued = await intakeCycle({
    kv, profile: { version: 3, peers: { bob: { ...peer, outbound: [] } } }, peers: { bob: { tier: 'trusted', ratePerHour: 1000 } },
    ...dirs, state: { v: 1, peers: {} }, now: () => now, log: () => {}, batch: 130,
  });
  assert.equal(queued, 130);
  assert.equal(kv.calls.get, 0);
  assert.deepEqual(kv.calls.batchKeys, [16, 16, 16, 16, 16, 16, 16, 16, 2]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('one oversized value is isolated: read and inbox report it and show every other entry', async () => {
  const mine = batchKv();
  const theirs = batchKv();
  const threadId = ulid();
  mine.rows.set(k.threadMeta('bob', threadId), { threadId, subject: 'S' });
  const keys = [];
  for (let i = 0; i < 20; i++) {
    const their = message(threadId);
    const key = `${PREFIX}/to/alice/threads/${threadId}/msg/${their.messageId}.json`;
    theirs.rows.set(key, their);
    keys.push([key, their.messageId]);
  }
  const [hugeKey, hugeId] = keys[3];
  theirs.huge.add(hugeKey);
  theirs.rows.get(hugeKey).parts[0].text = 'VALUE-BYTES-MARKER';
  const result = await collectThread({ threadId, selfKv: mine, peers: [peer], exactPeer: true, kvFor: async () => theirs });
  assert.equal(result.entries.filter((e) => e.side === 'peer').length, 19, 'every other peer message is shown');
  assert.ok(result.errors.some((e) => e.code === 'entry-too-large' && e.message.includes(hugeId)), 'the oversized one is reported');
  assert.equal(result.partial, true);
  // Bounded: the refused chunk of 16 is read key by key exactly once; the other chunk is a plain batch.
  assert.deepEqual(theirs.calls.batchKeys, [16, 4]);
  assert.equal(theirs.calls.get, 16);
  const inbox = await collectInbound({ selfKv: batchKv(), peers: [peer], kvFor: async () => theirs });
  assert.equal(inbox.items.length, 19);
  assert.ok(inbox.errors.some((e) => e.code === 'message-too-large' && e.message.includes(hugeId)));
  assert.equal(theirs.calls.get, 32);
  assert.ok(!JSON.stringify([result.errors, inbox.errors]).includes('VALUE-BYTES-MARKER'), 'reported by id, never by content');
});

test('one oversized value is isolated: the watcher delivers the rest, reports it once and does not read it again', async () => {
  const s = watcherSide();
  await s.watcher.loadState();
  const thread = ulid();
  const ids = Array.from({ length: 20 }, () => s.say(thread));
  s.peerKv.huge.add(`${PREFIX}/to/alice/threads/${thread}/msg/${ids[5]}.json`);
  await s.watcher.pollOnce('poll');
  const delivered = () => s.events.filter((e) => e.event === 'delivered').map((e) => e.messageId);
  assert.equal(delivered().length, 19);
  assert.ok(!delivered().includes(ids[5]));
  assert.equal(s.events.filter((e) => e.event === 'ignored' && e.reason === 'too-large').length, 1);
  const gets = s.peerKv.calls.get;
  await s.watcher.pollOnce('poll');
  assert.equal(s.events.filter((e) => e.event === 'ignored' && e.reason === 'too-large').length, 1, 'reported once');
  assert.equal(s.peerKv.calls.get, gets, 'not read again');
});

test('one oversized value is isolated: intake queues the rest and marks it done as too large', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-batch-intake-huge-'));
  const dirs = { queueRoot: path.join(root, 'queue'), stateDir: path.join(root, 'state'), doneRoot: path.join(root, 'done'), overflowRoot: path.join(root, 'overflow') };
  ensureRealDir(dirs.queueRoot, 0o750); ensureRealDir(dirs.stateDir, 0o700); ensureRealDir(dirs.doneRoot, 0o700); ensureRealDir(dirs.overflowRoot, 0o700);
  const kv = batchKv();
  const now = Date.now();
  const thread = ulid();
  const ids = [];
  for (let i = 0; i < 20; i++) { const body = message(thread, now - 60_000 + i); kv.rows.set(k.mirrorMsg('bob', thread, body.messageId), body); ids.push(body.messageId); }
  kv.huge.add(k.mirrorMsg('bob', thread, ids[2]));
  const logs = [];
  const queued = await intakeCycle({
    kv, profile: { version: 3, peers: { bob: { ...peer, outbound: [] } } }, peers: { bob: { tier: 'trusted', ratePerHour: 1000 } },
    ...dirs, state: { v: 1, peers: {} }, now: () => now, log: (event, fields) => logs.push({ event, ...fields }), batch: 20,
  });
  assert.equal(queued, 19);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.doneRoot, 'bob', `${ids[2]}.json`), 'utf8')).outcome, 'too-large');
  // Visible where intake errors are, by id; and read key by key once, for its chunk of 16 only.
  assert.deepEqual(logs.filter((l) => l.event === 'intake-error'), [{ event: 'intake-error', peer: 'bob', threadId: thread, msgId: ids[2], code: 'too-large' }]);
  assert.equal(kv.calls.get, 16);
  fs.rmSync(root, { recursive: true, force: true });
});
