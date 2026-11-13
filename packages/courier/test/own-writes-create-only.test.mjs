// TC-2917: `courier read` shows the first version of a message it read (messages are create-only). Courier's own message
// and thread-meta writes are therefore enforced create-only (put-if-absent): it never overwrites a message it wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage } from '../dist/commands.js';
import { postPausedInform } from '../dist/pause.js';
import { memoryKv } from './memory-kv.mjs';

const profile = { ownerDid: 'did:pkh:eip155:1:0x01', courierDid: 'did:key:z6MkAgentA', label: 'A', peers: {} };
const peer = { handle: 'bob', status: 'paired', courierDid: 'did:key:zBob', spaceId: 'space-bob', outbound: [] };

function recordingKv() {
  const kv = memoryKv();
  const puts = [];
  const put = kv.put.bind(kv);
  kv.put = async (key, value, options = {}) => { puts.push({ key, options }); return put(key, value, options); };
  return { kv, puts };
}

test('send writes the message and a new thread meta put-if-absent', async () => {
  const { kv, puts } = recordingKv();
  const msg = await sendMessage({ kv }, profile, 'bob', peer, {
    which: 'new', threadId: '01J00000000000000000000001', subject: 'S', text: 'hi', intent: 'inform', asks: [], constraints: [], inReplyTo: null, referenceTaskIds: [],
  });
  const writes = puts.filter(({ key }) => key.endsWith('/meta.json') || key.endsWith(`/msg/${msg.messageId}.json`));
  assert.equal(writes.length, 2);
  for (const { key, options } of writes) assert.equal(options.ifNoneMatch, '*', `${key} is create-only`);
});

test('an inform retried under the same id never overwrites the message already written', async () => {
  const { kv, puts } = recordingKv();
  const id = '01J00000000000000000000002';
  await postPausedInform(kv, profile, 'bob', 'T1', 'first', id);
  await postPausedInform(kv, profile, 'bob', 'T1', 'second', id);
  const key = [...kv.rows.keys()].find((name) => name.endsWith(`/msg/${id}.json`));
  assert.equal(kv.rows.get(key).value.parts[0].text, 'first');
  for (const { options } of puts.filter((p) => p.key === key)) assert.equal(options.ifNoneMatch, '*');
});
