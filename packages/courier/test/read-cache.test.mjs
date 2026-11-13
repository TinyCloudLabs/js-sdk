// TC-2917: `courier read` of an unchanged thread fetches no message again; tasks are always fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { clearReadCache, collectThread, diskThreadCache } from '../dist/thread.js';
import { recordAuthorityRefusal } from '../dist/interim-runtime.js';
import { buildMessage, buildTask } from '../dist/a2a.js';
import { k, PREFIX } from '../dist/keys.js';
import { profileDir } from '../dist/profile.js';

function countingKv(calls) {
  const rows = new Map();
  return {
    rows,
    async list({ prefix }) { calls.list++; return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } }; },
    async get(key) {
      calls.get++;
      const row = rows.get(key);
      return row ? { ok: true, data: { data: row, headers: { etag: 'e' } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
  };
}

const AGENT = 'did:key:z6MkAgentA';
const AGENT_DIR = () => path.join(profileDir(), 'read-cache', 'z6MkAgentA');

const peer = {
  handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zBob', spaceId: 'space-bob', theirHandleForMe: 'alice',
  inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(Date.now() + 3600_000).toISOString() }, outbound: [], status: 'paired',
};

function thread(entries) {
  const calls = { list: 0, get: 0 };
  const mine = countingKv(calls);
  const theirs = countingKv(calls);
  const threadId = ulid();
  mine.rows.set(k.threadMeta('bob', threadId), { threadId, subject: 'S' });
  const add = (kv, prefix) => {
    const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'inform', from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid();
    kv.rows.set(`${prefix}/msg/${message.messageId}.json`, message);
  };
  for (let i = 0; i < entries / 2; i++) { add(mine, k.threadRoot('bob', threadId)); add(theirs, `${PREFIX}/to/alice/threads/${threadId}`); }
  theirs.rows.set(`${PREFIX}/to/alice/threads/${threadId}/task/K1.json`, buildTask({ taskId: 'K1', threadId, state: 'TASK_STATE_WORKING' }));
  const self = { courierDid: 'did:key:zAlice', spaceId: 'space-alice' };
  const read = async ({ me = self, them = peer, limits, agent = AGENT } = {}) => {
    const cache = diskThreadCache(agent, threadId, limits);
    const before = { ...calls };
    const result = await collectThread({ threadId, selfKv: mine, peers: [them], exactPeer: true, kvFor: async () => theirs, cache, self: me });
    cache.save();
    return { result, list: calls.list - before.list, get: calls.get - before.get };
  };
  return { threadId, mine, theirs, read, add, self };
}

test('an unchanged 260-entry thread is read again with its two listings and its one task, no message GETs', async (t) => {
  const th = thread(260);
  const first = await th.read();
  assert.equal(first.result.entries.length, 262);
  const again = await th.read();
  t.diagnostic(`first read: ${first.list} lists + ${first.get} gets; unchanged re-read: ${again.list} lists + ${again.get} gets`);
  assert.equal(first.get, 262);
  assert.deepEqual([again.list, again.get], [2, 1], 'only the mutable task is fetched');
  assert.deepEqual(again.result.entries, first.result.entries);
  th.add(th.theirs, `${PREFIX}/to/alice/threads/${th.threadId}`);
  assert.equal((await th.read()).get, 2, 'a new message is fetched once, with the task');
});

