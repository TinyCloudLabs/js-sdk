import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { MAX_APPROVAL_LEASE_SECONDS } from '@tinycloud/share-envelope/links';
import { AGENT_GRANT_EXPIRY, COURIER_DEFAULT_LEASE_SECONDS } from '../dist/keys.js';
import { AGENT_GRANT_MAX_MS } from '../dist/authority.js';
import { renewalLeaseFor } from '../dist/grant-request.js';
import { loadOwnerEpisode, OWNER_ASK_AHEAD_MS, preflightOwner } from '../dist/interim-owner.js';
import { readHome, homeFile, readySpace, scenario, stubSpaceProbe, DAY } from './support/approval-fixture.mjs';

// TC-3522: the approval link asks the owner for a renewal lease by default. The owner may answer with a grant that ends at its
// expiry; that answer is kept and the automatic re-approval does not ask for a lease again.

const GRANT_SECONDS = AGENT_GRANT_MAX_MS / 1000;
const days = (seconds) => `${seconds / 86_400}d`;
const usage = (error) => error?.code === 'usage';
const askedLease = async (fx, link) => (await fx.openRequest(link)).renewal;
const currentLink = () => readHome('approval-pending.json').approvalUrl;

test('--renew: default, off, a named lease, and the refused lengths', () => {
  assert.equal(AGENT_GRANT_EXPIRY, days(GRANT_SECONDS));
  assert.ok(COURIER_DEFAULT_LEASE_SECONDS > GRANT_SECONDS, 'the default lease outlasts the default grant');
  assert.equal(renewalLeaseFor(undefined, GRANT_SECONDS), COURIER_DEFAULT_LEASE_SECONDS);
  assert.equal(renewalLeaseFor('off', GRANT_SECONDS), null);
  assert.equal(renewalLeaseFor(days(MAX_APPROVAL_LEASE_SECONDS), GRANT_SECONDS), MAX_APPROVAL_LEASE_SECONDS);
  // A grant at least as long as the default lease asks for none by default.
  assert.equal(renewalLeaseFor(undefined, COURIER_DEFAULT_LEASE_SECONDS), null);
  assert.throws(() => renewalLeaseFor(days(MAX_APPROVAL_LEASE_SECONDS + 86_400), GRANT_SECONDS), usage);
  assert.throws(() => renewalLeaseFor(days(GRANT_SECONDS), GRANT_SECONDS), usage);
  assert.throws(() => renewalLeaseFor(days(GRANT_SECONDS - 86_400), GRANT_SECONDS), usage);
  assert.throws(() => renewalLeaseFor('soon', GRANT_SECONDS), usage);
});

scenario('init --request asks for the default lease; --renew names one; --renew off asks for none', async ({ fx, request }) => {
  const asked = await request();
  assert.deepEqual(await askedLease(fx, asked.openkeyUrl), { version: 1, leaseLifetimeSeconds: COURIER_DEFAULT_LEASE_SECONDS });
  const named = await request('--renew', '120d');
  assert.deepEqual(await askedLease(fx, named.openkeyUrl), { version: 1, leaseLifetimeSeconds: 120 * 86_400 });
  const off = await request('--renew', 'off');
  assert.equal(await askedLease(fx, off.openkeyUrl), undefined);
});

