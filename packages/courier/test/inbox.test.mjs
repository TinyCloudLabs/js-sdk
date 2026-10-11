import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectInbound, commitReceipts, selectUndelivered, renderInboxText } from '../dist/inbox.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX, EXT } from '../dist/keys.js';

function memoryKv({ failList = false } = {}) {
  const rows = new Map();
  let sequence = 0;
  const valueResponse = (value, etag) => ({ data: value, headers: { etag } });
  return {
    rows,
    async list({ prefix }) {
      if (failList) throw new Error('peer list unavailable');
      return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async get(key) {
      const row = rows.get(key);
      return row
        ? { ok: true, data: valueResponse(row.value, row.etag) }
        : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async put(key, value, options = {}) {
      const prior = rows.get(key);
      if (options.ifNoneMatch === '*' && prior) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      if (options.ifMatch && options.ifMatch !== prior?.etag) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      const etag = `e${++sequence}`;
      rows.set(key, { value: structuredClone(value), etag });
      return { ok: true, data: valueResponse(undefined, etag) };
    },
  };
}

function peer(handle, theirHandleForMe = 'alice') {
  return {
    handle,
    ownerDid: 'did:pkh:eip155:1:0x01',
    courierDid: 'did:key:zPeer',
    spaceId: 'tinycloud:pkh:eip155:1:0x01:agents',
    theirHandleForMe,
    inbound: { delegation: 'wire', cid: `cid-${handle}`, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    outbound: [],
    status: 'paired',
    pairedAt: new Date().toISOString(),
  };
}

function putMessage(kv, handle, threadId, messageId, text = 'hello') {
  const message = buildMessage({
    threadId,
    text,
    role: 'ROLE_USER',
    from: { owner: 'did:pkh:owner', agent: 'did:key:agent' },
    intent: 'request',
  });
  message.messageId = messageId;
  const key = `${PREFIX}/to/${handle}/threads/${threadId}/msg/${messageId}.json`;
  kv.rows.set(key, { value: message, etag: 'remote' });
  return key;
}

test('older late ULIDs remain undelivered when newer IDs were seen', () => {
  const keys = [
    `${PREFIX}/to/alice/threads/T/msg/01OLDER.json`,
    `${PREFIX}/to/alice/threads/T/msg/01NEWER.json`,
  ];
  const receipts = { v: 1, threads: { T: { delivered: ['01NEWER'], lastDelivered: '01NEWER' } } };
  assert.deepEqual(selectUndelivered(keys, receipts), [{ key: keys[0], threadId: 'T', messageId: '01OLDER' }]);
});

test('collection isolates peer errors and performs no writes before delivery', async () => {
  const selfKv = memoryKv();
  const goodKv = memoryKv();
  const brokenKv = memoryKv({ failList: true });
  putMessage(goodKv, 'alice', 'T1', 'M1');
  const result = await collectInbound({
    selfKv,
    peers: [peer('alice'), peer('broken')],
    kvFor: async (entry) => entry.handle === 'alice' ? goodKv : brokenKv,
  });
  assert.deepEqual(result.items.map((item) => item.messageId), ['M1']);
  assert.equal(result.items[0].peer, 'alice');
  assert.equal(result.errors[0].peer, 'broken');
  assert.equal(selfKv.rows.size, 0);
  await commitReceipts(selfKv, result.pending);
  assert.deepEqual([...selfKv.rows.keys()], [k.receipts('alice')]);
  const saved = selfKv.rows.get(k.receipts('alice')).value;
  assert.deepEqual(saved.threads.T1.delivered, ['M1']);
  assert.equal(selfKv.rows.has(k.receipts('broken')), false);
});

test('collection skips message/key identity mismatches', async () => {
  const selfKv = memoryKv();
  const remote = memoryKv();
  const key = putMessage(remote, 'alice', 'T1', 'M1');
  remote.rows.get(key).value.contextId = 'other-thread';
  const result = await collectInbound({ selfKv, peers: [peer('alice')], kvFor: async () => remote });
  assert.deepEqual(result.items, []);
  assert.equal(result.pending.size, 0);
});

test('receipt CAS retries and merges concurrent deliveries', async () => {
  const selfKv = memoryKv();
  const key = k.receipts('alice');
  selfKv.rows.set(key, {
    value: { v: 1, threads: { T1: { delivered: ['M0'], lastDelivered: 'M0' } } },
    etag: 'e0',
  });
  const put = selfKv.put.bind(selfKv);
  let conflict = true;
  selfKv.put = async (target, value, options = {}) => {
    if (target === key && options.ifMatch && conflict) {
      conflict = false;
      selfKv.rows.set(key, {
        value: { v: 1, threads: { T1: { delivered: ['M0', 'M1'], lastDelivered: 'M1' } } },
        etag: 'concurrent',
      });
      return { ok: false, error: { status: 412, message: 'precondition failed' } };
    }
    return put(target, value, options);
  };
  await commitReceipts(selfKv, new Map([['alice', [{ threadId: 'T1', messageId: 'M2' }]]]));
  assert.deepEqual(selfKv.rows.get(key).value.threads.T1.delivered, ['M0', 'M1', 'M2']);
});

test('malformed counterparty metadata is isolated and still delivered', async () => {
  const selfKv = memoryKv();
  const aliceKv = memoryKv();
  const carolKv = memoryKv();
  const malformedKey = putMessage(aliceKv, 'alice', 'T1', 'M1');
  aliceKv.rows.get(malformedKey).value.metadata[EXT].asks = 'x';
  putMessage(aliceKv, 'alice', 'T1', 'M3');
  putMessage(carolKv, 'alice', 'T1', 'M2');
  const result = await collectInbound({
    selfKv,
    peers: [peer('alice'), peer('carol')],
    kvFor: async (entry) => entry.handle === 'alice' ? aliceKv : carolKv,
  });
  assert.deepEqual(result.items.map((item) => item.messageId), ['M1', 'M3', 'M2']);
  assert.equal(result.items.find((item) => item.messageId === 'M1').asks, undefined);
  assert.ok(result.errors.some((error) => error.peer === 'alice' && error.code === 'bad-message' && /M1.*asks/.test(error.message)));
  assert.deepEqual(result.pending.get('alice').map((delivery) => delivery.messageId), ['M1', 'M3']);
  assert.deepEqual(result.pending.get('carol').map((delivery) => delivery.messageId), ['M2']);
  const text = renderInboxText(result.items);
  assert.match(text, /M1/);
  assert.match(text, /M2/);
  assert.match(text, /COUNTERPARTY DATA/);
});

test('text rendering strips terminal control sequences', () => {
  const text = renderInboxText([{
    peer: 'alice',
    threadId: 'T1',
    messageId: 'M1',
    from: { owner: 'did:pkh:o', agent: 'did:key:a', label: 'label\u001b[2J\u202E' },
    intent: 'request',
    asks: [{ id: 'a1', title: '\u001b[2J\u202Ehi' }],
    text: 'line1\u001b]0;x\u0007\nline2',
  }]);
  assert.doesNotMatch(text, /\u001b|\u0007|\u202e/i);
  assert.match(text, /line1/);
});

test('non-object message bodies are skipped, not fatal', async () => {
  const selfKv = memoryKv();
  const remote = memoryKv();
  const invalidKey = putMessage(remote, 'alice', 'T1', 'M1');
  remote.rows.get(invalidKey).value = 'str';
  putMessage(remote, 'alice', 'T1', 'M2');
  const result = await collectInbound({ selfKv, peers: [peer('alice')], kvFor: async () => remote });
  assert.deepEqual(result.items.map((item) => item.messageId), ['M2']);
  assert.deepEqual(result.pending.get('alice').map((delivery) => delivery.messageId), ['M2']);
  assert.deepEqual(result.errors, []);
});