test('a task update is always shown; a corrupt or foreign cache file is ignored', async () => {
  const th = thread(4);
  await th.read();
  const key = `${PREFIX}/to/alice/threads/${th.threadId}/task/K1.json`;
  th.theirs.rows.set(key, buildTask({ taskId: 'K1', threadId: th.threadId, state: 'TASK_STATE_COMPLETED' }));
  const task = (await th.read()).result.entries.find((entry) => entry.kind === 'task');
  assert.equal(task.body.status.state, 'TASK_STATE_COMPLETED');
  const file = path.join(AGENT_DIR(), `${th.threadId}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{not json');
  const rebuilt = await th.read();
  assert.equal(rebuilt.result.entries.length, 6);
  assert.equal(rebuilt.get, 6);
});

test('a cached body is shown only for a key the current authorized listing returns, and only for the same peer identity', async () => {
  const th = thread(4);
  await th.read();
  const refused = { list: async () => ({ ok: false, error: { status: 403, message: 'revoked' } }) };
  const cache = diskThreadCache(AGENT, th.threadId);
  const revoked = await collectThread({ threadId: th.threadId, selfKv: th.mine, peers: [peer], exactPeer: true, kvFor: async () => refused, cache, self: th.self });
  assert.equal(revoked.entries.filter((entry) => entry.side === 'peer').length, 0, 'a refused listing shows nothing cached');
  assert.equal(revoked.partial, true);

  // The same handle re-paired to another agent: its same-named keys are fetched from it, never served from the old peer's cache.
  const impostor = { ...peer, courierDid: 'did:key:zMallory', spaceId: 'space-mallory' };
  const replaced = new Map([...th.theirs.rows].map(([key, body]) => [key, { ...body, parts: [{ kind: 'text', text: 'not bob' }] }]));
  const theirs = { list: th.theirs.list, async get(key) { return { ok: true, data: { data: replaced.get(key), headers: { etag: 'e' } } }; } };
  const other = await collectThread({ threadId: th.threadId, selfKv: th.mine, peers: [impostor], exactPeer: true, kvFor: async () => theirs, cache, self: th.self });
  const otherMessages = other.entries.filter((e) => e.side === 'peer' && e.kind === 'msg');
  assert.equal(otherMessages.length, 2);
  for (const entry of otherMessages) assert.equal(entry.body.parts[0].text, 'not bob');
});

test('a re-init (new agent key or new space) and a peer session change start their entries empty', async () => {
  const th = thread(4); // 2 own, 2 peer messages, own meta, peer task
  await th.read();
  assert.equal((await th.read()).get, 1, 'warm: only the task');
  assert.equal((await th.read({ me: { ...th.self, courierDid: 'did:key:zAliceRotated' } })).get, 4, 'a new agent key refetches own meta and messages');
  assert.equal((await th.read({ me: { ...th.self, spaceId: 'space-alice-reinit' } })).get, 4, 'a new own space refetches them too');
  assert.equal((await th.read({ them: { ...peer, sessionId: th.threadId } })).get, 3, 'a peer session change refetches its messages');
  assert.equal((await th.read({ them: { ...peer, courierDid: 'did:key:zBobRotated' } })).get, 3, 'so does a peer key change');
});

test('a peer rewriting or deleting and recreating a message in its own space: read shows the first version, as the mirror does; a deleted key is gone', async () => {
  const th = thread(4);
  const prefix = `${PREFIX}/to/alice/threads/${th.threadId}/msg/`;
  const [key] = [...th.theirs.rows.keys()].filter((name) => name.startsWith(prefix));
  const first = structuredClone(th.theirs.rows.get(key));
  await th.read();
  th.theirs.rows.set(key, { ...first, parts: [{ kind: 'text', text: 'rewritten' }] }); // overwrite in place
  const peerMessage = (result) => result.entries.find((entry) => entry.side === 'peer' && entry.id === first.messageId);
  assert.deepEqual(peerMessage((await th.read()).result).body, first, 'overwrite: the first version, never refetched');
  th.theirs.rows.delete(key); // delete
  assert.equal(peerMessage((await th.read()).result), undefined, 'a deleted key is not shown from the cache');
  th.theirs.rows.set(key, { ...first, parts: [{ kind: 'text', text: 'recreated' }] }); // recreate under the same key
  assert.deepEqual(peerMessage((await th.read()).result).body, first, 'delete-recreate: still the first version');
});

test('each agent has its own cache; revocation and refusal clear it', async () => {
  const th = thread(4);
  await th.read();
  assert.equal((await th.read({ agent: 'did:key:z6MkAgentB' })).get, 6, "another agent of this home does not see agent A's cache");
  assert.ok(fs.existsSync(path.join(profileDir(), 'read-cache', 'z6MkAgentB')));
  clearReadCache();
  assert.equal(fs.existsSync(path.join(profileDir(), 'read-cache')), false);
  await th.read();
  await recordAuthorityRefusal('peer:nobody').catch(() => {}); // the profile transaction may fail here; the cache goes first
  assert.equal(fs.existsSync(path.join(profileDir(), 'read-cache')), false, 'a recorded refusal clears it');
});

test('the cache stays within its byte bound (newest kept) and drops files older than its age bound', async () => {
  const a = thread(4);
  const b = thread(4);
  await a.read();
  const aFile = path.join(AGENT_DIR(), `${a.threadId}.json`);
  const bytes = fs.statSync(aFile).size;
  const earlier = new Date(Date.now() - 10_000);
  fs.utimesSync(aFile, earlier, earlier);
  await b.read({ limits: { now: Date.now(), maxBytes: bytes + 10, maxAgeMs: 3600_000 } }); // room for one file: the older goes
  assert.equal(fs.existsSync(aFile), false);
  assert.ok(fs.existsSync(path.join(AGENT_DIR(), `${b.threadId}.json`)));
  assert.equal((await b.read({ limits: { now: Date.now() + 8 * 86_400_000, maxBytes: 1 << 26, maxAgeMs: 7 * 86_400_000 } })).get, 6, 'a file older than 7 days is not used');
  b.add(b.theirs, `${PREFIX}/to/alice/threads/${b.threadId}`); // something new to save
  await b.read({ limits: { now: Date.now(), maxBytes: 10, maxAgeMs: 3600_000 } });
  assert.equal(fs.existsSync(path.join(AGENT_DIR(), `${b.threadId}.json`)), false, 'a thread larger than the whole bound is not kept');
});
