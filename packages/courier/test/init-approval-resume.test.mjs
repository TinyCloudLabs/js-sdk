import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, DAY, fakeTime, homeFile, missingSpace, readHome, readySpace, scenario, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2300 review round: a saved approval request must survive being run again with different flags, a renewal must
// stay with the owner that holds the grant, the result must honour the lifetime that was asked for, a retryable OpenKey
// reply must not destroy the saved request, and a default `--wait` must stay inside an agent's tool-call limit.

const pendingFile = () => readHome('approval-pending.json');
const polls = (fx, action) => fx.calls.filter((call) => call.action === action).length;
const requestId = (link) => new URL(link).pathname.split('/')[2];

// ---- re-running with different flags never replaces a request that holds an approval ----

scenario('--request --expiry 7d, approved, then a plain --wait collects THAT request (no second request)', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request('--expiry', '7d');
  await fx.approve(printed.openkeyUrl);
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fx.created.length, 1, 'the approved request was not replaced');
  assert.equal(fx.acks.length, 1);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('a saved encrypted result survives `--wait --expiry 7d`: it is installed from disk, not replaced', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const saved = pendingFile();
  assert.ok(saved.resultEnvelope);
  const before = { discover: polls(fx, 'discover'), fetch: polls(fx, 'fetch') };
  const run = await courier('--wait', '--expiry', '7d');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fx.created.length, 1);
  assert.deepEqual({ discover: polls(fx, 'discover'), fetch: polls(fx, 'fetch') }, before, 'nothing was fetched again');
  assert.equal(fx.acks.length, 1);
  assert.equal(loadProfile().status, 'ready');
});

scenario('a committed result whose ack was dropped is acknowledged by `--wait --expiry 7d`, never replaced by a new request', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.dropNextAck = true;
  assert.equal((await courier('--wait')).code, 0);
  assert.equal(pendingFile().committed, true);
  const run = await courier('--wait', '--expiry', '7d');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fx.created.length, 1, 'no new approval request after the grant was installed');
  assert.equal(fx.acks.length, 1);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('`--request` never replaces a request that holds an approval: it fails naming the request and changes nothing', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const before = fs.readFileSync(homeFile('approval-pending.json'));
  for (const argv of [[], ['--expiry', '7d']]) {
    const run = await courier('--request', ...argv);
    assert.equal(run.code, 2, argv.join(' '));
    assert.ok(run.stderr.includes(requestId(printed.openkeyUrl)), 'the message names the pending request');
    assert.match(run.stderr, /`courier init --wait`/);
    assert.equal(run.stdout, '');
  }
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), before);
  assert.equal(fx.created.length, 1);
});

scenario('an unapproved request is replaced only when --expiry is given explicitly and differs', async ({ fx, request }) => {
  const first = await request('--expiry', '7d');
  assert.equal((await request()).openkeyUrl, first.openkeyUrl, 'no --expiry: the saved request stands');
  assert.equal((await request('--expiry', '7d')).openkeyUrl, first.openkeyUrl, 'the same --expiry: the saved request stands');
  const longer = await request('--expiry', '30d');
  assert.notEqual(longer.openkeyUrl, first.openkeyUrl);
  assert.equal(fx.created.length, 2);
});

scenario('a saved request whose permissions, reason or target differ from this version is not resumed', async ({ fx, request }) => {
  const first = await request();
  const pending = pendingFile();
  fs.writeFileSync(homeFile('approval-pending.json'), JSON.stringify({ ...pending, request: { ...pending.request, permissions: pending.request.permissions.slice(0, -1) } }), { mode: 0o600 });
  const second = await request();
  assert.notEqual(second.openkeyUrl, first.openkeyUrl, 'old AGENT_GRANT: a new request, not an approval that would be refused later');
  const saved = pendingFile();
  fs.writeFileSync(homeFile('approval-pending.json'), JSON.stringify({ ...saved, request: { ...saved.request, reason: 'something else' } }), { mode: 0o600 });
  assert.notEqual((await request()).openkeyUrl, second.openkeyUrl);
  assert.equal(fx.created.length, 3);
});

// ---- a renewal stays with the owner that holds the grant ----

const WALLET_A = randomBytes(32).toString('hex');
const WALLET_B = randomBytes(32).toString('hex');

async function firstInstall({ fx, request, courier }, wallet) {
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { grant: { wallet } });
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout).ownerDid;
}

