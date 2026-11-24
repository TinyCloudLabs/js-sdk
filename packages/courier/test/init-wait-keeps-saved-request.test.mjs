import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { Crash, crashAtWrite, fakeTime, homeFile, readHome, scenario } from './support/approval-fixture.mjs';

// TC-4264: `init --wait` collects the request `init --request` saved, as it was made. The owner may already have approved it, so
// --wait never replaces it: an --expiry, --renew or setting that differs from the saved request is refused.

const savedFiles = () => ({ pending: fs.readFileSync(homeFile('approval-pending.json')), key: fs.readFileSync(homeFile('key.json')) });

/** A saved, unapproved 1d request without renewal (the TC-4264 report), and its files byte for byte. */
async function savedOneDay(t, request) {
  fakeTime(t);
  const printed = await request('--expiry', '1d', '--renew', 'off');
  const saved = readHome('approval-pending.json');
  assert.equal(saved.request.grantLifetimeSeconds, 86_400);
  assert.equal(saved.request.renewal, undefined);
  return { printed, saved, files: savedFiles() };
}

function assertUnchanged(fx, before) {
  assert.equal(fx.created.length, 1, 'no new approval request');
  const after = savedFiles();
  assert.ok(after.pending.equals(before.pending), 'approval-pending.json is byte-identical');
  assert.ok(after.key.equals(before.key), 'key.json is byte-identical');
}

scenario('(a) a plain --wait resumes a saved 1d request without renewal: same request id, relay key and files', async ({ t, fx, request, courier }) => {
  const { printed, saved, files } = await savedOneDay(t, request);
  const run = await courier('--wait', '--timeout', '5s');
  assert.equal(run.code, 8, run.stderr);
  assert.match(run.stderr, /Resuming the saved approval request\./);
  assert.equal(JSON.parse(run.stdout).pending.approvalUrl, printed.openkeyUrl);
  const now = readHome('approval-pending.json');
  assert.equal(now.requestId, saved.requestId);
  assert.deepEqual(now.relayPrivateKey, saved.relayPrivateKey);
  assertUnchanged(fx, files);
});

for (const [label, argv] of [['(b) --expiry 30d', ['--expiry', '30d']], ['(c) --renew 90d', ['--renew', '90d']]]) {
  scenario(`${label} on --wait differs from the saved request: refused, naming the saved terms, and nothing is replaced`, async ({ t, fx, request, courier }) => {
    const { saved, files } = await savedOneDay(t, request);
    const run = await courier('--wait', '--timeout', '5s', ...argv);
    assert.equal(run.code, 2, run.stderr);
    assert.ok(run.stderr.includes(`Approval request ${saved.requestId} is saved with --expiry 1d --renew off.`), run.stderr);
    assert.equal(run.stdout, '');
    assertUnchanged(fx, files);
  });
}

scenario('(d) --wait --expiry 1d --renew off, equal to the saved terms, resumes the saved request', async ({ t, fx, request, courier }) => {
  const { printed, saved, files } = await savedOneDay(t, request);
  const run = await courier('--wait', '--timeout', '5s', '--expiry', '1d', '--renew', 'off');
  assert.equal(run.code, 8, run.stderr);
  assert.equal(JSON.parse(run.stdout).pending.approvalUrl, printed.openkeyUrl);
  assert.equal(readHome('approval-pending.json').requestId, saved.requestId);
  assertUnchanged(fx, files);
});

scenario('(e) with no saved request, --wait creates one from its flags and the defaults', async ({ t, fx, courier }) => {
  fakeTime(t);
  const plain = await courier('--wait', '--timeout', '5s');
  assert.equal(plain.code, 8, plain.stderr);
  assert.match(plain.stderr, /Created an approval request\./);
  assert.equal(fx.created.length, 1);
  const defaults = readHome('approval-pending.json').request;
  assert.equal(defaults.grantLifetimeSeconds, 30 * 86_400);
  assert.deepEqual(defaults.renewal, { version: 1, leaseLifetimeSeconds: 90 * 86_400 });

  fs.rmSync(homeFile('approval-pending.json'));
  const flagged = await courier('--wait', '--timeout', '5s', '--expiry', '1d', '--renew', 'off');
  assert.equal(flagged.code, 8, flagged.stderr);
  assert.equal(fx.created.length, 2);
  const named = readHome('approval-pending.json').request;
  assert.equal(named.grantLifetimeSeconds, 86_400);
  assert.equal(named.renewal, undefined);
});

