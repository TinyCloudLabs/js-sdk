import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Watcher } from '../dist/watch.js';
import { CourierError, isAuthorizationRefusal } from '../dist/errors.js';

function fixture(extra = {}) {
  const calls = { kv: 0, hooks: 0, refusals: [] };
  const kv = new Proxy({}, { get: () => async () => { calls.kv++; throw new Error('network must not run'); } });
  const watcher = new Watcher({
    selfKv: kv, spaceId: 'local-only', selfHooks: {}, peerHooks: async () => { calls.hooks++; return {}; },
    loadPeers: () => [], kvFor: async () => kv, wake: async () => {}, log: () => {},
    onAuthorityRefusal: async source => { calls.refusals.push(source); }, ...extra,
  });
  return { watcher, calls };
}

test('a lapsed owner stops watcher startup before KV, subscriptions or catch-up, including restart', async () => {
  const { watcher, calls } = fixture({ beforePoll: async () => { throw new CourierError('approval-required', 'normal approval required'); } });
  for (let i = 0; i < 2; i++) await assert.rejects(watcher.run(new AbortController().signal), { code: 'approval-required' });
  assert.equal(calls.kv, 0);
  assert.equal(calls.hooks, 0);
});

for (const status of [401, 403]) test(`a ${status} hook refusal terminates its supervisor without retry`, { timeout: 1000 }, async () => {
  const { watcher, calls } = fixture(); let attempts = 0;
  await watcher.supervise('peer:bob:messages', {}, async () => {
    attempts++;
    throw Object.assign(new Error('synthetic refusal'), { meta: { status } });
  }, () => assert.fail('no catch-up event'), new AbortController().signal);
  assert.equal(attempts, 1);
  assert.deepEqual(calls.refusals, ['peer:bob:messages']);
});

test('error messages containing status digits cannot stop automatic access', () => {
  assert.equal(isAuthorizationRefusal(new Error('untrusted message 401 403')), false);
  assert.equal(isAuthorizationRefusal({ code: 'AUTHORIZATION_FAILED', message: 'untrusted' }), false);
  assert.equal(isAuthorizationRefusal({ status: 401 }), true);
});

test('a refused own-state read marks owner authority terminal before the watcher exits', async () => {
  let reads = 0;
  const { watcher, calls } = fixture({ selfKv: { get: async () => { reads++; return { ok: false, error: { status: 403 } }; } } });
  await assert.rejects(watcher.run(new AbortController().signal), { code: '403' });
  assert.equal(reads, 1);
  assert.deepEqual(calls.refusals, ['self']);
});
