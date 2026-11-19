import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homeFile, scenario, signedGrant, readHome } from './support/approval-fixture.mjs';
import { OWNER_WALLET, readyProfile } from './support/review-fixture.mjs';
import { deriveState } from '../dist/state.js';

// TC-2383: the read-only readers of pending-grant.json and grant.json never follow a symlink and never block on a FIFO. A FIFO with no
// writer blocks a plain read forever, so the FIFO cases run `deriveState` and a rotation in a child process with a deadline.

const mkfifo = (file) => {
  const made = spawnSync('mkfifo', ['-m', '600', file]);
  assert.equal(made.status, 0, 'mkfifo is available');
};

function inChild(code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: process.env, timeout: 8000, encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname,
  });
}

scenario('a FIFO where pending-grant.json belongs does not block deriveState and counts as no saved delegation', async (ctx) => {
  await ctx.request();
  mkfifo(homeFile('pending-grant.json'));
  const run = inChild(`import { deriveState } from './dist/state.js'; process.stdout.write(JSON.stringify(deriveState().inputs.pendingGrant));`);
  assert.equal(run.signal, null, 'not killed by the deadline: the read did not block');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'false');
});

scenario('a FIFO where pending-grant.json belongs does not block a key rotation', async (ctx) => {
  await readyProfile(ctx);
  mkfifo(homeFile('pending-grant.json'));
  const run = inChild(`import { main } from './dist/main.js'; process.exitCode = await main(['init', '--rotate-key', '--request']);`);
  assert.equal(run.signal, null, 'not killed by the deadline');
});

scenario('a symlink where pending-grant.json belongs is not followed: no saved delegation, target untouched', async (ctx) => {
  await readyProfile(ctx);
  const grant = await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET });
  const record = { codeHash: 'c', expiresAt: '2999-01-01T00:00:00.000Z', savedAt: new Date().toISOString(), delegation: grant };
  const target = homeFile('elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ v: 1, records: [record] }), { mode: 0o600 });
  fs.symlinkSync(target, homeFile('pending-grant.json'));
  const bytes = fs.readFileSync(target);
  assert.equal(deriveState().inputs.pendingGrant, false);
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr.includes(grant.delegationCid), false, 'a delegation read through a symlink is not reported');
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal(fs.lstatSync(homeFile('pending-grant.json')).isSymbolicLink(), true);
});

scenario('a symlink to a mode-644 grant is not followed by the loose-grant check or the rotation facts', async (ctx) => {
  const grant = await readyProfile(ctx);
  const target = homeFile('elsewhere-grant.json');
  fs.renameSync(homeFile('grant.json'), target);
  fs.chmodSync(target, 0o644);
  fs.symlinkSync(target, homeFile('grant.json'));
  const derived = deriveState();
  assert.equal(derived.grantMode, undefined, 'a symlink is not a loose grant file');
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr.includes(grant.delegationCid), false, 'the target was not read for the notice');
});
