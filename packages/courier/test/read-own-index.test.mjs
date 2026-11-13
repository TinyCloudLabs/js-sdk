// TC-2917 follow-up, ruling (a): `courier read` knows this agent's own thread entries from a local per-entry record of
// its own writes, so an unchanged read lists only the peer's side. A listing under an hour old makes the record current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { collectThread, diskOwnIndex, diskThreadCache, recordOwnWrite } from '../dist/thread.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX } from '../dist/keys.js';
import { profileDir } from '../dist/profile.js';

const AGENT = 'did:key:z6MkAgentC';
const SELF = { courierDid: AGENT, spaceId: 'space-alice' };
const HOUR = 3600_000;
const peer = {
  handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zBob', spaceId: 'space-bob', theirHandleForMe: 'alice',
  inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(Date.now() + HOUR).toISOString() }, outbound: [], status: 'paired',
};

function countingKv() {
  const calls = { list: 0, get: 0 };
  const rows = new Map();
  return {
    calls, rows,
    async list({ prefix }) { calls.list++; return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } }; },
    async get(key) {
      calls.get++;
      const row = rows.get(key);
      return row ? { ok: true, data: { data: row, headers: { etag: 'e' } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async batchGet(keys, options) {
      const results = [];
      for (const key of keys) results.push({ key, result: await this.get(key, options) });
      return { ok: true, data: { results, count: results.length } };
    },
  };
}

function message(threadId) {
  const body = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'inform', from: { owner: 'o', agent: 'a' } });
  body.messageId = ulid();
  return body;
}

function thread() {
  const mine = countingKv();
  const theirs = countingKv();
  const threadId = ulid();
  const root = k.threadRoot('bob', threadId);
  mine.rows.set(k.threadMeta('bob', threadId), { threadId, subject: 'S' });
  for (let i = 0; i < 3; i++) {
    const own = message(threadId);
    mine.rows.set(k.msg('bob', threadId, own.messageId), own);
    const their = message(threadId);
    theirs.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${their.messageId}.json`, their);
  }
  /** One own write that went through Courier: in the space and in the local record. */
  const send = () => {
    const own = message(threadId);
    const key = k.msg('bob', threadId, own.messageId);
    mine.rows.set(key, own);
    recordOwnWrite(AGENT, SELF.spaceId, threadId, key);
    return own;
  };
  const read = async ({ full = false, now = Date.now(), self = SELF } = {}) => {
    const cache = diskThreadCache(AGENT, threadId, undefined, full);
    const before = { mine: { ...mine.calls }, theirs: { ...theirs.calls } };
    const result = await collectThread({
      threadId, selfKv: mine, peers: [peer], exactPeer: true, kvFor: async () => theirs, cache, self,
      own: diskOwnIndex(AGENT, self.spaceId, threadId, full, now),
    });
    cache.save();
    const delta = (kv, was) => ({ list: kv.calls.list - was.list, get: kv.calls.get - was.get });
    return { result, mine: delta(mine, before.mine), theirs: delta(theirs, before.theirs) };
  };
  return { threadId, root, mine, theirs, send, read };
}

const ids = (result, side) => result.entries.filter((entry) => entry.side === side).map((entry) => `${entry.kind}:${entry.id}`);

test('an unchanged thread is read with one KV call: the peer listing', async () => {
  const th = thread();
  const first = await th.read();
  assert.deepEqual(first.mine, { list: 1, get: 4 }, 'first read lists our own side');
  const again = await th.read();
  assert.deepEqual(again.mine, { list: 0, get: 0 }, 'our own side comes from the local record');
  assert.deepEqual(again.theirs, { list: 1, get: 0 });
  assert.deepEqual(again.result.entries, first.result.entries);
});

test("this agent's own new write shows on the next read without listing our side", async () => {
  const th = thread();
  await th.read();
  const sent = th.send();
  const after = await th.read();
  assert.deepEqual(after.mine, { list: 0, get: 1 }, 'only the new body is fetched');
  assert.ok(ids(after.result, 'me').includes(`msg:${sent.messageId}`));
});

test('a write the record never saw shows within an hour, and at once with --full', async () => {
  const th = thread();
  const t0 = Date.now();
  await th.read({ now: t0 });
  const other = message(th.threadId);
  th.mine.rows.set(k.msg('bob', th.threadId, other.messageId), other); // e.g. a crash between the write and its record
  const inside = await th.read({ now: t0 + HOUR - 1000 });
  assert.equal(inside.mine.list, 0);
  assert.ok(!ids(inside.result, 'me').includes(`msg:${other.messageId}`), 'inside the hour the record is used');
  const full = await th.read({ full: true, now: t0 + 1000 });
  assert.equal(full.mine.list, 1, '--full lists our side');
  assert.ok(ids(full.result, 'me').includes(`msg:${other.messageId}`));
  const later = thread();
  await later.read({ now: t0 });
  const missed = message(later.threadId);
  later.mine.rows.set(k.msg('bob', later.threadId, missed.messageId), missed);
  const expired = await later.read({ now: t0 + HOUR });
  assert.equal(expired.mine.list, 1, 'after an hour our side is listed again');
  assert.ok(ids(expired.result, 'me').includes(`msg:${missed.messageId}`));
  assert.equal((await later.read({ now: t0 + HOUR + 1000 })).mine.list, 0, 'and that listing is current for the next hour');
});

test('a write whose record fails makes the next read list our side', async () => {
  const th = thread();
  await th.read();
  const blocked = message(th.threadId);
  const key = k.msg('bob', th.threadId, blocked.messageId);
  const name = `e-${createHash('sha256').update(`${SELF.spaceId}\n${key}`).digest('hex')}.json`;
  const dir = path.join(profileDir(), 'read-cache', 'z6MkAgentC', 'own', th.threadId);
  fs.mkdirSync(path.join(dir, name)); // the record can't be written there
  th.mine.rows.set(key, blocked);
  recordOwnWrite(AGENT, SELF.spaceId, th.threadId, key);
  const next = await th.read();
  assert.equal(next.mine.list, 1);
  assert.ok(ids(next.result, 'me').includes(`msg:${blocked.messageId}`));
});

test("another space's record is never used: a re-init lists its own side, and its entries never show in this space", async () => {
  const th = thread();
  await th.read();
  const reinit = await th.read({ self: { ...SELF, spaceId: 'space-alice-reinit' } });
  assert.equal(reinit.mine.list, 1);
  const elsewhere = message(th.threadId);
  const key = k.msg('bob', th.threadId, elsewhere.messageId);
  th.mine.rows.set(key, elsewhere);
  recordOwnWrite(AGENT, 'space-alice-reinit', th.threadId, key);
  const here = await th.read();
  assert.equal(here.mine.list, 0);
  assert.ok(!ids(here.result, 'me').includes(`msg:${elsewhere.messageId}`), "the other space's write isn't listed for this one");
});
