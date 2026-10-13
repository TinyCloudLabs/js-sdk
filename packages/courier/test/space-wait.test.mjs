import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grant from '../dist/grant.js';
import { setProgramName } from '../dist/program.js';

function clock(timeoutMs) {
  let elapsed = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => elapsed,
    options: {
      timeoutMs,
      now: () => elapsed,
      sleep: async (ms) => {
        assert.ok(ms > 0);
        sleeps.push(ms);
        elapsed += ms;
        assert.ok(elapsed <= timeoutMs);
      },
    },
  };
}

test('space wait returns ready on the third probe after two sleeps', async () => {
  const fake = clock(20_000);
  let probes = 0;
  const waits = [];
  assert.equal(await grant.waitForSpaceReady(async () => ++probes === 3, {
    ...fake.options, onWait: (elapsed) => waits.push(elapsed),
  }), true);
  assert.equal(probes, 3);
  assert.deepEqual(fake.sleeps, [2000, 3000]);
  assert.deepEqual(waits, [0, 2000]);
});

test('space wait times out and probes once more at the deadline', async () => {
  const fake = clock(7000);
  const probes = [];
  assert.equal(await grant.waitForSpaceReady(async () => { probes.push(fake.now()); return false; }, fake.options), false);
  assert.deepEqual(probes, [0, 2000, 5000, 7000]);
  assert.equal(fake.now(), 7000);
});

test('space wait accepts readiness on the final deadline probe', async () => {
  const fake = clock(2500);
  assert.equal(await grant.waitForSpaceReady(async () => fake.now() === 2500, fake.options), true);
  assert.deepEqual(fake.sleeps, [2000, 500]);
});

test('space wait propagates authentication and network probe errors', async () => {
  for (const error of [new Error('Unauthorized'), new Error('Connection refused')]) {
    const fake = clock(20_000);
    let probes = 0;
    await assert.rejects(grant.waitForSpaceReady(async () => {
      if (++probes === 2) throw error;
      return false;
    }, fake.options), (actual) => actual === error);
    assert.deepEqual(fake.sleeps, [2000]);
  }
});

test('default schedule increases, caps at 15 seconds and ends at 150 seconds', async () => {
  const fake = clock(150_000);
  const probes = [];
  const { timeoutMs, ...options } = fake.options;
  assert.equal(await grant.waitForSpaceReady(async () => { probes.push(fake.now()); return false; }, options), false);
  assert.deepEqual(fake.sleeps, [2000, 3000, 5000, 8000, 13000, ...Array(7).fill(15000), 14000]);
  assert.ok(fake.sleeps.slice(0, -1).every((ms, i, delays) => ms <= 15000 && (i === 0 || ms >= delays[i - 1])));
  assert.equal(probes.at(-1), 150_000);
});

test('space wait supports injected delays and counts probe time toward the deadline', async () => {
  const fake = clock(100);
  assert.equal(await grant.waitForSpaceReady(async () => {
    await fake.options.sleep(20);
    return false;
  }, { ...fake.options, delaysMs: [10, 30] }), false);
  assert.deepEqual(fake.sleeps, [20, 10, 20, 30, 20]);
});

test('pending space error preserves no-space and gives resume and retry guidance', () => {
  for (const prog of ['courier', 'tc courier']) {
    setProgramName(prog);
    try {
      const error = grant.pendingSpaceError({ host: 'https://node.example' });
      assert.equal(error.code, 'no-space');
      assert.equal(error.message, `OpenKey is still setting up your TinyCloud "agents" space on https://node.example. This can take a few minutes. Run \`${prog} init --resume\` shortly; no new approval is needed. If it still isn't ready after a few minutes, run \`${prog} init\` to approve again, and OpenKey will retry the setup.`);
    } finally {
      setProgramName('courier');
    }
  }
});

test('missing space error names the TinyCloud CLI Courier runs inside', () => {
  for (const [prog, cli] of [['courier', 'tc'], ['tc courier', 'tc'], ['tinycloud courier', 'tinycloud']]) {
    setProgramName(prog);
    try {
      const error = grant.noSpaceError({ host: 'https://node.example' });
      assert.equal(error.code, 'no-space');
      assert.equal(error.message, `Your TinyCloud "agents" space is not set up on https://node.example, so the approved grant can't be used yet. Courier will not create it. If OpenKey auto-sign didn't host it, sign in once at the Share view (https://share.tinycloud.xyz) or, from a wallet profile, run \`${cli} space host agents\`. Then run \`${prog} init --resume\`. No new approval is needed.`);
    } finally {
      setProgramName('courier');
    }
  }
});
