import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Crash, crashAtWrite, homeFile, readHome, scenario, signedGrant } from './support/approval-fixture.mjs';
import { OWNER_WALLET, REVOKE, readyProfile } from './support/review-fixture.mjs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';

// TC-2383: pending-grant.json holds a redeemed delegation (the only copy of an approval OpenKey will not give twice). Rotation discards
// those bound to the OLD key and says so. When key.json cannot be read the owner of a saved delegation cannot be told: it is kept
// as it is (never dropped, never rewritten) and the rotation says that a live grant may exist, naming its CID.

async function savedRedeemedGrant(ctx) {
  await readyProfile(ctx);
  const grant = await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET });
  const record = { codeHash: 'a-redeemed-code', expiresAt: '2999-01-01T00:00:00.000Z', savedAt: new Date().toISOString(), delegation: grant };
  fs.writeFileSync(homeFile('pending-grant.json'), JSON.stringify({ v: 1, records: [record] }), { mode: 0o600 });
  return grant;
}

const BREAKS = {
  'corrupt': () => fs.writeFileSync(homeFile('key.json'), '{"v":1,"jwk":', { mode: 0o600 }),
  'missing': () => fs.rmSync(homeFile('key.json')),
  'not owner-only': () => fs.chmodSync(homeFile('key.json'), 0o644),
};

for (const [kind, breakKey] of Object.entries(BREAKS)) {
  scenario(`rotating while key.json is ${kind} keeps an unidentifiable saved delegation byte-identical and reports it with its CID`, async (ctx) => {
    const grant = await savedRedeemedGrant(ctx);
    breakKey();
    const pending = fs.readFileSync(homeFile('pending-grant.json'));
    ctx.errors.length = 0;
    const run = await ctx.courier('--rotate-key', '--request');
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(fs.readFileSync(homeFile('pending-grant.json')), pending, 'kept as it is');
    assert.ok(run.stderr.includes(grant.delegationCid), 'the CID is named');
    assert.match(run.stderr, /could not be matched to the old agent key/);
    assert.match(run.stderr, /live grant may exist/);
    assert.ok(run.stderr.includes(REVOKE));
  });
}

scenario('the unmatched-delegation notice is journaled without secrets and survives a crash after the journal is written', async (ctx) => {
  const grant = await savedRedeemedGrant(ctx);
  fs.writeFileSync(homeFile('key.json'), '{"v":1,"jwk":', { mode: 0o600 });
  const crash = crashAtWrite(ctx.t, 'rotation.json', { phase: 'after' });
  await assert.rejects(cmdInit(parseArgs(['--rotate-key', '--request'])), (error) => error instanceof Crash);
  crash.disarm();
  const text = fs.readFileSync(homeFile('rotation.json'), 'utf8');
  assert.ok(text.includes(grant.delegationCid));
  assert.equal(text.includes(grant.delegationHeader.Authorization), false);
  assert.equal(text.includes(grant.signature), false);
  const pending = fs.readFileSync(homeFile('pending-grant.json'));
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.ok(run.stderr.includes(grant.delegationCid), run.stderr);
  assert.match(run.stderr, /could not be matched to the old agent key/);
  assert.deepEqual(fs.readFileSync(homeFile('pending-grant.json')), pending);
});

scenario('with a readable key.json and nothing saved, no unmatched-delegation notice is printed (control)', async (ctx) => {
  await readyProfile(ctx);
  ctx.errors.length = 0;
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /could not be matched/);
});
