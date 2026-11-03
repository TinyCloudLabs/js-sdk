import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { snapshot } from './support/review-fixture.mjs';

// TC-2383: a key-bearing temp file is `<file>.<pid>.<12 hex>.tmp`, written by `writeSecure` for key.json, rotation.json and
// approval-pending.json (which holds `relayPrivateKey` and the encrypted result). The scrub removes one only when the process that
// named it is gone: between the writer's fsync and its rename the file is live, and zeroing it would let the writer install an empty key.

const HEX = '0a1b2c3d4e5f';
const DEAD = 4_999_991;
const LIVE_UNREADABLE = 4_999_992; // exists, but belongs to someone else: kill(pid, 0) answers EPERM
const LIVE = 4_999_993;
const FILES = ['key.json', 'rotation.json', 'approval-pending.json'];
const BODY = '{"v":1,"secret":"stray-temp-secret-0123456789abcdef"}\n';

/** `process.kill(pid, 0)` answers as a real process table would for the three fake pids; every other call is the real one. */
function fakeProcessTable(t) {
  const real = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0 && pid === DEAD) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    if (signal === 0 && pid === LIVE_UNREADABLE) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    if (signal === 0 && pid === LIVE) return true;
    return real.call(process, pid, signal);
  });
}

const plant = (file, pid) => {
  const name = `${file}.${pid}.${HEX}.tmp`;
  fs.writeFileSync(homeFile(name), BODY, { mode: 0o600 });
  return name;
};

for (const file of FILES) {
  for (const pid of [LIVE, LIVE_UNREADABLE]) {
    scenario(`a ${file} temp file of a live writer (pid ${pid === LIVE ? 'alive' : 'EPERM'}) is left exactly as it is by init --request`, async (ctx) => {
      fakeProcessTable(ctx.t);
      await ctx.request();
      const name = plant(file, pid);
      const stray = fs.readFileSync(homeFile(name));
      const before = snapshot()[name];
      ctx.errors.length = 0;
      const run = await ctx.courier('--request');
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(fs.readFileSync(homeFile(name)), stray, 'not zeroed');
      assert.deepEqual(snapshot()[name], before, 'not removed, mode unchanged');
      assert.ok(run.stderr.includes(name) && run.stderr.includes(String(pid)), `the skipped file and its pid are reported: ${run.stderr}`);
    });
  }

  scenario(`a ${file} temp file whose writer is gone is zeroed and removed by init --request`, async (ctx) => {
    fakeProcessTable(ctx.t);
    await ctx.request();
    const name = plant(file, DEAD);
    const run = await ctx.courier('--request');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fs.existsSync(homeFile(name)), false);
  });
}

scenario('a temp file named for this very process is stale (one writeSecure finishes before another starts) and is removed', async (ctx) => {
  await ctx.request();
  const name = plant('approval-pending.json', process.pid);
  const run = await ctx.courier('--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fs.existsSync(homeFile(name)), false);
});

scenario('a temp file of a live writer keeps cleanTemp false and is never what a later init removes while the writer lives', async (ctx) => {
  fakeProcessTable(ctx.t);
  await ctx.request();
  const name = plant('key.json', LIVE);
  const { deriveState } = await import('../dist/state.js');
  assert.equal(deriveState().cleanTemp, false);
  for (const argv of [['--wait', '--timeout', '1s'], ['--request']]) await ctx.courier(...argv);
  assert.equal(fs.readFileSync(homeFile(name), 'utf8'), BODY);
});

scenario('an approval-pending.json temp file that is a hard link or a symlink is refused, not overwritten', async (ctx) => {
  fakeProcessTable(ctx.t);
  await ctx.request();
  const victim = homeFile('victim.json');
  fs.writeFileSync(victim, '{"keep":"this content"}', { mode: 0o600 });
  fs.linkSync(victim, homeFile(`approval-pending.json.${DEAD}.${HEX}.tmp`));
  const before = snapshot();
  const run = await ctx.courier('--request');
  assert.notEqual(run.code, 0, run.stderr);
  assert.deepEqual(snapshot(), before);
});