scenario('a renewal approved by a DIFFERENT owner is refused: grant and owner unchanged, nothing acknowledged', async (ctx) => {
  const { t, fx, request, courier } = ctx;
  stubSpaceProbe(t, readySpace);
  const ownerA = await firstInstall(ctx, WALLET_A);
  const grantBefore = fs.readFileSync(homeFile('grant.json'));
  const profileBefore = loadProfile();
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { grant: { wallet: WALLET_B } });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-result-invalid\]/);
  assert.match(run.stderr, /different owner/);
  assert.match(run.stderr, /--rotate-key/);
  assert.deepEqual(fs.readFileSync(homeFile('grant.json')), grantBefore);
  assert.equal(loadProfile().ownerDid, ownerA);
  assert.equal(loadProfile().status, profileBefore.status);
  assert.equal(fx.acks.length, 1, 'only the first, legitimate approval was acknowledged');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false, 'a refused result cannot loop');
});

scenario('a renewal approved by the SAME owner installs, whatever the address case in the saved profile', async (ctx) => {
  const { t, fx, request, courier } = ctx;
  stubSpaceProbe(t, readySpace);
  const ownerA = await firstInstall(ctx, WALLET_A);
  const profile = readHome('profile.json');
  profile.ownerDid = ownerA.replace(/0x(.*)$/i, (_all, hex) => `0x${hex.toUpperCase()}`);
  assert.notEqual(profile.ownerDid, ownerA);
  fs.writeFileSync(homeFile('profile.json'), JSON.stringify(profile), { mode: 0o600 });
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { grant: { wallet: WALLET_A } });
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fx.acks.length, 2);
});

scenario('--rotate-key may bind a different owner (it re-pairs everything anyway)', async (ctx) => {
  const { t, fx, request, courier } = ctx;
  stubSpaceProbe(t, readySpace);
  await firstInstall(ctx, WALLET_A);
  const printed = await request('--rotate-key');
  await fx.approve(printed.openkeyUrl, { grant: { wallet: WALLET_B } });
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.notEqual(loadProfile().ownerDid, undefined);
  assert.equal(fx.acks.length, 2);
});

// ---- the granted lifetime is bound to the REQUESTED lifetime ----

scenario('a 7-day request refuses a 30-day grant: nothing installed, no ack', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request('--expiry', '7d');
  await fx.approve(printed.openkeyUrl, { grant: { lifetimeMs: 30 * DAY } });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[grant-too-long\]/);
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
  assert.equal(fx.acks.length, 0);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('a 7-day request accepts a grant of 7 days or less (the owner may choose less)', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request('--expiry', '7d');
  await fx.approve(printed.openkeyUrl, { grant: { lifetimeMs: 3 * DAY } });
  assert.equal((await courier('--wait')).code, 0);
});

// ---- retryable OpenKey replies keep the request; permanent ones drop it with an honest message ----

scenario('a rejected proof (clock skew) keeps the request and its relay key; the next --wait collects it', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const kept = pendingFile();
  fx.inject.discover.push({ status: 401, code: 'invalid_proof' });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-rejected\]/);
  assert.deepEqual(pendingFile(), kept, 'the saved request is untouched');
  const again = await courier('--wait');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.created.length, 1);
  assert.equal(fx.acks.length, 1);
});

scenario('a malformed fetch reply keeps the request (one bad reply is not a verdict)', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const real = globalThis.fetch;
  let broken = false;
  globalThis.fetch = async (input, init) => {
    const response = await real(input, init);
    if (!broken && String(input).endsWith('/fetch')) {
      broken = true;
      return Response.json({ requestId: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' });
    }
    return response;
  };
  t.after(() => { globalThis.fetch = real; });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.equal(pendingFile().requestId, requestId(printed.openkeyUrl), 'the request is still there');
  const again = await courier('--wait');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.created.length, 1);
});

scenario('an ack OpenKey answers with a conflict leaves the grant installed, exits 0, and does not leave a record that would block --request', async ({ t, fx, request, courier, errors }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.approvals.get(requestId(printed.openkeyUrl)).ackId = 'a-different-ack-id';
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.match(errors.join('\n'), /different acknowledgement/);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  assert.notEqual((await request()).openkeyUrl, printed.openkeyUrl);
});

