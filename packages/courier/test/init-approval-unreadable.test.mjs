import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile } from '../dist/profile.js';
import { Crash, crashAtWrite, fakeTime, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe } from './support/approval-fixture.mjs';

// A saved approval that cannot be read (wrong mode, no permission, corrupt JSON) must never be overwritten by the commands that
// write the record: `--wait` and `--request` stop with an error that names the file, and a fix of the mode brings the approval back.

const requestId = (link) => new URL(link).pathname.split('/')[2];

/** An approved request whose encrypted result is saved (the process was killed right after saving it). */
async function heldApproval({ t, fx, request }) {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  return printed;
}

for (const mode of [0o644, 0o000]) {
  for (const command of [['--wait'], ['--request']]) {
    scenario(`a held approval at mode ${mode.toString(8).padStart(3, '0')} stops \`init ${command[0]}\`: file named, nothing overwritten, chmod 600 brings it back`, async (ctx) => {
      const { fx, courier } = ctx;
      const printed = await heldApproval(ctx);
      fakeTime(ctx.t); // a command that wrongly made a new request would poll for a minute; keep that failure fast
      const before = fs.readFileSync(homeFile('approval-pending.json'));
      fs.chmodSync(homeFile('approval-pending.json'), mode);
      const run = await courier(...command);
      assert.equal(run.code, 1);
      assert.match(run.stderr, /approval-pending\.json/);
      assert.match(run.stderr, /chmod 600/);
      assert.equal(fx.created.length, 1, 'no new request was made');
      fs.chmodSync(homeFile('approval-pending.json'), 0o600);
      assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), before, 'the saved approval is byte-identical');
      const fixed = await courier('--wait');
      assert.equal(fixed.code, 0, fixed.stderr);
      assert.equal(fx.acks.length, 1);
      assert.equal(requestId(printed.openkeyUrl), fx.created[0].id);
    });
  }
}

scenario('a corrupt approval-pending.json is renamed aside (0600) with a note, and the command continues with a new request', async ({ fx, request, courier }) => {
  await request();
  fs.writeFileSync(homeFile('approval-pending.json'), '{ not json', { mode: 0o600 });
  const run = await courier('--request');
  assert.equal(run.code, 0, run.stderr);
  const aside = fs.readdirSync(process.env.COURIER_HOME).filter((name) => name.startsWith('approval-pending.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.statSync(homeFile(aside[0])).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(homeFile(aside[0]), 'utf8'), '{ not json');
  assert.match(run.stderr, /approval-pending\.json\.corrupt-/);
  assert.equal(readHome('approval-pending.json').version, 1);
  assert.equal(fx.created.length, 2);
});

scenario('the discard hint says exactly what --rotate-key does: clears every pairing, deletes grant.json, back to awaiting-grant', async (ctx) => {
  await heldApproval(ctx);
  const run = await ctx.courier('--request');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /clears every pairing/i);
  assert.match(run.stderr, /grant\.json/);
  assert.match(run.stderr, /awaiting-grant/);
  assert.doesNotMatch(run.stderr, /re-pairs/);
});

scenario('a legacy import that drops a saved approval says so on stderr; one that drops nothing is silent', async (ctx) => {
  const { t, request, courier } = ctx;
  await heldApproval(ctx);
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  const run = await courier('--grant-file', homeFile('legacy-grant.json'));
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /discarded a saved approval that was not installed/);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  void t; void request; void loadProfile;
});

scenario('a legacy import over an open request that holds no approval prints no discard note', async ({ t, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  const run = await courier('--grant-file', homeFile('legacy-grant.json'));
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /discarded a saved approval/);
});

scenario('--resume is suggested after a refusal only for an XXXX-XXXX code, not for a file or JSON import', async ({ t, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  const real = Date.now;
  const behind = t.mock.method(Date, 'now', () => real() - 20 * 60_000);
  const run = await courier('--grant-file', homeFile('legacy-grant.json'));
  behind.mock.restore();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /system clock/);
  assert.doesNotMatch(run.stderr, /--resume/);
});
