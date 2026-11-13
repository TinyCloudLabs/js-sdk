// TC-2917 follow-up: a `watch --once` loop starts fresh each run; what the watcher already knows (receipts it has seen,
// mirrored thread meta, when it last read a renewal marker or pruned claims) is kept on this machine, so an idle run
// asks the node only what it must: the state, the pause markers, each peer's listing and the approvals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX } from '../dist/keys.js';

const AGENT = 'did:key:z6MkAgentA';

function countingKv(name, counts) {
  const rows = new Map();
  let sequence = 0;
  const count = (key) => { counts[key] = (counts[key] ?? 0) + 1; };
  return {
    rows,
    async list({ prefix }) { count(`${name} list`); return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } }; },
    async get(key) {
      count(`${name} get`);
      const row = rows.get(key);
      return row ? { ok: true, data: { data: row.value, headers: { etag: row.etag } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async put(key, value, options = {}) {
      count(`${name} put`);
      const prior = rows.get(key);
      if ((options.ifNoneMatch === '*' && prior) || (options.ifMatch && options.ifMatch !== prior?.etag)) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      const etag = `e${++sequence}`;
      rows.set(key, { value: structuredClone(value), etag });
      return { ok: true, data: { data: undefined, headers: { etag } } };
    },
    async delete(key) { count(`${name} delete`); rows.delete(key); return { ok: true, data: undefined }; },
  };
}

function world() {
  const counts = {};
  const selfKv = countingKv('self', counts);
  const peerKv = countingKv('peer', counts);
  const peer = {
    handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x02', courierDid: 'did:key:zBob', spaceId: 'space-bob', theirHandleForMe: 'alice',
    inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, outbound: [], status: 'paired',
  };
  let stored;
  const localCache = { load: () => stored && structuredClone(stored), save: (cache) => { stored = structuredClone(cache); } };
  const once = async () => {
    const watcher = new Watcher({
      selfKv, agent: AGENT, spaceId: 'space-alice', selfHooks: {}, peerHooks: async () => ({}),
      loadPeers: () => [peer], kvFor: async (_peer, renew) => { if (renew !== false) counts['marker get'] = (counts['marker get'] ?? 0) + 1; return peerKv; },
      wake: async () => {}, log: () => {}, localCache,
    }, { debounceMs: 0, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 12 });
    await watcher.run(new AbortController().signal, { once: true });
  };
  const send = (threadId = ulid()) => {
    peerKv.rows.set(`${PREFIX}/to/alice/threads/${threadId}/meta.json`, { value: { threadId, subject: 'S' }, etag: 'm' });
    const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'inform', from: { owner: 'o', agent: 'a' } });
    message.messageId = ulid();
    peerKv.rows.set(`${PREFIX}/to/alice/threads/${threadId}/msg/${message.messageId}.json`, { value: message, etag: 'r' });
    return message.messageId;
  };
  const take = () => { const taken = { ...counts }; for (const key of Object.keys(counts)) delete counts[key]; return taken; };
  return { once, send, take, selfKv, peerKv, localCache };
}

test('an idle `watch --once` after a delivering one asks the node 4 times: state, pause markers, the peer listing, approvals', async (t) => {
  const w = world();
  w.send();
  await w.once(); // delivers, mirrors meta, reads receipts and the renewal marker, prunes claims
  w.take();
  await w.once();
  const idle = w.take();
  t.diagnostic(`idle --once: ${JSON.stringify(idle)}`);
  assert.deepEqual(idle, { 'self get': 1, 'self list': 2, 'peer list': 1 }, 'self: state get, pause list, approvals list; peer: its listing');
});

test('a new message is still delivered, mirrored and receipted by the next run, exactly once', async () => {
  const w = world();
  w.send();
  await w.once();
  const id = w.send();
  await w.once();
  const mirrored = [...w.selfKv.rows.keys()].filter((key) => key.includes('/mirror/') && key.endsWith(`/msg/${id}.json`));
  assert.equal(mirrored.length, 1);
  const receipts = w.selfKv.rows.get(k.receipts('bob')).value;
  assert.ok(Object.values(receipts.threads).some((thread) => thread.delivered.includes(id)));
  w.take();
  await w.once();
  assert.equal(w.take()['peer get'], undefined, 'and not fetched again');
});

test('without the local cache (lost or unreadable) a run just asks again: nothing is skipped wrongly', async () => {
  const w = world();
  w.send();
  await w.once();
  w.localCache.load = () => undefined;
  w.take();
  await w.once();
  const counts = w.take();
  assert.equal(counts['marker get'], 1, 'the renewal marker is read again');
  assert.ok(counts['self get'] >= 2, 'receipts are read again');
});