scenario('a result OpenKey no longer has (not_found on fetch after the reference was saved) says so, not "request expired"', async ({ fx, request, courier }) => {
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.inject.fetch.push({ status: 404, code: 'not_found' });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no longer (holds|has) the approved result/);
  assert.doesNotMatch(run.stderr, /expired before it was approved/);
  assert.match(run.stderr, /`courier init --request`/);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('a result OpenKey already acknowledged elsewhere cannot be fetched: the request is dropped so --request is not blocked', async ({ fx, request, courier }) => {
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.inject.fetch.push({ status: 409, code: 'acknowledged' });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-consumed\]/);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  assert.notEqual((await request()).openkeyUrl, printed.openkeyUrl);
});

// ---- a default --wait stays inside an agent's tool-call limit ----

scenario('a default --wait whose approval arrives late still ends inside 70 s, even with the agents space pending', async ({ t, fx, courier }) => {
  const clock = fakeTime(t);
  stubSpaceProbe(t, missingSpace);
  fx.pollsBeforeApproval = 28; // the owner approves on the 29th poll, 56 s in
  fx.autoApprove = { options: { delegation: { spaceReady: null, spacePending: true } } };
  const run = await courier('--wait');
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /\[no-space\]/);
  assert.ok(clock.elapsed() >= 54_000, `the approval came late (${clock.elapsed()} ms)`);
  assert.ok(clock.elapsed() <= 70_000, `the whole command took ${clock.elapsed()} ms of waiting`);
  assert.equal(fx.acks.length, 1, 'the grant is installed and acknowledged; init --resume finishes the space');
  assert.equal(loadProfile().status, 'awaiting-space');
});

// ---- --wait never starts a renewal by itself ----

scenario('--wait on a ready profile with no saved request is a usage error that points at --request and creates nothing', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  fakeTime(t); // a profile that did start a renewal would wait here; keep that failure fast
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  assert.equal((await courier('--wait')).code, 0);
  const profileBefore = fs.readFileSync(homeFile('profile.json'));
  const created = fx.created.length;
  const run = await courier('--wait');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /`courier init --request`/);
  assert.equal(fx.created.length, created);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  assert.deepEqual(fs.readFileSync(homeFile('profile.json')), profileBefore);
});

// ---- the one wording every agent must see: exit 8 is a pending approval, not a failure ----

const EXIT_EIGHT = 'Exit 8 is not a failure: the approval is still pending. Send the owner the `pending.approvalUrl` (the same link as `openkeyUrl`), '
  + 'ask them to approve it, then re-run `courier init --wait --timeout 60s`. Repeat while it exits 8. '
  + 'Any other non-zero exit is an error: stderr carries `[code]`.';
const flat = (text) => text.replace(/\s+/g, ' ').replace(/^[ #>*-]+/g, '');

test('the courier README, both skill copies, the CLI README and --help all carry the exit-8 instructions and the full pending shape', async () => {
  const read = (relative) => flat(fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
  const { main } = await import('../dist/main.js');
  let help = '';
  const original = console.error;
  console.error = (message) => { help += `${message}\n`; };
  try { await main(['frobnicate']); } finally { console.error = original; }
  for (const [name, text] of [
    ['courier README', read('../README.md')],
    ['courier SKILL', read('../skills/courier/SKILL.md')],
    ['cli SKILL mirror', read('../../cli/skills/courier/SKILL.md')],
    ['cli README', read('../../cli/README.md')],
    ['--help', flat(help)],
  ]) {
    assert.ok(text.includes(flat(EXIT_EIGHT)), `${name} must say, in these words: ${EXIT_EIGHT}`);
    assert.ok(text.includes('{"pending":{"step":1,"of":1,"approvalUrl"'), `${name} must show the full pending shape`);
  }
});

// ---- --rotate-key warns when it throws away an approval the owner already gave ----

scenario('--rotate-key --wait with a saved approval says on stderr that it discards that approval', async ({ t, fx, request, courier, errors }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  errors.length = 0;
  fakeTime(t);
  const run = await courier('--rotate-key', '--wait', '--timeout', '5s');
  assert.equal(run.code, 8);
  assert.match(errors.join('\n'), /discard.*approval.*already (gave|approved)|already approved.*discard/i);
  assert.equal(fx.created.length, 2);
});

scenario('--rotate-key with no approval held prints no discard warning', async ({ request, courier, errors }) => {
  await request();
  errors.length = 0;
  const run = await courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(errors.join('\n'), /discard/i);
});
