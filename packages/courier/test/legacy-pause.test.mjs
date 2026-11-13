// TC-2917 (Naomi's condition on the test-ruling): a thread a human paused before the upgrade, at the shared
// `me/state/paused/` key, stays paused after it. The watcher and `courier pause`/`resume` read the shared marker and
// copy it create-only to the agent's own key; a resume removes both, so the shared copy can never pause it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX, stateKeys } from '../dist/keys.js';
import { cmdPause, cmdResume } from '../dist/pause.js';
import { parseArgs } from '../dist/args.js';

const JULIE = 'did:key:z6MkJuLie';

function memoryKv() {
  const rows = new Map();
  let sequence = 0;
  const kv = {
    rows,
    failDelete: undefined,
    async list({ prefix }) { return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } }; },
    async get(key) {
      const row = rows.get(key);
      return row ? { ok: true, data: { data: row.value, headers: { etag: row.etag } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async batchGet(keys, options) {
      const results = [];
      for (const key of keys) results.push({ key, result: await this.get(key, options) });
      return { ok: true, data: { results, count: results.length } };
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
      if (kv.failDelete === key) { kv.failDelete = undefined; return { ok: false, error: { status: 503, message: 'down' } }; }
      rows.delete(key);
      return { ok: true, data: undefined };
    },
  };
  return kv;
}

const bob = {
  handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zbob', spaceId: 'space-bob', theirHandleForMe: 'me',
  inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
  outbound: [], status: 'paired', pairedAt: new Date().toISOString(),
};
const profile = { peers: { bob }, ownerDid: 'did:pkh:eip155:1:0x01', courierDid: JULIE, spaceId: 'space-owner', label: 'Julie' };

function say(kv, threadId) {
  const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'request', from: { owner: 'o', agent: 'a' } });
  message.messageId = ulid();
  kv.rows.set(`${PREFIX}/to/me/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'm' });
}

/** One `watch --once` run of Julie's upgraded watcher; returns the threads it woke. */
async function watchOnce(selfKv, bobKv) {
  const wakes = [];
  const watcher = new Watcher({
    selfKv, agent: JULIE, spaceId: 'space-owner', selfHooks: {}, peerHooks: async () => ({}),
    loadPeers: () => [bob], kvFor: async () => bobKv,
    wake: async (request) => { wakes.push(request.threadId); },
    log: () => {}, now: () => Date.now(),
  }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 12 });
  await watcher.run(new AbortController().signal, { once: true });
  return wakes;
}

function pausedBeforeUpgrade(selfKv, threadId, extra = {}) {
  selfKv.rows.set(k.threadMeta('bob', threadId), { value: { threadId, subject: 'S' }, etag: 'meta' });
  selfKv.rows.set(k.paused('bob', threadId), { etag: 'legacy', value: {
    v: 1, peer: 'bob', threadId, by: 'human', at: '2026-11-01T00:00:00.000Z', reason: 'paused by its owner', informId: ulid(), informSent: true, ...extra,
  } });
}

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const deps = (kv) => ({ profile: () => profile, node: async () => ({ kv }) });
const informs = (kv, threadId) => [...kv.rows.keys()].filter((key) => key.startsWith(`${k.msgPrefix('bob', threadId)}`)).length;

test('a thread a human paused before the upgrade stays paused under the upgraded watcher, across restarts', async () => {
  const selfKv = memoryKv();
  const bobKv = memoryKv();
  const paused = ulid();
  const open = ulid();
  pausedBeforeUpgrade(selfKv, paused);
  say(bobKv, paused);
  say(bobKv, open);
  assert.deepEqual(await watchOnce(selfKv, bobKv), [open], 'only the thread that was not paused wakes');
  assert.ok(selfKv.rows.has(stateKeys(JULIE).paused('bob', paused)), "the pause is now also at the agent's key");
  say(bobKv, paused);
  assert.deepEqual(await watchOnce(selfKv, bobKv), [], 'after a restart it is still paused');
});

test('`courier resume` of a thread paused before the upgrade resumes it for good, with one inform', async () => {
  const selfKv = memoryKv();
  const bobKv = memoryKv();
  const thread = ulid();
  pausedBeforeUpgrade(selfKv, thread);
  const args = parseArgs(['bob', thread]);
  // The resume is interrupted while removing the markers: a retry must not copy the shared marker back without the
  // saved resume inform id (that would post a second inform).
  selfKv.failDelete = k.paused('bob', thread);
  await assert.rejects(quiet(() => cmdResume(args, deps(selfKv))));
  await quiet(() => cmdResume(args, deps(selfKv)));
  await quiet(() => cmdResume(args, deps(selfKv)));
  assert.equal(selfKv.rows.has(k.paused('bob', thread)), false, 'the shared marker is gone');
  assert.equal(selfKv.rows.has(stateKeys(JULIE).paused('bob', thread)), false);
  assert.equal(informs(selfKv, thread), 1, 'one resumed inform, however many tries');
  say(bobKv, thread);
  assert.deepEqual(await watchOnce(selfKv, bobKv), [thread], "the watcher's first start does not pause it again");
});

test('`courier pause` of a thread paused before the upgrade says it is paused and posts nothing', async () => {
  const selfKv = memoryKv();
  const thread = ulid();
  pausedBeforeUpgrade(selfKv, thread);
  const legacy = selfKv.rows.get(k.paused('bob', thread)).value;
  await quiet(() => cmdPause(parseArgs(['bob', thread]), deps(selfKv)));
  await quiet(() => cmdPause(parseArgs(['bob', thread]), deps(selfKv)));
  assert.deepEqual(selfKv.rows.get(stateKeys(JULIE).paused('bob', thread)).value, legacy, 'the same marker, copied once');
  assert.equal(informs(selfKv, thread), 0);
});
