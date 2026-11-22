// TC-3485: Bobbie's post-merge review of #1096 (08fec32d). A renewal passes its pre-issue save (lastAttemptAt only,
// not the child), then a concurrent `revoke` takes its one inventory pass and deletes the pairing before the
// renewal activates its successor. On the current master the renewal's receipt save then throws `peer-revoked`
// outside the cleanup try, so the just-activated child is never revoked: an orphan, live on the node for up to 30
// days, with no local pairing left to find it.
//
// This reproduces the race deterministically (no timing flakiness): the renewal's own `node.delegateTo` is wrapped
// to run a full, real `tc revoke bob` to completion — including the local pairing delete — strictly between the
// renewal's pre-issue checks (which still see the pairing and the old child live) and the node activating the
// renewal's successor. That is exactly Bobbie's reported ordering, just forced instead of awaited.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { issuedFixture } from './support/issued-fixture.mjs';
import { installCourierRegistryFixture } from './support/registry-fixture.mjs';
import { AGENT_GRANT, peerReadPermissions } from '../dist/keys.js';
import { saveProfile, loadProfile, writeSecure } from '../dist/profile.js';
import { courierNode } from '../dist/node.js';
import { cmdRevoke } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { maintainOutbound } from '../dist/interim-renewal.js';

test('a revoke that finishes while a renewal is mid-activation leaves no live orphan child', async (t) => {
  const home = process.env.COURIER_HOME;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const api = issuedFixture();
  const server = http.createServer((req, res) => { api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = `http://127.0.0.1:${server.address().port}`;
  process.env.TC_LINKS_API_ORIGIN = host;
  process.env.COURIER_OPENKEY_API_HOST = host;

  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
  const owner = new PrivateKeySigner('1'.padStart(64, '0'));
  installCourierRegistryFixture(host);
  const address = await owner.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, 'agents');
  const abilities = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: new Date().toISOString(), expirationTime: expiresAt, spaceId, jwk: key.jwk });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const profile = { version: 3, host, openkeyHost: host, label: 'fixture', courierDid: key.did.split('#')[0], ownerDid, spaceId, status: 'ready', peers: {} };
  writeSecure(path.join(home, 'key.json'), key);
  writeSecure(path.join(home, 'grant.json'), {
    v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, siwe: prepared.siwe,
    signature, expiresAt, spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did,
  });
  saveProfile(profile);
  const node = await courierNode(profile);

  // Pair with bob on a short-lived (1h) delegation, so the renewal below is eligible to replace it.
  const peerId = manager.createSessionKey('bob');
  const courierDid = manager.getDID(peerId).split('#')[0];
  const { delegation } = await node.delegateTo(courierDid, peerReadPermissions('bob', spaceId), { expiry: '1h', requireActivation: true });
  profile.peers.bob = {
    handle: 'bob', courierDid, ownerDid, spaceId, status: 'paired', pairedAt: new Date().toISOString(),
    outbound: [{ cid: delegation.cid, issuedAt: new Date().toISOString(), expiresAt: delegation.expiry.toISOString() }],
  };
  saveProfile(profile);

  // A renewal daemon's own process loaded the profile earlier, before the revoke below ever starts.
  const renewalProfile = loadProfile();
  const renewalPeer = renewalProfile.peers.bob;

  const realDelegateTo = node.delegateTo.bind(node);
  let revokeRanMidFlight = false;
  node.delegateTo = async (...callArgs) => {
    // Simulates a separate `tc revoke bob` process completing entirely — inventory, revoke, local delete — while
    // this renewal is between its pre-issue checks (already passed, old child still live) and node activation.
    const quiet = t.mock.method(console, 'log', () => {});
    try {
      await cmdRevoke(parseArgs(['bob']));
    } finally {
      quiet.mock.restore();
    }
    revokeRanMidFlight = true;
    return realDelegateTo(...callArgs);
  };

  await assert.rejects(
    maintainOutbound(node, renewalProfile, renewalPeer, () => saveProfile(renewalProfile), { force: true, manual: true }),
    /peer-revoked|revoked while this command was running/,
  );
  assert.ok(revokeRanMidFlight, 'the revoke ran to completion while the renewal was mid-activation');
  assert.equal(loadProfile().peers.bob, undefined, 'the pairing is gone locally');

  // Ground truth from the node itself: no live, unrevoked child survives the race.
  const listed = await node.delegationManager.queryAllIssued({ space: spaceId });
  const orphans = listed.data.filter((r) => r.delegateDid === courierDid && r.status === 'active');
  assert.deepEqual(orphans, [], `no live child delegation survives the race: ${JSON.stringify(orphans)}`);
});
