// TC-2917: an idle intake backs off to 5 minutes (or a longer explicit --interval) and returns to the interval on activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdIntake } from '../dist/intake/intake.js';
import { parseArgs } from '../dist/args.js';

const STOP = new Error('stop');

/**
 * Runs the real intake loop on a simulated clock (seconds, advanced by each sleep) for `cycles` cycles. `queue(i, clock)`
 * is what cycle `i` queues; it may throw like a failing cycle. Returns every sleep in seconds.
 */
async function loop(cycles, queue, flags = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-intake-'));
  const peersFile = path.join(dir, 'peers.json');
  fs.writeFileSync(peersFile, JSON.stringify({ bob: { tier: 'trusted' } }), { mode: 0o600 });
  const slept = [];
  let cycle = 0;
  let clock = 0;
  try {
    await assert.rejects(cmdIntake(parseArgs([
      '--queue-dir', path.join(dir, 'queue'), '--done-dir', path.join(dir, 'done'), '--overflow-dir', path.join(dir, 'overflow'),
      '--state-dir', path.join(dir, 'state'), '--peers-file', peersFile, '--peers-owner', String(process.getuid()), ...flags,
    ]), {
      loadProfile: () => ({ peers: {} }),
      courierNode: async () => ({ kv: {} }),
      reloadPeers: (_file, _owner, last) => last,
      intakeCycle: async () => queue(cycle++, clock),
      sleep: async (ms) => { slept.push(ms / 1000); clock += ms / 1000; if (slept.length === cycles) throw STOP; },
    }), (error) => error === STOP);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return slept;
}

const sleeps = (queued, flags) => loop(queued.length, (i) => { const next = queued[i]; if (typeof next === 'function') next(); return next; }, flags);

test('idle cycles double the wait up to 5 minutes; a queued message returns to the interval at once', async () => {
  assert.deepEqual(await sleeps([0, 0, 0, 0, 0, 2, 0, 1]), [120, 240, 300, 300, 300, 60, 120, 60]);
});

test('an explicit --interval stays the active cadence; idle backs off from it to 5 minutes', async () => {
  assert.deepEqual(await sleeps([1, 0, 0, 0, 3], ['--interval', '120']), [120, 240, 300, 300, 120]);
});

test('an interval longer than 5 minutes is never shortened and never lengthened', async () => {
  assert.deepEqual(await sleeps([0, 0, 1], ['--interval', '600']), [600, 600, 600]);
});

test('a failing cycle backs off like an idle one', async () => {
  const fail = () => { throw new Error('node down'); };
  assert.deepEqual(await sleeps([fail, fail, fail, 1]), [120, 240, 300, 60]);
});

test('a message that arrives during the longest idle wait is queued within 5 minutes, at the default and at --interval 120', async () => {
  for (const flags of [[], ['--interval', '120']]) {
    for (const arrival of [20 * 60, 20 * 60 + 1, 20 * 60 + 299]) { // 20 idle minutes in, at every phase of a 300 s wait
      let picked;
      await loop(30, (_i, clock) => {
        if (picked === undefined && clock >= arrival) { picked = clock; return 1; }
        return 0;
      }, flags);
      assert.ok(picked !== undefined && picked - arrival <= 300, `${flags.join(' ') || 'default'}: queued ${picked - arrival} s after it arrived`);
    }
  }
});
