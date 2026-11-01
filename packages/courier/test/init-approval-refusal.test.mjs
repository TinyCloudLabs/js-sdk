import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PREFIX } from '../dist/keys.js';
import { loadProfile } from '../dist/profile.js';
import {
  DAY, grantExtraHost, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2308: every refusal of a collected or imported grant tells the agent (and so the owner) which delegation was
// refused, what was different or too broad, that nothing was installed or used, and where the owner can revoke it.
// It never prints the delegation header, the SIWE signature or a key.

const ROUTE = 'https://account.tinycloud.xyz/delegations';
const requestId = (link) => new URL(link).pathname.split('/')[2];
const WALLET_A = '11'.repeat(32);
const WALLET_B = '22'.repeat(32);

/** The refusal's stderr text: carries the CID, the route and the plain statements, and none of the secrets. */
function assertNotice(stderr, grant, { code, what }) {
  assert.match(stderr, new RegExp(`\\[${code}\\]`));
  assert.ok(stderr.includes(grant.delegationCid), 'names the refused delegation by its CID');
  assert.ok(stderr.includes(ROUTE), 'names the revoke route');
  assert.match(stderr, /cannot revoke/);
  assert.match(stderr, /Nothing was installed or used/);
  assert.match(stderr, /`courier init --request`/);
  assert.match(stderr, what, 'says what was too broad or different');
  assert.equal(stderr.includes(grant.delegationHeader.Authorization), false, 'never the delegation header');
  assert.equal(stderr.includes(grant.signature), false, 'never the SIWE signature');
  assert.equal(stderr.includes(readHome('key.json').jwk.d), false, 'never a key');
}

const newFlowClasses = [
  ['grant-too-broad: host authority beyond the agent grant', 'grant-too-broad', { grant: { extra: [grantExtraHost()] } }, /tinycloud\.space\/host/],
  ['grant-too-broad: a widened hooks scope', 'grant-too-broad', { grant: { hooksPath: `kv/${PREFIX}/me/state/` } }, new RegExp(`kv/${PREFIX}/me/state/`)],
  ['grant-incomplete: the hooks permission missing', 'grant-incomplete', { grant: { omit: ['tinycloud.hooks'] } }, /is missing tinycloud\.hooks/],
  ['grant-too-long: a 365 day grant', 'grant-too-long', { grant: { lifetimeMs: 365 * DAY } }, /365 days/],
  ['bad-grant: a delegation bound to another agent key', 'bad-grant', { delegation: { verificationMethod: 'did:key:z6Mkother#z6Mkother' } }, /verification method does not match/],
  ['bad-grant: an owner that differs from the delegation address', 'bad-grant', { result: { ownerDid: 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222' } }, /different owner than its delegation/],
  ['approval-result-invalid: a result for another request digest', 'approval-result-invalid', { result: { requestDigest: 'bafkreiother' } }, /requestDigest/],
  ['approval-result-invalid: a result for another requester and target', 'approval-result-invalid', { result: { requesterDid: 'did:key:z6Mkother', targetDid: 'did:key:z6Mkother' } }, /requesterDid, targetDid/],
];

for (const [name, code, approve, what] of newFlowClasses) {
  scenario(`init --wait refusal, ${name}: CID, what differed and the revoke route, no secrets`, async ({ t, fx, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    const printed = await request();
    await fx.approve(printed.openkeyUrl, approve);
    const run = await courier('--wait');
    assert.equal(run.code, 1);
    assertNotice(run.stderr, fx.approvals.get(requestId(printed.openkeyUrl)).grant, { code, what });
    assert.equal(fs.existsSync(homeFile('grant.json')), false);
    assert.equal(fx.acks.length, 0);
  });
}

scenario('init --wait refusal, approval-result-invalid: a renewal approved by another owner names both owners, the CID and the revoke route', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const first = await request();
  await fx.approve(first.openkeyUrl, { grant: { wallet: WALLET_A } });
  assert.equal((await courier('--wait')).code, 0);
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { grant: { wallet: WALLET_B } });
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assertNotice(run.stderr.split('\n').slice(-12).join('\n'), fx.approvals.get(requestId(printed.openkeyUrl)).grant, { code: 'approval-result-invalid', what: /different owner/ });
});

scenario('a refusal that fails before any delegation can be read still says nothing was installed (no CID to name)', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const kept = fx.approvals.get(requestId(printed.openkeyUrl));
  kept.relay = { ...kept.relay, nonce: Buffer.alloc(12).toString('base64url') }; // decrypts to nothing
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-result-invalid\]/);
  assert.match(run.stderr, /Nothing was installed or used/);
  assert.equal(run.stderr.includes(ROUTE), false, 'no delegation was read, so there is nothing to revoke');
});

const legacyClasses = [
  ['grant-too-broad: host authority beyond the agent grant', 'grant-too-broad', { extra: [grantExtraHost()] }, /tinycloud\.space\/host/],
  ['grant-too-broad: a widened hooks scope', 'grant-too-broad', { hooksPath: `kv/${PREFIX}/me/state/` }, new RegExp(`kv/${PREFIX}/me/state/`)],
  ['grant-incomplete: the hooks permission missing', 'grant-incomplete', { omit: ['tinycloud.hooks'] }, /is missing tinycloud\.hooks/],
  ['grant-too-long: a 365 day grant', 'grant-too-long', { lifetimeMs: 365 * DAY }, /365 days/],
];

for (const [name, code, options, what] of legacyClasses) {
  scenario(`legacy init --grant-file refusal, ${name}: same notice`, async ({ t, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    await request();
    const grant = await signedGrant(readHome('key.json'), options);
    fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
    const run = await courier('--grant-file', homeFile('legacy-grant.json'));
    assert.equal(run.code, 1);
    assertNotice(run.stderr, grant, { code, what });
    assert.equal(fs.existsSync(homeFile('grant.json')), false);
    assert.equal(loadProfile().status, 'awaiting-grant');
  });
}

test('the README and both skill copies tell the agent what to do when a grant is refused', () => {
  const sentence = 'If a grant is refused, nothing was installed; tell the owner to revoke the listed delegation at account.tinycloud.xyz/delegations, then run `init --request` for a new link.';
  for (const relative of ['../README.md', '../skills/courier/SKILL.md', '../../cli/skills/courier/SKILL.md']) {
    const text = fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\s+/g, ' ');
    assert.ok(text.includes(sentence), `${relative} must say: ${sentence}`);
  }
});
