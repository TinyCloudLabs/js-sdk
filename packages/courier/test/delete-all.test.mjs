// A node can answer a prefix list with one truncated page; unpair cleanup must keep listing until the prefix is empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteAll } from '../dist/store.js';
import { memoryKv } from './memory-kv.mjs';

function pagedKv(pageSize) {
  const kv = memoryKv();
  const list = kv.list.bind(kv);
  kv.list = async (options) => {
    const result = await list(options);
    const keys = result.data.keys;
    return { ok: true, data: { keys: keys.slice(0, pageSize), truncated: keys.length > pageSize } };
  };
  return kv;
}

test('deleteAll removes every key under the prefix across truncated pages and leaves siblings', async () => {
  const kv = pagedKv(2);
  for (let i = 0; i < 5; i++) await kv.put(`peers/bob/${i}`, i);
  await kv.put('peers/bobby/keep', 1);
  assert.equal(await deleteAll(kv, 'peers/bob/'), true);
  assert.deepEqual([...kv.rows.keys()], ['peers/bobby/keep']);
});

test('deleteAll reports incomplete cleanup when keys survive every pass', async () => {
  const kv = pagedKv(1);
  for (let i = 0; i < 3; i++) await kv.put(`peers/bob/${i}`, i);
  assert.equal(await deleteAll(kv, 'peers/bob/', 2), false);
  assert.deepEqual([...kv.rows.keys()], ['peers/bob/2']);
});

test('deleteAll refuses a listed key outside the prefix without deleting it', async () => {
  const kv = memoryKv();
  await kv.put('peers/alice/x', 1);
  kv.list = async () => ({ ok: true, data: { keys: ['peers/alice/x'] } });
  await assert.rejects(deleteAll(kv, 'peers/bob/'), { code: 'bad-mailbox' });
  assert.equal(kv.rows.has('peers/alice/x'), true);
});