scenario('a refused --renew stops before any request is made', async ({ fx, courier }) => {
  for (const argv of [
    ['--request', '--renew', days(GRANT_SECONDS)],
    ['--request', '--renew', days(MAX_APPROVAL_LEASE_SECONDS + 86_400)],
    ['--wait', '--expiry', '7d', '--renew', '7d'],
    // A pasted code or grant file cannot carry a lease.
    ['--paste', '--renew', days(COURIER_DEFAULT_LEASE_SECONDS)],
    ['--grant-file', '-', '--renew', days(COURIER_DEFAULT_LEASE_SECONDS)],
  ]) {
    const run = await courier(...argv);
    assert.notEqual(run.code, 0, argv.join(' '));
    assert.match(run.stderr, /--renew/, argv.join(' '));
  }
  assert.equal(fx.created.length, 0);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('a saved request is resumed only for the same lease ask: a request without a lease never answers an ask for one', async ({ fx, request }) => {
  const leased = await request();
  assert.equal((await request()).openkeyUrl, leased.openkeyUrl);
  assert.equal((await request('--renew', days(COURIER_DEFAULT_LEASE_SECONDS))).openkeyUrl, leased.openkeyUrl);
  const other = await request('--renew', '120d');
  assert.notEqual(other.openkeyUrl, leased.openkeyUrl, 'a named lease of another length is a new request');
  assert.equal((await request()).openkeyUrl, other.openkeyUrl, 'the default ask resumes a leased request of any length');
  const off = await request('--renew', 'off');
  assert.notEqual(off.openkeyUrl, other.openkeyUrl, 'a leased request never answers --renew off');
  assert.equal((await request('--renew', 'off')).openkeyUrl, off.openkeyUrl);
  const plain = await request();
  assert.notEqual(plain.openkeyUrl, off.openkeyUrl, 'a request without a lease never answers the default ask');
  assert.deepEqual(await askedLease(fx, plain.openkeyUrl), { version: 1, leaseLifetimeSeconds: COURIER_DEFAULT_LEASE_SECONDS });
  assert.equal(fx.created.length, 4);
});

scenario('an approval without renewal installs the finite grant, keeps that answer, and its files are 0600', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const asked = await request();
  await fx.approve(asked.openkeyUrl, { result: { renewalChoice: 'finite' } });
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  const grant = readHome('grant.json');
  assert.equal(grant.renewalChoice, 'finite');
  assert.equal(grant.renewal, undefined);
  assert.equal(fx.created.length, 1, 'no second request');
  assert.equal(fx.acks.length, 1);
  for (const file of ['key.json', 'grant.json', 'profile.json']) {
    assert.equal(fs.statSync(homeFile(file)).mode & 0o777, 0o600, file);
  }
});

scenario('an approval that skips the renewal choice the request asked for is refused: nothing installed, no ack', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const asked = await request();
  await fx.approve(asked.openkeyUrl, { result: { renewalChoice: undefined } });
  const run = await courier('--wait');
  assert.notEqual(run.code, 0);
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
  assert.equal(fx.acks.length, 0);
});

/** Install a grant through `init --wait` with `argv` and `result`, then move the clock to just inside the automatic ask. */
async function installThenNearEnd(t, fx, request, courier, argv, result) {
  stubSpaceProbe(t, readySpace);
  const asked = await request(...argv);
  await fx.approve(asked.openkeyUrl, result ? { result } : {});
  assert.equal((await courier('--wait', ...argv)).code, 0);
  const end = Date.parse(readHome('grant.json').expiresAt);
  t.mock.method(Date, 'now', () => end - OWNER_ASK_AHEAD_MS + DAY);
}

scenario('after a finite answer the automatic re-approval asks without a lease', async ({ t, fx, request, courier }) => {
  await installThenNearEnd(t, fx, request, courier, [], { renewalChoice: 'finite' });
  const preflight = await preflightOwner({ request: true });
  assert.equal(preflight.state, 'live');
  assert.equal(fx.created.length, 2);
  assert.equal(await askedLease(fx, currentLink()), undefined);
});

scenario('a grant approved without a lease ask gets the default lease ask from the automatic re-approval', async ({ t, fx, request, courier }) => {
  await installThenNearEnd(t, fx, request, courier, ['--renew', 'off']);
  assert.equal(readHome('grant.json').renewalChoice, undefined);
  assert.equal((await preflightOwner({ request: true })).state, 'live');
  assert.deepEqual(await askedLease(fx, currentLink()), { version: 1, leaseLifetimeSeconds: COURIER_DEFAULT_LEASE_SECONDS });
});

scenario('an automatic request made without a lease, by a Courier that asked for none, is asked again once with the lease', async ({ t, fx, request, courier }) => {
  // A finite grant's episode asks without a lease; dropping the grant's finite mark gives the same state as an episode
  // started before requests asked for a lease.
  await installThenNearEnd(t, fx, request, courier, [], { renewalChoice: 'finite' });
  assert.equal((await preflightOwner({ request: true })).state, 'live');
  const old = currentLink();
  const { renewalChoice: _finite, ...grant } = readHome('grant.json');
  fs.writeFileSync(homeFile('grant.json'), JSON.stringify(grant), { mode: 0o600 });
  const again = await preflightOwner({ request: true });
  assert.equal(again.state, 'live');
  assert.equal(again.notify, true, 'the owner is shown the new link');
  assert.notEqual(again.approvalUrl, old);
  assert.equal(again.approvalUrl, currentLink());
  assert.deepEqual(await askedLease(fx, currentLink()), { version: 1, leaseLifetimeSeconds: COURIER_DEFAULT_LEASE_SECONDS });
  assert.equal(fx.created.length, 3);
  const third = await preflightOwner({ request: true });
  assert.equal(third.approvalUrl, again.approvalUrl, 'asked again once, then the new request is kept');
  assert.equal(loadOwnerEpisode().phase, 'requested');
  assert.equal(fx.created.length, 3);
});
