import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { Crash, crashAtWrite, homeFile, readHome, scenario } from './support/approval-fixture.mjs';
import { crashBeforeUnlink, readyProfile } from './support/review-fixture.mjs';

// TC-2383: `init --rotate-key` deletes the installed grant.json. The grant stays valid at the node until it expires. The invoking command
// says so; when the process dies after the grant was deleted, the init that finishes the rotation must say it too, from non-secret facts
// (delegation CID, expiry) the journal recorded BEFORE grant.json was removed.

const rotateAndDie = () => cmdInit(parseArgs(['--rotate-key', '--request']));
const NOTICE = /installed grant for the old agent key/;
const BOUNDARIES = [
  { name: 'after rotation.json is written', arm: (t) => crashAtWrite(t, 'rotation.json', { phase: 'after' }) },
  { name: 'after key.json is replaced', arm: (t) => crashAtWrite(t, 'key.json', { phase: 'after' }) },
  { name: 'after profile.json is replaced', arm: (t) => crashAtWrite(t, 'profile.json', { phase: 'after' }) },
  { name: 'after grant.json is removed', arm: (t) => crashBeforeUnlink(t, 'rotation.json', Crash) },
];
const MODES = [['--request'], ['--wait', '--timeout', '1s'], ['--resume'], ['--rotate-key', '--request']];

for (const boundary of BOUNDARIES) {
  scenario(`rotation ${boundary.name}: the journal names the installed grant without any secret`, async (ctx) => {
    const grant = await readyProfile(ctx);
    const crash = boundary.arm(ctx.t);
    await assert.rejects(rotateAndDie(), (error) => error instanceof Crash);
    crash.disarm();
    const text = fs.readFileSync(homeFile('rotation.json'), 'utf8');
    assert.ok(text.includes(grant.delegationCid), 'the CID is journaled');
    assert.equal(text.includes(grant.delegationHeader.Authorization), false);
    assert.equal(text.includes(grant.signature), false);
    assert.equal(text.includes(grant.siwe), false);
  });

  for (const mode of MODES) {
    scenario(`rotation ${boundary.name}: \`init ${mode.join(' ')}\` says the old installed grant may still be valid, with its CID and expiry`, async (ctx) => {
      const grant = await readyProfile(ctx);
      const crash = boundary.arm(ctx.t);
      await assert.rejects(rotateAndDie(), (error) => error instanceof Crash);
      crash.disarm();
      ctx.errors.length = 0; // only what recovery prints counts
      const run = await ctx.courier(...mode);
      assert.match(run.stderr, NOTICE);
      assert.ok(run.stderr.includes(grant.delegationCid), 'the CID is named');
      assert.match(run.stderr, /may still be valid until \d{4}-\d{2}-\d{2}T/);
      assert.match(run.stderr, /cannot revoke/);
      assert.equal(fs.existsSync(homeFile('grant.json')), false);
      assert.equal(fs.existsSync(homeFile('rotation.json')), false);
      ctx.errors.length = 0;
      const again = await ctx.courier('--request');
      assert.doesNotMatch(again.stderr, NOTICE, 'said once');
    });
  }
}

scenario('a rotation interrupted over a profile with no installed grant prints no installed-grant notice', async (ctx) => {
  await readyProfile(ctx);
  fs.rmSync(homeFile('grant.json'));
  const crash = crashAtWrite(ctx.t, 'key.json', { phase: 'after' });
  await assert.rejects(rotateAndDie(), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(readHome('rotation.json').installedGrant, undefined);
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.doesNotMatch(run.stderr, NOTICE);
});
