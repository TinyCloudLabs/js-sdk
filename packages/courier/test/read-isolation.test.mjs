import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectThread, peerReadError, partialReadText } from '../dist/thread.js';
import { collectInbound, commitReceipts, renderInboxText } from '../dist/inbox.js';
import { memoryKv } from './memory-kv.mjs';
import { k } from '../dist/keys.js';
import { putCreate, putMatch } from '../dist/store.js';
import { buildMessage } from '../dist/a2a.js';

const peer = (handle, sessionId) => ({ handle, sessionId, status: 'paired', theirHandleForMe: 'me', inbound: { cid: handle } });
async function message(kv, mailbox, thread, id) {
  const body = buildMessage({ threadId: thread, text: 'available message', role: 'ROLE_USER', intent: 'request' });
  body.messageId = id;
  await putCreate(kv, k.msg(mailbox, thread, id), body);
}
const unavailable = () => { throw new Error('Runtime delegation is expired: PRIVATE_TOKEN'); };

test('known guided thread never activates unrelated or mismatched peer delegations', async () => {
  const selfKv = memoryKv(), remote = memoryKv();
  await message(remote, 'me', 'T', 'M');
  const visited = [];
  const result = await collectThread({ selfKv, threadId: 'T', peers: [peer('expired'), peer('good', 'T'), peer('other', 'OTHER')],
    kvFor: async p => { visited.push(p.handle); if (p.handle !== 'good') unavailable(); return remote; } });
  assert.deepEqual(visited, ['good']);
  assert.equal(result.partial, false);
  assert.deepEqual(result.entries.map(e => [e.peer, e.authority, e.id]), [['good', 'counterparty', 'M']]);
});

for (const mapping of ['outbound', 'mirror']) test(`own ${mapping} records resolve a known thread before remote fallback`, async () => {
  const selfKv = memoryKv(), remote = memoryKv();
  if (mapping === 'outbound') await message(selfKv, 'good', 'T', 'LOCAL');
  else await putCreate(selfKv, k.mirrorMeta('good', 'T'), { threadId: 'T' });
  await message(remote, 'me', 'T', 'REMOTE');
  const visited = [];
  const result = await collectThread({ selfKv, threadId: 'T', peers: [peer('expired'), peer('good')],
    kvFor: async p => { visited.push(p.handle); if (p.handle !== 'good') unavailable(); return remote; } });
  assert.deepEqual(visited, ['good']);
  assert.equal(result.partial, false);
  assert.equal(result.entries.at(-1).peer, 'good');
});

for (const first of [true, false]) test(`unknown-thread fallback preserves healthy data with failing peer ${first ? 'first' : 'last'}`, async () => {
  const selfKv = memoryKv(), remote = memoryKv();
  await message(remote, 'me', 'T', 'M');
  const peers = [peer('expired'), peer('good')];
  if (!first) peers.reverse();
  const result = await collectThread({ selfKv, threadId: 'T', peers,
    kvFor: async p => p.handle === 'good' ? remote : unavailable() });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].peer, 'good');
  assert.equal(result.partial, true);
  assert.deepEqual(result.errors, [peerReadError('expired')]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|Runtime delegation/);
});

test('explicit failed peer retains self entries, reports partial, and never activates other peers', async () => {
  const selfKv = memoryKv();
  await message(selfKv, 'expired', 'T', 'LOCAL');
  const result = await collectThread({ selfKv, threadId: 'T', peers: [peer('expired')], exactPeer: true, kvFor: unavailable });
  assert.deepEqual(result.entries.map(e => [e.peer, e.authority, e.id]), [['expired', 'self', 'LOCAL']]);
  assert.equal(result.partial, true);
});

test('guided mismatch is skipped even with explicit peer', async () => {
  const result = await collectThread({ selfKv: memoryKv(), threadId: 'OTHER', peers: [peer('guided', 'T')], exactPeer: true, kvFor: unavailable });
  assert.deepEqual(result, { entries: [], errors: [], partial: false });
});

test('all unreadable is partial, while a successfully empty scan is clean', async () => {
  const input = { selfKv: memoryKv(), threadId: 'T', peers: [peer('expired')], kvFor: unavailable };
  const failed = await collectThread(input);
  assert.equal(failed.partial, true);
  assert.deepEqual(failed.entries, []);
  const empty = await collectThread({ ...input, kvFor: async () => memoryKv() });
  assert.deepEqual(empty, { entries: [], errors: [], partial: false });
  assert.equal(renderInboxText([], failed.errors), "Inbox may be incomplete: couldn't read messages from expired. Try again later.\n");
  assert.equal(renderInboxText([]), 'Inbox empty.\n');
  assert.match(partialReadText('Thread', failed.errors), /^Thread may be incomplete:/);
});

test('thread and inbox reads plus inbox receipts preserve the running watcher state and its CAS', async () => {
  const selfKv = memoryKv(), remote = memoryKv();
  const state = { v: 1, pending: { active: 'watcher work' } };
  const etag = await putCreate(selfKv, k.watchState, state);
  await message(remote, 'me', 'T', 'M');
  const peers = [peer('good', 'T')];
  const writes = [];
  const put = selfKv.put.bind(selfKv);
  selfKv.put = async (...args) => { writes.push(args[0]); return put(...args); };
  await collectThread({ selfKv, threadId: 'T', peers, kvFor: async () => remote });
  const inbox = await collectInbound({ selfKv, peers, kvFor: async () => remote });
  await commitReceipts(selfKv, inbox.pending);
  assert.deepEqual(writes, [k.receipts('good')]);
  assert.deepEqual(selfKv.rows.get(k.watchState).value, state);
  await putMatch(selfKv, k.watchState, { ...state, stillRunning: true }, etag);
});

test('same message ids on different peers remain separately attributed; foreign-prefix keys are ignored', async () => {
  const selfKv = memoryKv(), a = memoryKv(), b = memoryKv();
  await message(a, 'me', 'T', 'M');
  await message(b, 'me', 'T', 'M');
  await message(b, 'someone-else', 'OTHER', 'BAD');
  const list = b.list.bind(b);
  b.list = async options => { const result = await list(options); result.data.keys.push(k.msg('someone-else', 'OTHER', 'BAD')); return result; };
  const result = await collectThread({ selfKv, threadId: 'T', peers: [peer('a'), peer('b')], kvFor: async p => p.handle === 'a' ? a : b });
  assert.deepEqual(result.entries.map(e => [e.peer, e.id, e.side]), [['a', 'M', 'peer'], ['b', 'M', 'peer']]);
});
