import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recoverInterrupted } from '../dist/state.js';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { writeTempIdentity } from './support/lock-identity.mjs';

// TC-2383: `recoverInterrupted` classifies one directory snapshot; only a sidecar whose PID and nonce match its temp reaches the
// identity-aware PID probe. A writer proven dead is scrubbed without a stale warning; an unknown writer is kept and reported.

const PID = 4_999_997;
const NAME = `key.json.${PID}.0a1b2c3d4e5f.tmp`;
const BODY = '{"v":1,"jwk":{"d":"single-probe-secret"}}\n';

/** Answers `answers[n]` (true = running) to the nth probe of PID; counts the probes. */
function probes(t, answers) {
  const real = process.kill;
  const state = { count: 0 };
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal !== 0 || pid !== PID) return real.call(process, pid, signal);
    const alive = answers[Math.min(state.count, answers.length - 1)];
    state.count += 1;
    if (alive) return true;
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });
  return state;
}

scenario('each temp file is probed once per recovery', async (ctx) => {
  const state = probes(ctx.t, [true]);
  await ctx.request();
  fs.writeFileSync(homeFile(NAME), BODY, { mode: 0o600 });
  writeTempIdentity(homeFile(NAME), PID, '0a1b2c3d4e5f');
  recoverInterrupted();
  assert.equal(state.count, 1);
});

scenario('a temp with a live writer is kept and reported', async (ctx) => {
  const state = probes(ctx.t, [true]);
  await ctx.request();
  fs.writeFileSync(homeFile(NAME), BODY, { mode: 0o600 });
  ctx.errors.length = 0;
  writeTempIdentity(homeFile(NAME), PID, '0a1b2c3d4e5f');
  recoverInterrupted();
  assert.equal(fs.readFileSync(homeFile(NAME), 'utf8'), BODY);
  assert.ok(ctx.errors.some((line) => line.includes(NAME)), 'reported');
  assert.equal(state.count, 1);
});

scenario('a temp proven dead is scrubbed and never reported as kept', async (ctx) => {
  const state = probes(ctx.t, [false]);
  await ctx.request();
  fs.writeFileSync(homeFile(NAME), BODY, { mode: 0o600 });
  ctx.errors.length = 0;
  writeTempIdentity(homeFile(NAME), PID, '0a1b2c3d4e5f');
  recoverInterrupted();
  assert.equal(fs.existsSync(homeFile(NAME)), false, 'scrubbed');
  assert.equal(ctx.errors.some((line) => line.includes(NAME)), false);
  assert.equal(state.count, 1);
});
