import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createECDH } from 'node:crypto';
import { main } from '../dist/main.js';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { AGENT_GRANT } from '../dist/keys.js';
import { loadProfile } from '../dist/profile.js';
import {
  captureStdout, Crash, crashAtWrite, DAY, fakeTime, grantExtraHost, homeFile, missingSpace, readHome, readySpace, scenario, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2300: `courier init --request` prints OpenKey's short approval link and `courier init --wait` collects the result.
// The services are synthetic (see support/approval-fixture.mjs): a real SIWE grant is signed by a throwaway wallet and
// installed by the real installGrant; only OpenKey, the links API and the space probe are fake.

const pendingFile = () => readHome('approval-pending.json');
const requestId = (link) => new URL(link).pathname.split('/')[2];
const polls = (fx, action) => fx.calls.filter((call) => call.action === action).length;

scenario('init --request prints the short link in the existing JSON shape and saves the pending request first', async ({ request }) => {
  let pendingAtPrint;
  let out = '';
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return write.call(process.stdout, chunk, ...rest);
    pendingAtPrint ??= fs.existsSync(homeFile('approval-pending.json'));
    out += chunk;
    return true;
  };
  let code;
  try { code = await main(['init', '--request', '--handle', 'alice']); } finally { process.stdout.write = write; }
  assert.equal(code, 0);
  assert.equal(pendingAtPrint, true, 'the pending record must exist before the link is printed');
  const printed = JSON.parse(out);
  assert.deepEqual(Object.keys(printed), ['did', 'courierDid', 'publicJwk', 'host', 'space', 'permissions', 'expiry', 'openkeyUrl']);
  assert.match(printed.openkeyUrl, /^https:\/\/openkey\.so\/a\/[a-z2-7]{26}#v=4&k=[A-Za-z0-9_-]+&c=[A-Za-z0-9_-]+$/);
  assert.equal('d' in printed.publicJwk, false);
  assert.deepEqual(printed.permissions, AGENT_GRANT);
  assert.equal(printed.expiry, '30d');
  assert.equal(printed.space, 'agents');
  assert.equal(await request().then((again) => again.openkeyUrl), printed.openkeyUrl);
});

scenario('the stored approval request is bound to the agent key, exact AGENT_GRANT permissions and a 30 day lifetime', async ({ fx, request }) => {
  const printed = await request();
  assert.equal(fx.created.length, 1);
  const sealed = await fx.openRequest(printed.openkeyUrl);
  assert.equal(sealed.issuer, printed.courierDid);
  assert.equal(sealed.targetDid, printed.courierDid);
  assert.doesNotMatch(sealed.issuer, /#/);
  assert.deepEqual(Object.keys(sealed.targetPublicJwk).sort(), ['crv', 'kty', 'x']);
  assert.equal(sealed.targetPublicJwk.x, printed.publicJwk.x);
  assert.equal(sealed.nodeOrigin, printed.host);
  assert.deepEqual(sealed.permissions, AGENT_GRANT);
  assert.ok(sealed.permissions.some((entry) => entry.service === 'tinycloud.hooks' && entry.actions.includes('tinycloud.hooks/subscribe')));
  assert.equal(sealed.grantLifetimeSeconds, 2_592_000);
  // The relay key in the request is the one whose private half the pending record keeps.
  const relay = createECDH('prime256v1');
  relay.setPrivateKey(Buffer.from(pendingFile().relayPrivateKey, 'base64url'));
  const point = relay.getPublicKey();
  assert.equal(sealed.resultEncryptionPublicJwk.x, point.subarray(1, 33).toString('base64url'));
  assert.equal(sealed.resultEncryptionPublicJwk.y, point.subarray(33).toString('base64url'));
});

scenario('the pending record is owner-only and carries no agent private key', async ({ request }) => {
  const printed = await request();
  assert.equal(fs.statSync(homeFile('approval-pending.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(process.env.COURIER_HOME).mode & 0o777, 0o700);
  const raw = fs.readFileSync(homeFile('approval-pending.json'), 'utf8');
  const agentKey = readHome('key.json');
  assert.equal(raw.includes(agentKey.jwk.d), false);
  assert.equal(pendingFile().approvalUrl, printed.openkeyUrl);
});

scenario('a second --request reuses the pending request; a different lifetime or key makes a new one', async ({ fx, request }) => {
  const first = await request();
  const again = await request();
  assert.equal(again.openkeyUrl, first.openkeyUrl);
  assert.equal(fx.created.length, 1);
  const shorter = await request('--expiry', '7d');
  assert.notEqual(shorter.openkeyUrl, first.openkeyUrl);
  assert.equal(fx.created.length, 2);
  assert.equal((await fx.openRequest(shorter.openkeyUrl)).grantLifetimeSeconds, 604_800);
  assert.equal(pendingFile().requestId, requestId(shorter.openkeyUrl));
  const rotated = await request('--rotate-key');
  assert.notEqual(rotated.did, first.did);
  assert.equal(fx.created.length, 3);
  assert.equal(pendingFile().request.issuer, rotated.courierDid);
});

scenario('a failing links API leaves no pending record and no stdout', async ({ fx, courier }) => {
  fx.linksStatus = 503;
  const run = await courier('--request');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[link-unavailable\]/);
  assert.equal(run.stdout, '');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('init --wait installs the approved grant, then acknowledges once, only after the grant and profile are saved', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.courierDid, printed.courierDid);
  assert.match(result.ownerDid, /^did:pkh:eip155:1:0x/);
  const profile = loadProfile();
  assert.equal(profile.status, 'ready');
  assert.equal(profile.ownerDid, result.ownerDid);
  assert.equal(fx.acks.length, 1);
  assert.equal(fx.acks[0].saved.grant.delegationCid, readHome('grant.json').delegationCid);
  assert.equal(fx.acks[0].saved.profileStatus, 'ready');
  assert.equal(fx.acks[0].saved.pending.committed, true);
  assert.equal(fx.created.length, 1, 'no second request');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  assert.equal(fs.statSync(homeFile('grant.json')).mode & 0o777, 0o600);
});

scenario('init --wait with no pending request makes one, shows the link on stderr and installs when the owner approves', async ({ t, fx, courier, errors }) => {
  stubSpaceProbe(t, readySpace);
  fakeTime(t);
  fx.pollsBeforeApproval = 2;
  fx.autoApprove = {}; // the owner approves during the third poll, once the request (and its link) exist
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fx.created.length, 1);
  assert.equal(fx.acks.length, 1);
  assert.match(errors.join('\n'), /https:\/\/openkey\.so\/a\/[a-z2-7]{26}#v=4/);
  assert.equal(JSON.parse(run.stdout).ok, true);
});

for (const [name, approve, code] of [
  ['signed host authority beyond the agent grant', { grant: { extra: [grantExtraHost()] } }, 'grant-too-broad'],
  ['a grant missing the hooks permission', { grant: { omit: ['tinycloud.hooks'] } }, 'grant-incomplete'],
  ['a 365 day grant', { grant: { lifetimeMs: 365 * DAY } }, 'grant-too-long'],
  ['a result for another request digest', { result: { requestDigest: 'bafkreiother' } }, 'approval-result-invalid'],
  ['a result for another requester', { result: { requesterDid: 'did:key:z6Mkother' } }, 'approval-result-invalid'],
  ['a result for another target', { result: { targetDid: 'did:key:z6Mkother' } }, 'approval-result-invalid'],
  ['a result for another request id', { result: { requestId: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' } }, 'approval-result-invalid'],
  ['a result whose owner differs from the delegation address', { result: { ownerDid: 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222' } }, 'bad-grant'],
  ['a result whose expiry differs from the signed expiry', { result: { delegationExpiresAt: new Date(Date.now() + 3600_000).toISOString() } }, 'bad-grant'],
  ['a delegation bound to another agent key', { delegation: { verificationMethod: 'did:key:z6Mkother#z6Mkother' } }, 'bad-grant'],
  ['a delegation carrying another public key', { delegation: { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } } }, 'bad-grant'],
]) {
  scenario(`init --wait refuses ${name}: nothing installed, no ack, the request is dropped`, async ({ t, fx, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    const printed = await request();
    await fx.approve(printed.openkeyUrl, approve);
    const run = await courier('--wait');
    assert.equal(run.code, 1);
    assert.match(run.stderr, new RegExp(`\\[${code}\\]`));
    assert.equal(fs.existsSync(homeFile('grant.json')), false);
    assert.equal(loadProfile().status, 'awaiting-grant');
    assert.equal(fx.acks.length, 0);
    assert.equal(fs.existsSync(homeFile('approval-pending.json')), false, 'a refused result must not be retried forever');
    const next = await request();
    assert.notEqual(next.openkeyUrl, printed.openkeyUrl);
  });
}

scenario('a failed save sends no ack, keeps the approved result, and the next run finishes without polling or a new request', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fs.mkdirSync(homeFile('grant.json')); // saveGrant's rename onto a directory fails
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.equal(fx.acks.length, 0);
  const kept = pendingFile();
  assert.ok(kept.resultEnvelope, 'the encrypted result is kept for the retry');
  assert.equal(JSON.stringify(kept).includes('"siwe"'), false, 'the result stays encrypted at rest');
  const before = { discover: polls(fx, 'discover'), fetch: polls(fx, 'fetch') };
  fs.rmdirSync(homeFile('grant.json'));
  const retry = await courier('--wait');
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual({ discover: polls(fx, 'discover'), fetch: polls(fx, 'fetch') }, before);
  assert.equal(fx.acks.length, 1);
  assert.equal(fx.created.length, 1);
});

const killSeams = [
  ['after the poll finds the result, before it is saved', 'approval-pending.json', 'before', (c) => c.resultRef !== undefined && c.resultEnvelope === undefined, { discover: 2, fetch: 1 }],
  ['after the fetch, before the encrypted result is saved', 'approval-pending.json', 'before', (c) => c.resultEnvelope !== undefined, { discover: 1, fetch: 2 }],
  ['after the encrypted result is saved, before install', 'approval-pending.json', 'after', (c) => c.resultEnvelope !== undefined, { discover: 1, fetch: 1 }],
  ['inside install, after grant.json and before the profile', 'grant.json', 'after', () => true, { discover: 1, fetch: 1 }],
  ['after install, before the commit marker', 'approval-pending.json', 'before', (c) => c.committed === true, { discover: 1, fetch: 1 }],
];
for (const [name, file, phase, when, expected] of killSeams) {
  scenario(`killed ${name}: nothing acknowledged, and the next --wait finishes with no new request or approval`, async ({ t, fx, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    const printed = await request();
    await fx.approve(printed.openkeyUrl);
    const crash = crashAtWrite(t, file, { phase, when });
    await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
    assert.equal(crash.fired(), true);
    crash.disarm();
    assert.equal(fx.acks.length, 0, 'a killed process never acknowledges');
    if (file === 'grant.json') assert.equal(loadProfile().status, 'awaiting-grant');
    const retry = await courier('--wait');
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(loadProfile().status, 'ready');
    assert.deepEqual({ discover: polls(fx, 'discover'), fetch: polls(fx, 'fetch') }, expected);
    assert.equal(fx.acks.length, 1);
    assert.equal(new Set(fx.acks.map((ack) => ack.ackId)).size, 1);
    assert.equal(fx.created.length, 1);
  });
}

scenario('killed while waiting for the agents space: the grant is saved, no ack, and the next --wait completes it', async ({ t, fx, request, courier }) => {
  fakeTime(t);
  let probes = 0;
  stubSpaceProbe(t, async () => {
    if (++probes === 1) return missingSpace();
    if (probes === 2) throw new Crash('during waitForSpaceReady');
    return readySpace();
  });
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { delegation: { spaceReady: null, spacePending: true } });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  assert.equal(loadProfile().status, 'awaiting-space');
  assert.equal(fs.existsSync(homeFile('grant.json')), true);
  assert.equal(fx.acks.length, 0);
  const retry = await courier('--wait');
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fx.acks.length, 1);
  assert.equal(fx.created.length, 1);
});

scenario('an agents space that is not ready yet: grant and profile saved, acknowledged, and `init --resume` finishes later', async ({ t, fx, request, courier, errors }) => {
  const clock = fakeTime(t);
  let ready = false;
  stubSpaceProbe(t, async () => (ready ? readySpace() : missingSpace()));
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { delegation: { spaceReady: null, spacePending: true } });
  const run = await courier('--wait', '--timeout', '30s');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[no-space\].*OpenKey is still setting up.*init --resume/s);
  assert.ok(clock.elapsed() < 40_000, `the space wait is bounded by --timeout (waited ${clock.elapsed()} ms)`);
  assert.equal(fx.acks.length, 1);
  assert.equal(fx.acks[0].saved.profileStatus, 'awaiting-space');
  assert.ok(fx.acks[0].saved.grant.delegationCid);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  ready = true;
  const resumed = await courier('--resume');
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(loadProfile().status, 'ready');
});

scenario('--wait --timeout ends with exit 8 and the pending JSON, keeps the request, and a later --wait finishes it', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const clock = fakeTime(t);
  const printed = await request();
  const run = await courier('--wait', '--timeout', '5s');
  assert.equal(run.code, 8);
  const { pending } = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(JSON.parse(run.stdout)), ['pending']);
  assert.equal(pending.step, 1);
  assert.equal(pending.of, 1);
  assert.equal(pending.approvalUrl, printed.openkeyUrl);
  assert.equal(pending.expiresAt, pendingFile().requestExpiresAt);
  assert.ok(Number.isFinite(Date.parse(pending.expiresAt)));
  assert.ok(clock.elapsed() >= 5000 && clock.elapsed() < 9000, `waited ${clock.elapsed()} ms`);
  assert.equal(pendingFile().requestId, requestId(printed.openkeyUrl));
  assert.equal(pendingFile().committed, undefined);
  assert.equal(fx.acks.length, 0);
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
  await fx.approve(printed.openkeyUrl);
  const done = await courier('--wait', '--timeout', '5s');
  assert.equal(done.code, 0, done.stderr);
  assert.equal(fx.created.length, 1);
  assert.equal(fx.acks.length, 1);
});

scenario('--wait without --timeout stops after 90 seconds, not never', async ({ t, courier, request }) => {
  const clock = fakeTime(t);
  await request();
  const run = await courier('--wait');
  assert.equal(run.code, 8);
  assert.ok(clock.elapsed() >= 90_000 && clock.elapsed() < 95_000, `waited ${clock.elapsed()} ms`);
});

scenario('--timeout accepts up to 9 minutes and refuses anything else before touching the profile', async ({ t, courier }) => {
  const clock = fakeTime(t);
  assert.equal((await courier('--wait', '--timeout', '9m')).code, 8);
  assert.ok(clock.elapsed() >= 540_000 && clock.elapsed() < 545_000);
  const before = fs.readdirSync(process.env.COURIER_HOME).sort();
  for (const argv of [['--wait', '--timeout', '10m'], ['--wait', '--timeout', '541s'], ['--wait', '--timeout', '0s'], ['--wait', '--timeout', 'soon'], ['--wait', '--timeout']]) {
    const run = await courier(...argv);
    assert.equal(run.code, 2, argv.join(' '));
  }
  assert.deepEqual(fs.readdirSync(process.env.COURIER_HOME).sort(), before);
});

scenario('--timeout without --wait, and --wait with another init mode, are usage errors that change nothing', async ({ courier }) => {
  for (const argv of [['--timeout', '5s'], ['--wait', '--request'], ['--wait', '--paste'], ['--wait', '--grant-file', 'x.json'], ['--wait', '--resume']]) {
    const run = await courier(...argv);
    assert.equal(run.code, 2, argv.join(' '));
  }
  assert.equal(fs.existsSync(process.env.COURIER_HOME), false);
});

scenario('a request OpenKey says expired: clear error, the request is dropped, and --request makes a new one', async ({ fx, request, courier }) => {
  const printed = await request();
  fx.expiredRequests.add(requestId(printed.openkeyUrl));
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-expired\].*init --request/s);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  const next = await request();
  assert.notEqual(next.openkeyUrl, printed.openkeyUrl);
  assert.equal(fx.created.length, 2);
});

scenario('a request whose own expiry has passed is refused without polling', async ({ fx, request, courier }) => {
  await request();
  const pending = pendingFile();
  fs.writeFileSync(homeFile('approval-pending.json'), JSON.stringify({ ...pending, requestExpiresAt: new Date(Date.now() - 1000).toISOString() }), { mode: 0o600 });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-expired\]/);
  assert.equal(fx.calls.length, 0);
  assert.equal((await request()).openkeyUrl === pending.approvalUrl, false);
});

scenario('a result OpenKey no longer holds (600 s retention) is reported plainly: nothing installed, run init --request again', async ({ fx, request, courier }) => {
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.expiredResults.add(requestId(printed.openkeyUrl));
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-result-expired\]/);
  assert.match(run.stderr, /10 minutes/);
  assert.match(run.stderr, /`courier init --request`/);
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
  assert.equal(fx.acks.length, 0);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  fx.expiredResults.clear();
  const next = await request();
  assert.notEqual(next.openkeyUrl, printed.openkeyUrl);
});

scenario('a dropped ack after a successful install still succeeds; the next --wait only retries the ack', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.dropNextAck = true;
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  assert.match(run.stderr, /acknowledg/i);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fx.acks.length, 0);
  assert.equal(pendingFile().committed, true);
  const before = { discover: polls(fx, 'discover'), fetch: polls(fx, 'fetch') };
  const again = await courier('--wait');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.acks.length, 1);
  assert.deepEqual({ discover: polls(fx, 'discover'), fetch: polls(fx, 'fetch') }, before);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
  assert.equal(fx.created.length, 1);
});
