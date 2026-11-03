import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2383: every init mode acts on the one derived state. `--resume` hands off to `--wait` while an approval from the
// owner is saved (it outranks a saved grant), and `--wait` advice names the command the derived state calls for.

/** The owner approved and the encrypted result is saved, but nothing is installed: the process died. */
async function heldApproval({ t, fx, request }) {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(loadProfile().status, 'awaiting-grant');
}

/** A legacy grant import killed right after grant.json is written. */
async function killedLegacyImport(t) {
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  const crash = crashAtWrite(t, 'grant.json', { phase: 'after' });
  await assert.rejects(cmdInit(parseArgs(['--grant-file', homeFile('legacy-grant.json')])), (error) => error instanceof Crash);
  crash.disarm();
}

scenario('init --resume with an approval held continues as --wait: installs it and acknowledges it', async (ctx) => {
  await heldApproval(ctx);
  const run = await ctx.courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /init --wait/);
  assert.equal(ctx.fx.created.length, 1, 'no new approval request');
  assert.equal(ctx.fx.acks.length, 1);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('init --resume with an approval held beside a saved grant keeps the approval and collects it', async (ctx) => {
  await heldApproval(ctx);
  await killedLegacyImport(ctx.t);
  assert.ok(readHome('approval-pending.json').resultEnvelope);
  const run = await ctx.courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(ctx.fx.created.length, 1);
  assert.equal(ctx.fx.acks.length, 1, 'the held approval was acknowledged, not discarded');
  assert.equal(loadProfile().status, 'ready');
});

scenario('init --wait with a saved grant still to install says to run --resume and makes no request', async ({ t, request, courier, fx }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  await killedLegacyImport(t);
  const run = await courier('--wait');
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /`courier init --resume`/);
  assert.equal(fx.created.length, 1);
});

scenario('init --resume with an approval held beside a saved redeemed grant keeps the approval and collects it', async (ctx) => {
  await heldApproval(ctx);
  const record = { codeHash: 'other-code', expiresAt: '2999-01-01T00:00:00.000Z', savedAt: new Date().toISOString(), delegation: { delegationCid: 'bafy-unrelated' } };
  fs.writeFileSync(homeFile('pending-grant.json'), JSON.stringify({ v: 1, records: [record] }), { mode: 0o600 });
  const run = await ctx.courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(ctx.fx.created.length, 1);
  assert.equal(ctx.fx.acks.length, 1, 'the held approval was acknowledged, not discarded');
  assert.equal(loadProfile().status, 'ready');
});

scenario('init --resume on a ready profile with a renewal approval held continues as --wait and installs it', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  const first = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(first));
  assert.equal((await ctx.courier('--grant-file', homeFile('legacy-grant.json'))).code, 0);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const created = ctx.fx.created.length;
  const run = await ctx.courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(ctx.fx.created.length, created, 'no new request: the held one was collected');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('init --resume with an approval held and the key missing refuses with advice and touches nothing', async (ctx) => {
  await heldApproval(ctx);
  const pending = fs.readFileSync(homeFile('approval-pending.json'));
  fs.rmSync(homeFile('key.json'));
  for (const argv of [['--resume'], ['--wait'], ['--request']]) {
    const run = await ctx.courier(...argv);
    assert.notEqual(run.code, 0, argv.join(' '));
    assert.match(run.stderr, /approval-pending\.json/);
    assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), pending, 'the saved approval is kept');
    assert.equal(fs.existsSync(homeFile('key.json')), false, 'no new key was made');
  }
});
