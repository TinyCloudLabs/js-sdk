import { wakePrompt } from '../dist/wake.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMessages, validateMessageSelection, renderMessageOutcomes, MESSAGE_READ_LIMIT, MESSAGE_READ_BYTES, MESSAGE_READ_MS } from '../dist/message-read.js';
import { commitReceipts } from '../dist/inbox.js';
import { memoryKv } from './memory-kv.mjs';
import { k } from '../dist/keys.js';
import { putCreate } from '../dist/store.js';
import { buildMessage } from '../dist/a2a.js';
import { parseArgs } from '../dist/args.js';
import { assertKnownFlags } from '../dist/flags.js';

const peer = { handle: 'good', status: 'paired', theirHandleForMe: 'me', inbound: { cid: 'good' } };
async function message(kv, handle, id, text = 'hello') {
  const body = buildMessage({ threadId: 'T', text, role: 'ROLE_USER', intent: 'request' });
  body.messageId = id;
  await putCreate(kv, k.msg(handle, 'T', id), body);
}
const input = (selfKv, remote) => ({ selfKv, threadId: 'T', peer, messageIds: ['M'], kvFor: async () => remote });
const forbid = () => { throw new Error('archive listing/write forbidden'); };

test('exact read retrieves only the requested keys from a 54-message archive and never lists or writes', async () => {
  const self = memoryKv(), remote = memoryKv();
  for (let n = 0; n < 54; n++) await message(remote, 'me', `M${n}`);
  await message(self, 'good', 'M0');
  const calls = [];
  for (const [side, kv] of [['me', self], ['peer', remote]]) {
    const get = kv.get.bind(kv);
    kv.list = kv.put = kv.delete = forbid;
    kv.get = async (key, options) => { calls.push({ side, key, options }); return get(key, options); };
  }
  const result = await collectMessages({ ...input(self, remote), messageIds: ['M0', 'M0'] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.key), [k.msg('good', 'T', 'M0'), k.msg('me', 'T', 'M0')]);
  for (const { options } of calls) {
    assert.equal(options.source, 'network');
    assert.equal(options.prefix, '');
    assert.equal(options.raw, true);
    assert.equal(options.maxResponseBytes, MESSAGE_READ_BYTES);
    assert.equal(options.timeout, MESSAGE_READ_MS);
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.deepEqual(result.outcomes.map(o => o.status), ['found', 'found']);
  assert.deepEqual(result.entries.map(e => [e.peer, e.side, e.id]), [['good', 'me', 'M0'], ['good', 'peer', 'M0']]);
  assert.equal(result.partial, false);
});

test('CLI accepts repeated --message but requires exact peer and safe bounded ids before access', () => {
  const args = parseArgs(['T', '--peer', 'good', '--message', 'M1', '--message', 'M2']);
  assert.doesNotThrow(() => assertKnownFlags('read', args));
  assert.deepEqual(args.all('message'), ['M1', 'M2']);
  for (const [thread, handle, ids] of [['T', undefined, ['M']], ['../T', 'good', ['M']], ['T', 'good', ['../M']],
    ['T', 'true', ['M']], ['T', 'good', ['true']], ['T', 'good', Array(MESSAGE_READ_LIMIT + 1).fill('M')]]) {
    assert.throws(() => validateMessageSelection(thread, handle, ids), /--message|message IDs|Thread/);
  }
});

test('maximum selection performs at most 40 exact reads', async () => {
  const kv = memoryKv();
  let calls = 0;
  const get = kv.get.bind(kv);
  kv.get = async (...args) => { calls++; return get(...args); };
  const result = await collectMessages({ ...input(kv, kv), messageIds: Array.from({ length: MESSAGE_READ_LIMIT }, (_, n) => `M${n}`) });
  assert.equal(calls, MESSAGE_READ_LIMIT * 2);
  assert.equal(result.outcomes.length, MESSAGE_READ_LIMIT * 2);
  assert.equal(result.partial, false);
});

test('known missing keys differ from unreadable spaces and SDK failures contain no payload', async () => {
  const self = memoryKv();
  const remote = { get: async () => ({ ok: false, error: { code: 'SPACE_NOT_FOUND', status: 404, message: 'PRIVATE_TOKEN' } }) };
  const result = await collectMessages(input(self, remote));
  assert.deepEqual(result.outcomes.map(o => o.status), ['missing', 'unreadable']);
  assert.equal(result.partial, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|SPACE_NOT_FOUND/);
});

test('peer activation failure preserves self message and reports a partial peer outcome', async () => {
  const self = memoryKv();
  await message(self, 'good', 'M');
  const result = await collectMessages({ ...input(self, memoryKv()), kvFor: async () => { throw new Error('expired PRIVATE_TOKEN'); } });
  assert.equal(result.entries[0].authority, 'self');
  assert.deepEqual(result.outcomes.map(o => o.status), ['found', 'unreadable']);
  assert.equal(result.partial, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN/);
});

test('mismatched guided session is refused before self or remote access', async () => {
  await assert.rejects(collectMessages({ ...input({ get: forbid }, undefined), peer: { ...peer, sessionId: 'OTHER' }, kvFor: forbid }), /different thread/);
});

test('node size rejection and a response exceeding the byte limit are honest partial outcomes', async () => {
  const self = memoryKv();
  await message(self, 'good', 'M', 'x'.repeat(MESSAGE_READ_BYTES + 1));
  const remote = { get: async () => ({ ok: false, error: { code: 'KV_RESPONSE_TOO_LARGE', message: 'PRIVATE_TOKEN' } }) };
  const result = await collectMessages(input(self, remote));
  assert.deepEqual(result.outcomes.map(o => o.status), ['too-large', 'too-large']);
  assert.equal(result.entries.length, 0);
  assert.equal(result.partial, true);
});

test('a response claiming another identity is never returned as the selected message', async () => {
  const self = memoryKv();
  await message(self, 'good', 'M');
  self.rows.get(k.msg('good', 'T', 'M')).value.contextId = 'OTHER';
  const result = await collectMessages(input(self, memoryKv()));
  assert.equal(result.entries.length, 0);
  assert.deepEqual(result.outcomes.map(o => o.status), ['invalid', 'missing']);
  assert.equal(result.partial, true);
});

test('shared cancellation reaches the SDK get and stops subsequent reads without starting peer activation', async () => {
  const controller = new AbortController();
  let activated = false;
  const self = { get: async (_key, options) => new Promise(resolve => {
    options.signal.addEventListener('abort', () => resolve({ ok: false, error: { code: 'ABORTED' } }), { once: true });
    controller.abort();
  }) };
  const result = await collectMessages({ ...input(self, undefined), messageIds: ['M', 'N'], signal: controller.signal,
    kvFor: async () => { activated = true; throw new Error('unexpected'); } });
  assert.equal(activated, false);
  assert.deepEqual(result.outcomes.map(o => o.status), ['timed-out', 'timed-out', 'timed-out', 'timed-out']);
  assert.equal(result.partial, true);
});

test('receipt failure stderr is static and strips malicious label controls', async () => {
  const original = console.error;
  const lines = [];
  console.error = line => lines.push(line);
  try {
    await commitReceipts({ get: async () => { throw new Error('PRIVATE_TOKEN\u001b[2J'); } }, new Map([['bad\u001b[2J', [{ threadId: 'T', messageId: 'M' }]]]));
  } finally { console.error = original; }
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /PRIVATE_TOKEN|\u001b/);
  assert.match(lines[0], /Couldn't update delivery receipts for bad/);
});

test('wake prompt splits event message ids into bounded exact reads and preserves every id', () => {
  const messages = Array.from({ length: MESSAGE_READ_LIMIT + 1 }, (_, n) => ({ messageId: `M${n}`, intent: 'request' }));
  const prompt = wakePrompt({ peer: 'good', threadId: 'T', subject: 'S', messages }, 'owner');
  const commands = [...prompt.matchAll(/`courier read [^`]+`/g)].map(match => match[0]);
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.match(command, /--peer good/);
    assert.ok([...command.matchAll(/--message /g)].length <= MESSAGE_READ_LIMIT);
  }
  assert.equal(commands.join(' ').match(/--message /g).length, messages.length);
});

test('outcome text names each side and makes failures readable', () => {
  const statuses = ['found', 'missing', 'unreadable', 'too-large', 'timed-out', 'invalid'];
  const text = renderMessageOutcomes('good', statuses.map((status, n) => ({ messageId: `M${n}`, side: n ? 'peer' : 'me', status })));
  assert.equal(text, "M0 (yours): found\nM1 (good's): not found\nM2 (good's): couldn't read\nM3 (good's): too large (over 64 KiB)\nM4 (good's): timed out\nM5 (good's): not a valid message\n");
});

test('deep response data cannot make final JSON serialization discard healthy messages', async () => {
  const raw = '{"contextId":"T","messageId":"M","extra":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}';
  const self = { get: async () => ({ ok: true, data: { data: raw } }) };
  const remote = memoryKv();
  await message(remote, 'me', 'M');
  const result = await collectMessages(input(self, remote));
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(result.entries.map(entry => entry.side), ['peer']);
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['invalid', 'found']);
  assert.equal(result.partial, true);
});
