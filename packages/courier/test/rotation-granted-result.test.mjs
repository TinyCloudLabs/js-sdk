import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2383: `init --rotate-key` discards a saved approval (it is bound to the old key) and says so. When the saved approval already
// holds a granted result (`resultEnvelope` collected, or `committed`), a live grant may exist: the warning then also names the revoke
// page. The journal records that fact (non-secret) BEFORE approval-pending.json is deleted, so the warning survives a crash at every
// journal boundary and is printed by whichever init mode finishes the rotation.

const REVOKE = 'https://account.tinycloud.xyz/delegations';
const DISCARD = /discards that approval/;
const LIVE = /live grant may exist/;

const crashBeforeUnlink = (t, file) => {
  const original = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.basename(String(target)) === file) throw new Crash(`before removing ${file}`);
    return original(target, ...rest);
  };
  t.after(() => { fs.unlinkSync = original; });
  return { disarm: () => { fs.unlinkSync = original; } };
};

const BOUNDARIES = [
  { name: 'after rotation.json is written', arm: (t) => crashAtWrite(t, 'rotation.json', { phase: 'after' }) },
  { name: 'after key.json is replaced', arm: (t) => crashAtWrite(t, 'key.json', { phase: 'after' }) },
  { name: 'after profile.json is replaced', arm: (t) => crashAtWrite(t, 'profile.json', { phase: 'after' }) },
  { name: 'after grant.json and approval-pending.json are removed', arm: (t) => crashBeforeUnlink(t, 'rotation.json') },
];
const MODES = [['--request'], ['--wait', '--timeout', '1s'], ['--resume'], ['--rotate-key', '--request']];

async function readyProfile({ t, request, courier }) {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 0);
  fs.rmSync(homeFile('legacy-grant.json'));
  fs.rmSync(homeFile('approval-pending.json'), { force: true });
  assert.equal(loadProfile().status, 'ready');
}

/** A renewal the owner approved, whose encrypted result is saved (`resultEnvelope`), with nothing installed. */
async function resultHeld(ctx) {
  await readyProfile(ctx);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
}

/** The same renewal after the grant was installed: `committed`, only the acknowledgement left. */
async function resultCommitted(ctx) {
  await readyProfile(ctx);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.committed === true });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(readHome('approval-pending.json').committed, true);
}

scenario('rotate-key over a held granted result warns that a live grant may exist and names the revoke page', async (ctx) => {
  await resultHeld(ctx);
  assert.ok(readHome('approval-pending.json').resultEnvelope);
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, DISCARD, 'the existing discard warning stays');
  assert.match(run.stderr, LIVE);
  assert.ok(run.stderr.includes(REVOKE));
  assert.equal(fs.existsSync(homeFile('rotation.json')), false);
});

scenario('rotate-key over a committed approval warns that a live grant may exist and names the revoke page', async (ctx) => {
  await resultCommitted(ctx);
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, DISCARD);
  assert.match(run.stderr, LIVE);
  assert.ok(run.stderr.includes(REVOKE));
});

scenario('rotate-key over a saved approval with no granted result keeps only the existing warning', async (ctx) => {
  await readyProfile(ctx);
  await ctx.request();
  // Only OpenKey has the result (resultRef): nothing was collected here.
  const open = readHome('approval-pending.json');
  fs.writeFileSync(homeFile('approval-pending.json'), JSON.stringify({ ...open, resultRef: 'ref', resultExpiresAt: '2999-01-01T00:00:00.000Z' }), { mode: 0o600 });
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, DISCARD);
  assert.doesNotMatch(run.stderr, LIVE);
  assert.equal(run.stderr.includes(REVOKE), false);
});

scenario('rotate-key over an open request prints no discard or revoke warning', async (ctx) => {
  await readyProfile(ctx);
  await ctx.request();
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, DISCARD);
  assert.equal(run.stderr.includes(REVOKE), false);
});

for (const boundary of BOUNDARIES) {
  scenario(`rotation ${boundary.name} over a granted result: the journal records it without secrets`, async (ctx) => {
    await resultHeld(ctx);
    const crash = boundary.arm(ctx.t);
    await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
    crash.disarm();
    const held = readHome('approval-pending.json');
    const journal = readHome('rotation.json');
    assert.equal(journal.discardApproval, true);
    assert.equal(journal.grantedResult, true);
    const text = fs.readFileSync(homeFile('rotation.json'), 'utf8');
    assert.equal(text.includes(held.relayPrivateKey), false, 'no approval secret in the journal');
    assert.equal(text.includes(JSON.stringify(held.resultEnvelope)), false, 'no encrypted result in the journal');
  });

  for (const mode of MODES) {
    scenario(`rotation ${boundary.name} over a granted result: \`init ${mode.join(' ')}\` prints the live-grant and revoke warning from the journal`, async (ctx) => {
      await resultHeld(ctx);
      const crash = boundary.arm(ctx.t);
      await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
      crash.disarm();
      // The crashed command's own output must not be what carries the warning: only what recovery prints counts.
      ctx.errors.length = 0;
      const run = await ctx.courier(...mode);
      assert.match(run.stderr, DISCARD);
      assert.match(run.stderr, LIVE);
      assert.ok(run.stderr.includes(REVOKE));
      assert.equal(fs.existsSync(homeFile('rotation.json')), false);
      // Once finished, a later init does not repeat it.
      ctx.errors.length = 0;
      const again = await ctx.courier('--request');
      assert.equal(again.stderr.includes(REVOKE), false);
    });
  }

  scenario(`rotation ${boundary.name} over an approval without a granted result: recovery prints no revoke warning`, async (ctx) => {
    await readyProfile(ctx);
    await ctx.request();
    const open = readHome('approval-pending.json');
    fs.writeFileSync(homeFile('approval-pending.json'), JSON.stringify({ ...open, resultRef: 'ref', resultExpiresAt: '2999-01-01T00:00:00.000Z' }), { mode: 0o600 });
    const crash = boundary.arm(ctx.t);
    await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
    crash.disarm();
    assert.equal(readHome('rotation.json').grantedResult, false);
    ctx.errors.length = 0;
    const run = await ctx.courier('--request');
    assert.match(run.stderr, DISCARD);
    assert.equal(run.stderr.includes(REVOKE), false);
  });
}
