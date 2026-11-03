import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// A renewal stays with the owner that holds the grant, so the first grant and the renewal are signed by one wallet.
const OWNER_WALLET = 'a1'.repeat(32);

// TC-2383: every init mode acts on the one derived state. With a grant saved and not installed, `--resume` installs it and keeps a held
// approval for the next `--wait`; with nothing saved to install, `--resume` hands off to `--wait`. `--wait` advice names the command the state calls for.

/** The owner approved and the encrypted result is saved, but nothing is installed: the process died. */
async function heldApproval({ t, fx, request }) {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { grant: { wallet: OWNER_WALLET } });
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(loadProfile().status, 'awaiting-grant');
}

/** A legacy grant import killed right after grant.json is written. */
async function killedLegacyImport(t) {
  const grant = await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET });
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

scenario('init --resume with an approval held beside a saved grant installs the grant and keeps the approval; the next --wait collects it', async (ctx) => {
  await heldApproval(ctx);
  await killedLegacyImport(ctx.t);
  const held = fs.readFileSync(homeFile('approval-pending.json'));
  assert.ok(readHome('approval-pending.json').resultEnvelope);
  const run = await ctx.courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /init --wait/);
  assert.equal(loadProfile().status, 'ready');
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), held, 'the approval stays on disk');
  assert.equal(ctx.fx.acks.length, 0, 'nothing acknowledged yet');
  const wait = await ctx.courier('--wait');
  assert.equal(wait.code, 0, wait.stderr);
  assert.equal(ctx.fx.created.length, 1);
  assert.equal(ctx.fx.acks.length, 1);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
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

scenario('init --resume with an approval held beside a saved redeemed delegation bound to another key: the stale delegation is dropped as before and the approval is kept for --resume to hand off', async (ctx) => {
  await heldApproval(ctx);
  const held = fs.readFileSync(homeFile('approval-pending.json'));
  const record = { codeHash: 'other-code', expiresAt: '2999-01-01T00:00:00.000Z', savedAt: new Date().toISOString(), delegation: { delegationCid: 'bafy-unrelated' } };
  fs.writeFileSync(homeFile('pending-grant.json'), JSON.stringify({ v: 1, records: [record] }), { mode: 0o600 });
  const first = await ctx.courier('--resume');
  assert.notEqual(first.code, 0, first.stderr);
  assert.equal(fs.existsSync(homeFile('pending-grant.json')), false, 'the stale delegation is dropped');
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), held, 'the approval is untouched');
  assert.equal(ctx.fx.acks.length, 0);
  const second = await ctx.courier('--resume');
  assert.equal(second.code, 0, second.stderr);
  assert.equal(ctx.fx.created.length, 1);
  assert.equal(ctx.fx.acks.length, 1, 'with nothing left to install, --resume continued as --wait');
  assert.equal(loadProfile().status, 'ready');
});

scenario('init --resume on a ready profile with a renewal approval held is refused as before, keeps the approval, and --wait then collects it', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  const first = await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET });
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(first));
  assert.equal((await ctx.courier('--grant-file', homeFile('legacy-grant.json'))).code, 0);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl, { grant: { wallet: OWNER_WALLET } });
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const held = fs.readFileSync(homeFile('approval-pending.json'));
  const created = ctx.fx.created.length;
  const acks = ctx.fx.acks.length;
  const resume = await ctx.courier('--resume');
  assert.equal(resume.code, 2, resume.stderr);
  assert.match(resume.stderr, /requires a profile in awaiting-space state/);
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), held, 'the renewal approval is untouched');
  assert.equal(ctx.fx.acks.length, acks);
  const wait = await ctx.courier('--wait');
  assert.equal(wait.code, 0, wait.stderr);
  assert.equal(ctx.fx.created.length, created, 'no new request: the held one was collected');
  assert.equal(ctx.fx.acks.length, acks + 1);
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
