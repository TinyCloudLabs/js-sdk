// Independent local reproduction: real signed owner grants and encrypted held result, fixture transports only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scenario, signedGrant, stubSpaceProbe, readySpace, homeFile, readHome, DAY } from './support/approval-fixture.mjs';
import { loadKey, loadProfile, writeSecure } from '../dist/profile.js';
import { requestHash } from '../dist/canonical.js';
import { approvalIntent } from '../dist/grant-request.js';

scenario('a permanently stale held episode blocks plain request; explicit key rotation clears pairing and can recover', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const wallet = '2'.padStart(64, '0');
  const first = await request('--host', 'https://node.fixture.test');
  await fx.approve(first.openkeyUrl, { grant: { wallet, lifetimeMs: DAY } });
  const pending = readHome('approval-pending.json');
  const approved = fx.approvals.get(pending.requestId);
  pending.resultRef = approved.resultRef;
  pending.resultEnvelope = approved.relay;
  pending.resultExpiresAt = approved.expiresAt;
  writeSecure(homeFile('approval-pending.json'), pending);
  const key = loadKey();
  const current = await signedGrant(key, { wallet, lifetimeMs: 20 * DAY });
  const endOf = grant => new Date(grant.siwe.match(/^Expiration Time:\s*(.+)$/m)[1]).toISOString();
  writeSecure(homeFile('grant.json'), { ...current, v: 1, ownerDid: `did:pkh:eip155:1:${current.address}`,
    expiresAt: endOf(current), receivedAt: new Date().toISOString() });
  const profile = loadProfile();
  Object.assign(profile, { version: 4, ownerDid: `did:pkh:eip155:1:${current.address}`, spaceId: current.spaceId,
    grantExpiresAt: endOf(current), status: 'ready', peers: { bob: { handle: 'bob', status: 'paired',
      courierDid: 'did:key:fixture-peer', outbound: [], pairedAt: new Date().toISOString() } } });
  writeSecure(homeFile('profile.json'), profile);
  writeSecure(homeFile('renewal-owner.json'), { ownerGrantCid: approved.grant.delegationCid, expiresAt: endOf(approved.grant),
    courierDid: profile.courierDid, intentHash: requestHash(approvalIntent(profile, key)), requestId: pending.requestId,
    requestHash: requestHash(pending.request), phase: 'requested' });
  const before = Object.fromEntries(['grant.json', 'key.json', 'approval-pending.json'].map(name => [name, fs.readFileSync(homeFile(name), 'utf8')]));
  const stale = await courier('--wait', '--timeout', '1s');
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /\[stale-approval\]/);
  assert.match(stale.stderr, /init --rotate-key --request/);
  assert.match(stale.stderr, /removes all your pairings/);
  assert.match(stale.stderr, /old approval stays valid/);
  const again = await courier('--request');
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already been approved by the owner/);
  assert.match(again.stderr, /init --rotate-key --request/);
  assert.equal(fx.created.length, 1);
  assert.equal(fx.acks.length, 0);
  for (const [name, text] of Object.entries(before)) assert.equal(fs.readFileSync(homeFile(name), 'utf8'), text, name);
  assert.ok(loadProfile().peers.bob);

  const rotated = await courier('--rotate-key', '--request');
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.notEqual(loadKey().did, key.did);
  assert.deepEqual(loadProfile().peers, {});
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
  assert.notEqual(readHome('approval-pending.json').requestId, pending.requestId);
  assert.equal(fx.created.length, 2);
  await fx.approve(JSON.parse(rotated.stdout).openkeyUrl, { grant: { wallet, lifetimeMs: 20 * DAY } });
  const recovered = await courier('--wait', '--timeout', '1s');
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.notEqual(readHome('grant.json').delegationCid, approved.grant.delegationCid, 'the stale held approval was never installed');
  assert.equal(fx.acks.length, 1);
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});
