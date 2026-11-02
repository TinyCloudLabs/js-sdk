import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadProfile } from '../dist/profile.js';
import { fakeTime, homeFile, readHome, readySpace, scenario, stubSpaceProbe } from './support/approval-fixture.mjs';

// A request the owner approved shortly before it expired still has its result served by OpenKey (for the result's own retention),
// so a request that has LAPSED locally and holds no approval is asked about once before it is dropped. (First version of this rule
// dropped it at expiry without asking, which was too eager: it could discard an approval this machine had not discovered yet.)

const MIN = 60_000;
const requestId = (link) => new URL(link).pathname.split('/')[2];
const polls = (fx) => fx.calls.filter((call) => call.action === 'discover').length;

/** Make the saved request expire `agoMs` ago. */
function lapse(agoMs) {
  const pending = readHome('approval-pending.json');
  fs.writeFileSync(homeFile('approval-pending.json'), JSON.stringify({ ...pending, requestExpiresAt: new Date(Date.now() - agoMs).toISOString() }), { mode: 0o600 });
  return pending;
}

scenario('lapsed, unapproved locally, but OpenKey has the result: it is collected, ONE ack, record cleared', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  lapse(2 * MIN);
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fx.acks.length, 1);
  assert.equal(fx.created.length, 1);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('lapsed + OpenKey 400 invalid_request: [approval-expired], record dropped, --request then makes a new request', async ({ fx, request, courier }) => {
  const printed = await request();
  lapse(2 * MIN);
  fx.inject.discover.push({ status: 400, code: 'invalid_request' });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-expired\]/);
  assert.equal(polls(fx), 1, 'asked once');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  assert.notEqual((await request()).openkeyUrl, printed.openkeyUrl);
});

scenario('lapsed + OpenKey expired_request (410) is the same: dropped and reported', async ({ fx, request, courier }) => {
  await request();
  lapse(2 * MIN);
  fx.inject.discover.push({ status: 410, code: 'expired_request' });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-expired\]/);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

for (const [name, reply] of [['a dropped connection', { network: true }], ['an HTTP 503', { status: 503, code: 'busy' }]]) {
  scenario(`lapsed inside the retention window + OpenKey unreachable (${name}): record kept, approval-unavailable, nothing lost`, async ({ t, fx, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    const printed = await request();
    await fx.approve(printed.openkeyUrl);
    const before = lapse(5 * MIN);
    fx.inject.discover.push(reply);
    const run = await courier('--wait');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /\[approval-unavailable\]/);
    assert.match(run.stderr, /Nothing was lost/);
    assert.equal(readHome('approval-pending.json').requestId, before.requestId, 'the record is kept');
    assert.equal(polls(fx), 1, 'asked once, not polled for the whole timeout');
    const again = await courier('--wait');
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fx.acks.length, 1);
  });
}

scenario('lapsed more than 11 minutes ago (retention + skew): dropped and reported with ZERO OpenKey calls', async ({ fx, request, courier }) => {
  const printed = await request();
  await fx.approve(printed.openkeyUrl); // even an approval: its result is gone from OpenKey after 10 minutes
  lapse(11 * MIN + 1000);
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-expired\]/);
  assert.equal(fx.calls.length, 0);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('lapsed just inside 11 minutes is still asked', async ({ fx, request, courier }) => {
  await request();
  lapse(11 * MIN - 5000);
  fx.inject.discover.push({ status: 400, code: 'invalid_request' });
  await courier('--wait');
  assert.equal(polls(fx), 1);
});

scenario('lapsed but OpenKey still reports it open (202): the saved request is resumed, not dropped', async ({ t, fx, request, courier }) => {
  fakeTime(t);
  const printed = await request();
  const before = lapse(2 * MIN);
  const run = await courier('--wait', '--timeout', '3s');
  assert.equal(run.code, 8);
  assert.equal(readHome('approval-pending.json').requestId, before.requestId);
  assert.equal(JSON.parse(run.stdout).pending.approvalUrl, printed.openkeyUrl);
});

// ---- --request over a lapsed, unapproved record ----

scenario('--request over a lapsed record that OpenKey has an approval for: stops with "already approved, run init --wait"', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  lapse(2 * MIN);
  const run = await courier('--request');
  assert.equal(run.code, 2);
  assert.ok(run.stderr.includes(requestId(printed.openkeyUrl)));
  assert.match(run.stderr, /`courier init --wait`/);
  assert.equal(fx.created.length, 1, 'nothing was replaced');
  assert.ok(readHome('approval-pending.json').resultRef, 'the discovered approval is saved');
  const waited = await courier('--wait');
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(fx.acks.length, 1);
});

scenario('--request over a lapsed record that OpenKey says expired: drops it and makes a new request', async ({ fx, request }) => {
  const printed = await request();
  lapse(2 * MIN);
  fx.inject.discover.push({ status: 400, code: 'invalid_request' });
  const next = await request();
  assert.notEqual(next.openkeyUrl, printed.openkeyUrl);
  assert.equal(fx.created.length, 2);
});

scenario('--request over a lapsed record inside the window with OpenKey unreachable: keeps it, says to run --wait, never suggests --rotate-key', async ({ fx, request, courier }) => {
  const printed = await request();
  const before = lapse(5 * MIN);
  fx.inject.discover.push({ network: true });
  const run = await courier('--request');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-unavailable\]/);
  assert.match(run.stderr, /`courier init --wait`/);
  assert.doesNotMatch(run.stderr, /--rotate-key/);
  assert.equal(run.stdout, '');
  assert.equal(readHome('approval-pending.json').requestId, before.requestId);
  assert.equal(fx.created.length, 1);
  void printed;
});

scenario('--request over a record lapsed more than 11 minutes ago makes a new request without asking OpenKey', async ({ fx, request }) => {
  const printed = await request();
  lapse(11 * MIN + 1000);
  const next = await request();
  assert.notEqual(next.openkeyUrl, printed.openkeyUrl);
  assert.equal(fx.calls.length, 0);
});

scenario('a request that has NOT lapsed is resumed without any extra OpenKey call, as before', async ({ fx, request, courier, t }) => {
  fakeTime(t);
  await request();
  const run = await courier('--wait', '--timeout', '3s');
  assert.equal(run.code, 8);
  assert.ok(polls(fx) >= 1);
});

// ---- a 400 invalid_request on FETCH or ACK is not "expired": a held approval is kept ----

scenario('a fetch answered 400 invalid_request on a held, not lapsed approval keeps the record: approval-unavailable, then it collects', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.inject.fetch.push({ status: 400, code: 'invalid_request' });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-unavailable\]/);
  assert.doesNotMatch(run.stderr, /approval-expired/);
  assert.ok(readHome('approval-pending.json').resultRef, 'the held approval is kept');
  const again = await courier('--wait');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.acks.length, 1);
});
