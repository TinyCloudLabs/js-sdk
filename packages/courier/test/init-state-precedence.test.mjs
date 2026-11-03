import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import {
  Crash, crashAtWrite, homeFile, missingSpace, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2383: precedence between a saved approval request and the other saved state, one scenario per row of the design, plus the states
// every init mode refuses. Existing behavior is kept: a grant saved and not installed is installed first, with a held approval left on
// disk; an open request saved while the space is being set up is collected by `--wait`.

const OWNER_WALLET = 'b2'.repeat(32);

const snapshot = () => {
  const dir = path.dirname(homeFile('x'));
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, { bytes: fs.readFileSync(path.join(dir, name)).toString('base64'), mode: fs.statSync(path.join(dir, name)).mode & 0o777 }]));
};

/** The grant is saved but the space is missing: profile awaiting-space. */
async function awaitingSpace({ request, courier }) {
  await request();
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET })));
  assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 1);
  fs.rmSync(homeFile('legacy-grant.json'));
  assert.equal(readHome('profile.json').status, 'awaiting-space');
}

scenario('awaiting-space with an open request: --wait collects it (no refusal, no second request)', async (ctx) => {
  stubSpaceProbe(ctx.t, missingSpace);
  await awaitingSpace(ctx);
  fs.rmSync(homeFile('approval-pending.json'), { force: true });
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl, { grant: { wallet: OWNER_WALLET } });
  const created = ctx.fx.created.length;
  const acksBefore = ctx.fx.acks.length;
  const { ackId } = readHome('approval-pending.json');
  const run = await ctx.courier('--wait');
  assert.notEqual(run.code, 2, run.stderr);
  assert.equal(ctx.fx.created.length, created, 'the saved request was collected, not replaced');
  assert.equal(ctx.fx.acks.length, acksBefore + 1, 'exactly one acknowledgement was sent');
  assert.equal(ctx.fx.acks.at(-1).ackId, ackId, 'it acknowledges the saved request');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false, 'the collected approval is removed');
});

scenario('awaiting-space with a held approval and no grant saved: --wait collects it', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl, { grant: { wallet: OWNER_WALLET } });
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const held = readHome('approval-pending.json');
  assert.ok(held.resultEnvelope, 'the owner\'s approval is saved, not installed');
  const profile = readHome('profile.json');
  fs.writeFileSync(homeFile('profile.json'), JSON.stringify({ ...profile, status: 'awaiting-space' }), { mode: 0o600 });
  const created = ctx.fx.created.length;
  const acksBefore = ctx.fx.acks.length;
  const run = await ctx.courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(ctx.fx.created.length, created);
  assert.equal(ctx.fx.acks.length, acksBefore + 1, 'exactly one acknowledgement was sent');
  assert.equal(ctx.fx.acks.at(-1).ackId, held.ackId, 'it acknowledges the saved approval');
  assert.equal(readHome('profile.json').status, 'ready');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('a saved grant beside an open request: --wait advises --resume and changes nothing', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  fs.writeFileSync(homeFile('grant.json'), JSON.stringify({ v: 1, delegationHeader: { Authorization: 'a' }, delegationCid: 'c', spaceId: 's', siwe: 'x', expiresAt: '2999-01-01T00:00:00.000Z' }), { mode: 0o600 });
  const before = snapshot();
  const run = await ctx.courier('--wait');
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /`courier init --resume`/);
  assert.deepEqual(snapshot(), before);
});

// ---- states every init mode refuses: nothing is changed, deleted or created ----

const APPROVALS = {
  open: () => {},
  unreadable: () => fs.chmodSync(homeFile('approval-pending.json'), 0o644),
};

for (const [label, orphan] of [
  ['profile.json is missing', () => fs.rmSync(homeFile('profile.json'))],
  ['key.json is missing', () => fs.rmSync(homeFile('key.json'))],
]) {
  for (const [kind, shape] of Object.entries(APPROVALS)) {
    scenario(`a saved ${kind} approval whose ${label}: every mode refuses naming approval-pending.json and changes no file`, async (ctx) => {
      stubSpaceProbe(ctx.t, readySpace);
      await ctx.request();
      shape();
      orphan();
      fs.writeFileSync(homeFile('grant-input.json'), '{}', { mode: 0o600 });
      const before = snapshot();
      for (const argv of [['--resume'], ['--wait'], ['--request'], ['--grant-file', homeFile('grant-input.json')]]) {
        const run = await ctx.courier(...argv);
        assert.notEqual(run.code, 0, argv.join(' '));
        assert.match(run.stderr, /approval-pending\.json/, argv.join(' '));
        assert.deepEqual(snapshot(), before, `${argv.join(' ')} changed a file`);
      }
    });
  }
}

scenario('an unreadable saved approval on an awaiting-grant profile: --wait and --request refuse and change no file', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  fs.chmodSync(homeFile('approval-pending.json'), 0o644);
  const before = snapshot();
  for (const argv of [['--wait'], ['--request']]) {
    const run = await ctx.courier(...argv);
    assert.notEqual(run.code, 0, argv.join(' '));
    assert.match(run.stderr, /approval-pending\.json/);
    assert.deepEqual(snapshot(), before);
  }
});
