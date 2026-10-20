import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConsumed, markConsumed } from '../dist/consumed.js';
import { AGENT_GRANT, k } from '../dist/keys.js';

function memoryKv() {
  const rows = new Map();
  return {
    rows,
    calls: [],
    async get(key, options) {
      this.calls.push(options);
      const row = rows.get(key);
      return row
        ? { ok: true, data: { data: row.value, headers: {} } }
        : { ok: false, error: { code: 'KV_NOT_FOUND', message: `Key not found: ${key}` } };
    },
    async put(key, value, o = {}) {
      if (o.ifNoneMatch === '*' && rows.has(key)) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      rows.set(key, { value });
      return { ok: true, data: { data: undefined, headers: {} } };
    },
  };
}

test('the used-marker lives where the courier key has no delete', () => {
  const key = k.approvalUsed('R1');
  const covering = AGENT_GRANT.filter((entry) => entry.service === 'tinycloud.kv' && key.startsWith(entry.path));
  assert.ok(covering.length >= 1);
  for (const entry of covering) assert.ok(!entry.actions.includes('tinycloud.kv/del'), `${entry.path} must not grant del`);
  assert.ok(key.includes('/me/consumed/'));
  const put = covering.some((entry) => entry.actions.includes('tinycloud.kv/put'));
  assert.ok(put, 'the courier key can create the marker');
});

test('unused until marked, then consumed; a second mark is approval-used', async () => {
  const kv = memoryKv();
  assert.equal(await isConsumed(kv, 'R1'), false);
  await markConsumed(kv, 'R1');
  assert.equal(await isConsumed(kv, 'R1'), true);
  await assert.rejects(markConsumed(kv, 'R1'), (e) => e.code === 'approval-used');
});

test('overwriting the marker with other content, even junk, still counts as consumed', async () => {
  const kv = memoryKv();
  await markConsumed(kv, 'R1');
  await kv.put(k.approvalUsed('R1'), '<<not json>>');
  assert.equal(await isConsumed(kv, 'R1'), true);
  await kv.put(k.approvalUsed('R1'), null);
  assert.equal(await isConsumed(kv, 'R1'), true);
  await assert.rejects(markConsumed(kv, 'R1'), (e) => e.code === 'approval-used', 'create-only still refuses');
});

test('anything but a clean key-level 404 fails closed', async () => {
  const answer = (result) => ({ async get() { return result; } });
  const unknown = (e) => e.code === 'approval-state-unknown';
  await assert.rejects(isConsumed(answer({ ok: false, error: { code: 'NETWORK_ERROR', message: 'Failed to get key: 503 - busy' } }), 'R1'), unknown);
  await assert.rejects(isConsumed(answer({ ok: false, error: { status: 500, message: 'boom' } }), 'R1'), unknown);
  await assert.rejects(isConsumed(answer({ ok: false, error: { status: 401, message: 'unauthorized' } }), 'R1'), unknown);
  await assert.rejects(isConsumed(answer({ ok: false, error: { status: 403, message: 'forbidden' } }), 'R1'), unknown);
  await assert.rejects(isConsumed(answer({ ok: false, error: { code: 'KV_NOT_FOUND', message: 'KV 404 - space not found' } }), 'R1'), unknown, 'a missing space is not an unused marker');
  await assert.rejects(isConsumed(answer({ ok: false }), 'R1'), unknown);
  await assert.rejects(isConsumed(answer(undefined), 'R1'), unknown);
  await assert.rejects(isConsumed({ async get() { throw new Error('fetch failed'); } }, 'R1'), unknown);
});

test('the read is fresh: it asks the network, never a cached or replicated answer', async () => {
  const kv = memoryKv();
  const stale = { ok: false, error: { code: 'KV_NOT_FOUND', message: 'Key not found: stale' } };
  // A KV whose default read path serves a stale "missing"; only an explicit network read sees the truth.
  const cachey = {
    async get(key, options) {
      if (options?.source === 'network') return kv.get(key, options);
      return stale;
    },
  };
  await markConsumed(kv, 'R1');
  assert.equal(await isConsumed(cachey, 'R1'), true);
  assert.equal(kv.calls.at(-1).source, 'network');
  assert.equal(kv.calls.at(-1).raw, true, 'the body is never parsed');
  assert.equal('ifNoneMatch' in kv.calls.at(-1) || 'ifMatch' in kv.calls.at(-1), false, 'no etag shortcuts');
  // No in-process memory either: the answer follows the store.
  kv.rows.delete(k.approvalUsed('R1'));
  assert.equal(await isConsumed(cachey, 'R1'), false);
  await markConsumed(kv, 'R1');
  assert.equal(await isConsumed(cachey, 'R1'), true);
});

test('a failed marker write is never reported as consumed', async () => {
  const kv = { async put() { return { ok: false, error: { status: 500, message: 'down' } }; } };
  await assert.rejects(markConsumed(kv, 'R1'), (e) => e.code !== 'approval-used');
});