const MOVED = 'https://moved.fixture.test';
const API_HOST = (saved) => `OpenKey API host (--openkey-api-host or COURIER_OPENKEY_API_HOST): saved ${saved.apiOrigin}, this run ${MOVED}`;
const NODE_HOST = (saved) => `node host (--host): saved ${saved.request.nodeOrigin}, this run ${MOVED}`;
const moveApiHost = () => { process.env.COURIER_OPENKEY_API_HOST = MOVED; return []; };

function assertNoFileChanged(fx, files, profile) {
  assertUnchanged(fx, files);
  assert.ok(fs.readFileSync(homeFile('profile.json')).equals(profile), 'profile.json is byte-identical');
  assert.equal(fs.existsSync(homeFile('grant.json')), false, 'no grant.json was written');
}

for (const [label, change, item] of [
  ['(f) --openkey-api-host', () => ['--openkey-api-host', MOVED], API_HOST],
  ['(f) COURIER_OPENKEY_API_HOST', moveApiHost, API_HOST],
  ['(g) TC_LINKS_API_ORIGIN', () => { process.env.TC_LINKS_API_ORIGIN = MOVED; return []; }, (saved) => `links API host (TC_LINKS_API_ORIGIN): saved ${saved.linkApiOrigin}, this run ${MOVED}`],
  ['(h) --host', () => ['--host', MOVED], NODE_HOST],
]) {
  scenario(`${label} differs from the saved request: --wait is refused, naming the setting, and no file changes`, async ({ t, fx, request, courier }) => {
    const { saved, files } = await savedOneDay(t, request);
    const profile = fs.readFileSync(homeFile('profile.json'));
    const run = await courier('--wait', '--timeout', '5s', ...change());
    assert.equal(run.code, 2, run.stderr);
    assert.ok(run.stderr.includes(`Approval request ${saved.requestId} was made with different settings: ${item(saved)}.`), run.stderr);
    assert.equal(run.stdout, '');
    assertNoFileChanged(fx, files, profile);
  });
}

/** A saved request the owner approved whose result is already saved locally (an interrupted --wait), so it holds the approval. */
async function savedApproved(t, fx, request) {
  const { saved } = await savedOneDay(t, request);
  await fx.approve(readHome('approval-pending.json').approvalUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  assert.ok(readHome('approval-pending.json').resultEnvelope, 'the approval is held');
  return { saved, files: savedFiles(), profile: fs.readFileSync(homeFile('profile.json')) };
}

for (const [label, argv, item] of [
  ['(i) --wait --host', () => ['--wait', '--host', MOVED], NODE_HOST],
  ['(j) --wait with COURIER_OPENKEY_API_HOST', () => ['--wait', ...moveApiHost()], API_HOST],
  ['(j) --resume with COURIER_OPENKEY_API_HOST', () => ['--resume', ...moveApiHost()], API_HOST],
]) {
  scenario(`${label} different from an approved request: refused, nothing installed, no file changes`, async ({ t, fx, request, courier }) => {
    const { saved, files, profile } = await savedApproved(t, fx, request);
    const run = await courier(...argv());
    assert.equal(run.code, 2, run.stderr);
    assert.ok(run.stderr.includes(`Approval request ${saved.requestId} was approved by the owner with different settings: ${item(saved)}.`), run.stderr);
    assertNoFileChanged(fx, files, profile);
    assert.equal(fx.acks.length, 0);
  });
}

scenario('(k) a saved 1d request with a 5d lease: --wait --renew 5d resumes it (checked against the saved lifetime, not 30d)', async ({ t, fx, request, courier }) => {
  fakeTime(t);
  const printed = await request('--expiry', '1d', '--renew', '5d');
  const files = savedFiles();
  const run = await courier('--wait', '--timeout', '5s', '--renew', '5d');
  assert.equal(run.code, 8, run.stderr);
  assert.equal(JSON.parse(run.stdout).pending.approvalUrl, printed.openkeyUrl);
  assertUnchanged(fx, files);
  const other = await courier('--wait', '--timeout', '5s', '--renew', '6d');
  assert.equal(other.code, 2, other.stderr);
  assert.match(other.stderr, /is saved with --expiry 1d --renew 5d\./);
  assertUnchanged(fx, files);
});
