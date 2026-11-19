import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deriveState } from '../dist/state.js';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { readyProfile, snapshot } from './support/review-fixture.mjs';

// TC-2383: a valid grant.json whose mode is loose is a saved grant that cannot be used until its mode is fixed. It is never counted as
// absent (which would let a renewal overwrite it) and never overwritten: the command stops with `profile-permissions` and chmod advice.

for (const argv of [['--request'], ['--wait', '--timeout', '1s'], ['--resume']]) {
  scenario(`a valid grant.json at mode 644 stops \`init ${argv.join(' ')}\` with profile-permissions and chmod 600, changing no file`, async (ctx) => {
    await readyProfile(ctx);
    fs.chmodSync(homeFile('grant.json'), 0o644);
    const before = snapshot();
    ctx.errors.length = 0;
    const run = await ctx.courier(...argv);
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /\[profile-permissions\]/);
    assert.match(run.stderr, /grant\.json/);
    assert.match(run.stderr, /chmod 600/);
    assert.deepEqual(snapshot(), before, 'no file was created, replaced or repaired');
    assert.equal(fs.existsSync(homeFile('approval-pending.json')), false, 'no renewal request was made');
  });
}

scenario('a valid grant.json at mode 644 is not classified as absent, and is not reported as corrupt', async (ctx) => {
  await readyProfile(ctx);
  fs.chmodSync(homeFile('grant.json'), 0o644);
  const derived = deriveState();
  assert.equal(derived.inputs.grant, true);
  assert.notEqual(derived.state, 'grant-missing');
  assert.deepEqual(derived.notes, [], 'a loose mode is not a corrupt or unusable grant');
});

scenario('chmod 600 brings the grant back: the same command then goes on', async (ctx) => {
  await readyProfile(ctx);
  fs.chmodSync(homeFile('grant.json'), 0o644);
  assert.equal((await ctx.courier('--request')).code, 1);
  fs.chmodSync(homeFile('grant.json'), 0o600);
  const run = await ctx.courier('--request');
  assert.equal(run.code, 0, run.stderr);
});
