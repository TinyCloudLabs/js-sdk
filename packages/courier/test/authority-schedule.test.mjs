// TC-2917 ruling: idle revocation detection and sibling cleanup take up to 300 s; the scheduled check runs at the
// first cycle at or after 300 s since the last one, never before.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Watcher } from '../dist/watch.js';
import { memoryKv } from './memory-kv.mjs';

const START = Date.parse('2026-11-13T12:00:00.000Z');

async function flush() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advanceTo(ms) {
  while (Date.now() - START < ms) { mock.timers.tick(1000); await flush(); }
}

test('the scheduled authority check: at startup, none at 299 s, one at the first cycle at or after 300 s, then every 300 s', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const checks = [];
  const idle = { subscribe: (_subs, { signal }) => ({ async *[Symbol.asyncIterator]() { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); } }) };
  const watcher = new Watcher({
    selfKv: memoryKv(), spaceId: 's', selfHooks: idle, peerHooks: async () => idle, loadPeers: () => [], kvFor: async () => memoryKv(),
    checkAuthority: async (handle) => { if (handle === undefined) checks.push(Date.now() - START); },
    wake: async () => {}, log: () => {}, now: () => Date.now(),
  }, { debounceMs: 30_000, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 12 });
  const stop = new AbortController();
  const running = watcher.run(stop.signal);
  try {
    await flush();
    await advanceTo(299_000);
    assert.deepEqual(checks, [0], 'only the startup check before 300 s');
    await advanceTo(303_000);
    assert.deepEqual(checks, [0, 302_000], 'the cycle at 302 s (the first at or after 300 s) checks');
    await advanceTo(605_000);
    assert.deepEqual(checks, [0, 302_000, 602_000]);
  } finally {
    stop.abort();
    await flush();
    await running;
    mock.timers.reset();
  }
});
