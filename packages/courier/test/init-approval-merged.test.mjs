import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PREFIX } from '../dist/keys.js';
import { siweTimes } from '../dist/authority.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, homeFile, missingSpace, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// After merging TC-2301 (save-before-install for the legacy path): `init --resume` is a third way a grant gets installed,
// legacy refusals can happen before installGrant, and a wrong clock must not cost a held approval.

const ROUTE = 'https://account.tinycloud.xyz/delegations';
const requestId = (link) => new URL(link).pathname.split('/')[2];

/** An OwnerGrant record (grant.json) as installGrant saves it, built from a signed grant. */
const ownerGrantRecord = (grant) => ({
  v: 1, delegationHeader: grant.delegationHeader, delegationCid: grant.delegationCid, spaceId: grant.spaceId,
  ownerDid: `did:pkh:eip155:${grant.chainId}:${grant.address}`, address: grant.address, chainId: grant.chainId,
  verificationMethod: grant.verificationMethod, siwe: grant.siwe, signature: grant.signature,
  expiresAt: siweTimes(grant.siwe).expiresAt.toISOString(), receivedAt: new Date().toISOString(),
});

/** Kill a legacy import right after grant.json is written: the profile stays awaiting-grant with a saved grant. */
async function killedLegacyImport(t, courier, options) {
  const grant = await signedGrant(readHome('key.json'), options);
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  const crash = crashAtWrite(t, 'grant.json', { phase: 'after' });
  const { cmdInit } = await import('../dist/commands.js');
  const { parseArgs } = await import('../dist/args.js');
  await assert.rejects(cmdInit(parseArgs(['--grant-file', homeFile('legacy-grant.json')])), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(loadProfile().status, 'awaiting-grant');
  return grant;
}

scenario('init --resume that finishes a killed legacy import clears an open short-link request', async ({ t, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  await killedLegacyImport(t, courier);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), true);
  const run = await courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('init --resume of an awaiting-space profile clears an open short-link request once the space is ready', async ({ t, request, courier }) => {
  let ready = false;
  stubSpaceProbe(t, async () => (ready ? readySpace() : missingSpace()));
  await request();
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 1);
  assert.equal(loadProfile().status, 'awaiting-space');
  await request(); // a new, open request after the import
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), true);
  ready = true;
  const run = await courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('init --resume refusing a saved grant names its CID, what was too broad and the revoke route', async ({ t, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'), { hooksPath: `kv/${PREFIX}/me/state/` });
  fs.writeFileSync(homeFile('grant.json'), JSON.stringify(ownerGrantRecord(grant)), { mode: 0o600 });
  const run = await courier('--resume');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[grant-too-broad\]/);
  assert.ok(run.stderr.includes(grant.delegationCid));
  assert.ok(run.stderr.includes(ROUTE));
  assert.match(run.stderr, /cannot revoke/);
  assert.equal(run.stderr.includes(grant.signature), false);
  assert.equal(run.stderr.includes(grant.delegationHeader.Authorization), false);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), true, 'a refused resume leaves the open request alone');
});

scenario('a legacy grant bound to another agent key is refused with its CID and the revoke route', async ({ t, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify({ ...grant, verificationMethod: 'did:key:z6Mkother#z6Mkother' }));
  const run = await courier('--grant-file', homeFile('legacy-grant.json'));
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[bad-grant\]/);
  assert.ok(run.stderr.includes(grant.delegationCid), 'names the CID even though the refusal comes before installGrant');
  assert.ok(run.stderr.includes(ROUTE));
  assert.equal(run.stderr.includes(grant.signature), false);
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
});

scenario('a clock that is 20 minutes behind keeps the held approval and does not call for a revoke; the right clock finishes it with one ack', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  const { cmdInit } = await import('../dist/commands.js');
  const { parseArgs } = await import('../dist/args.js');
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const real = Date.now;
  const behind = t.mock.method(Date, 'now', () => real() - 20 * 60_000);
  const skewed = await courier('--wait');
  behind.mock.restore();
  assert.equal(skewed.code, 1);
  assert.match(skewed.stderr, /system clock/);
  assert.match(skewed.stderr, /`courier init --wait`/);
  assert.equal(skewed.stderr.includes(ROUTE), false, 'a valid delegation is not something to revoke');
  assert.doesNotMatch(skewed.stderr, /cannot revoke/);
  assert.equal(readHome('approval-pending.json').requestId, requestId(printed.openkeyUrl), 'the held approval is kept');
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
  assert.equal(fx.acks.length, 0);
  const fixed = await courier('--wait');
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(fx.acks.length, 1);
  assert.equal(fx.created.length, 1);
});
