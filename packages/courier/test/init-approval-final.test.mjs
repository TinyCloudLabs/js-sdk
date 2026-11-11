import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { siweTimes } from '../dist/authority.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, homeFile, missingSpace, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// Last review round: `init --resume` must not drop an approval that is not installed yet, a corrupt pending record must not
// break resume or rotation, a wrong LOCAL clock on the legacy/resume paths must not call for a revoke, and the `--request`
// refusal over a held approval says how to get out.

const ROUTE = 'https://account.tinycloud.xyz/delegations';
const requestId = (link) => new URL(link).pathname.split('/')[2];
const WALLET = '33'.repeat(32);

const ownerGrantRecord = (grant) => ({
  v: 1, delegationHeader: grant.delegationHeader, delegationCid: grant.delegationCid, spaceId: grant.spaceId,
  ownerDid: `did:pkh:eip155:${grant.chainId}:${grant.address}`, address: grant.address, chainId: grant.chainId,
  verificationMethod: grant.verificationMethod, siwe: grant.siwe, signature: grant.signature,
  expiresAt: siweTimes(grant.siwe).expiresAt.toISOString(), receivedAt: new Date().toISOString(),
});

scenario('init --resume keeps a held, not yet installed approval; the next --wait installs it and acknowledges once', async ({ t, fx, request, courier }) => {
  let ready = false;
  stubSpaceProbe(t, async () => (ready ? readySpace() : missingSpace()));
  await request();
  const legacy = await signedGrant(readHome('key.json'), { wallet: WALLET });
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(legacy));
  assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 1); // no-space: grant saved, awaiting-space
  assert.equal(loadProfile().status, 'awaiting-space');
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { grant: { wallet: WALLET } });
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  ready = true;
  const resumed = await courier('--resume');
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readHome('approval-pending.json').requestId, requestId(printed.openkeyUrl), 'the owner\'s approval is still saved');
  const waited = await courier('--wait');
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(fx.acks.length, 1);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('a corrupt approval-pending.json does not break --resume after a successful install', async ({ t, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('grant.json'), JSON.stringify(ownerGrantRecord(grant)), { mode: 0o600 });
  fs.writeFileSync(homeFile('approval-pending.json'), '{ not json', { mode: 0o600 });
  const run = await courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.match(run.stderr, /approval-pending\.json/);
});

scenario('a corrupt approval-pending.json does not block --rotate-key', async ({ request, courier }) => {
  await request();
  fs.writeFileSync(homeFile('approval-pending.json'), '[1,2', { mode: 0o600 });
  const run = await courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.match(JSON.parse(run.stdout).openkeyUrl, /^https:\/\/openkey\.so\/a\//);
  assert.equal(readHome('approval-pending.json').version, 1);
});

for (const [name, mode] of [['--grant-file', 'legacy'], ['--resume', 'resume']]) {
  scenario(`a clock 20 minutes behind on ${name}: says to check the clock, never to revoke; the right clock then installs`, async ({ t, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    await request();
    const grant = await signedGrant(readHome('key.json'));
    const args = mode === 'legacy' ? ['--grant-file', homeFile('legacy-grant.json')] : ['--resume'];
    if (mode === 'legacy') fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
    else fs.writeFileSync(homeFile('grant.json'), JSON.stringify(ownerGrantRecord(grant)), { mode: 0o600 });
    const real = Date.now;
    const behind = t.mock.method(Date, 'now', () => real() - 20 * 60_000);
    const skewed = await courier(...args);
    behind.mock.restore();
    assert.equal(skewed.code, 1);
    assert.match(skewed.stderr, /\[bad-grant\]/);
    assert.match(skewed.stderr, /system clock/);
    assert.equal(skewed.stderr.includes(ROUTE), false, 'a valid delegation is not something to revoke');
    assert.doesNotMatch(skewed.stderr, /cannot revoke/);
    if (mode === 'resume') assert.equal(fs.existsSync(homeFile('grant.json')), true, 'the saved grant is kept');
    const fixed = await courier(...args);
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.equal(loadProfile().status, 'ready');
  });
}

scenario('--request over a held approval says how to discard it (--rotate-key)', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const run = await courier('--request');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--rotate-key/);
  assert.match(run.stderr, /discard/);
});
