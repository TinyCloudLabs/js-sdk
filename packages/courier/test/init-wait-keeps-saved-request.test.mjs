import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeTime, homeFile, readHome, scenario } from './support/approval-fixture.mjs';

// TC-4264: `init --wait` collects the request `init --request` saved, with the lifetime and renewal it was made with. The owner
// may already have approved it, so --wait never replaces it: an --expiry or --renew that differs from the saved terms is refused.

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
