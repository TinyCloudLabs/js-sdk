// TC-2951: message and thread ids in `courier inbox` come from the peer's key names, which the peer controls. An id
// that is not a safe id is never fetched, listed or receipted; it is reported as `bad-message` with the id escaped, so
// no control or bidi character from a peer reaches the text output or the `--json` output agents read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { collectInbound, renderInboxText } from '../dist/inbox.js';
import { buildMessage } from '../dist/a2a.js';
import { PREFIX } from '../dist/keys.js';

// Characters a terminal or a JSON reader acts on: C0 (incl. newline and ESC), DEL, C1 (incl. U+009B CSI), bidi overrides.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function peerKv() {
  const rows = new Map();
  const fetched = [];
  return {
    rows, fetched,
    async list({ prefix }) { return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } }; },
    async get(key) {
      fetched.push(key);
      const value = rows.get(key);
      return value ? { ok: true, data: { data: value, headers: { etag: 'e' } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async batchGet(keys, options) {
      const results = [];
      for (const key of keys) results.push({ key, result: await this.get(key, options) });
      return { ok: true, data: { results, count: results.length } };
    },
  };
}

const selfKv = { async get() { return { ok: false, error: { status: 404, message: 'not found' } }; } };
const peer = {
  handle: 'bob', ownerDid: 'did:pkh:eip155:1:0x01', courierDid: 'did:key:zbob', spaceId: 'tinycloud:pkh:eip155:1:0x01:agents',
  theirHandleForMe: 'alice', inbound: { delegation: 'wire', cid: 'cid-bob', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  outbound: [], status: 'paired', pairedAt: new Date().toISOString(),
};

/** The peer writes a message under ids of its choosing; the body names the same ids, as a peer can make it. */
function write(kv, threadId, messageId) {
  const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'inform', from: { owner: 'did:pkh:x', agent: 'did:key:zbob' } });
  message.messageId = messageId;
  const key = `${PREFIX}/to/alice/threads/${threadId}/msg/${messageId}.json`;
  kv.rows.set(key, message);
  return key;
}

test('an unsafe message or thread id from a peer is skipped and reported escaped; safe messages are delivered as before', async () => {
  const kv = peerKv();
  const thread = ulid();
  const safe = ulid();
  const hostile = [
    [thread, `${ulid()}\n{"forged":true}`],
    [thread, `${ulid()}\u001b[2J`],
    [thread, `${ulid()}\u009b31m`],
    [`${ulid()}\u202egnp.exe`, ulid()],
  ];
  write(kv, thread, safe);
  const hostileKeys = hostile.map(([threadId, messageId]) => write(kv, threadId, messageId));

  const collection = await collectInbound({ selfKv, peers: [peer], kvFor: async () => kv });

  assert.deepEqual(collection.items.map((item) => item.messageId), [safe], 'only the safe message is listed');
  assert.deepEqual(collection.pending.get('bob'), [{ threadId: thread, messageId: safe }], 'only the safe message is receipted');
  assert.ok(hostileKeys.every((key) => !kv.fetched.includes(key)), 'an unsafe key is never fetched');
  const bad = collection.errors.filter((error) => error.code === 'bad-message');
  assert.equal(bad.length, hostile.length, 'each unsafe id is reported once');
  for (const error of bad) assert.match(error.message, /unsafe id/);

  // Neither output carries a raw unsafe character from a peer.
  const json = JSON.stringify({ items: collection.items.map((item) => ({ authority: 'counterparty', ...item })), errors: collection.errors, partial: true }, null, 2);
  assert.doesNotMatch(json.replace(/\n/g, ''), UNSAFE, '--json output');
  assert.doesNotMatch(json, /"forged"/, 'a newline cannot forge JSON structure');
  for (const error of collection.errors) assert.doesNotMatch(error.message, UNSAFE, 'error text');
  assert.doesNotMatch(renderInboxText(collection.items, collection.errors).replace(/\n/g, ''), UNSAFE, 'text output');
});
