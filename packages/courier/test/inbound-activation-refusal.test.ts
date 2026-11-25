import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NodeWasmBindings, PrivateKeySigner, RuntimeDelegationRejectedError, serializeDelegation, type PortableDelegation } from '@tinycloud/node-sdk';
import { AGENT_GRANT, peerReadPermissions } from '../src/keys';
import { courierNode, currentInbound, peerKv } from '../src/node';
import { isAuthorizationRefusal } from '../src/errors';
import { maintainPeerSet, recordAuthorityRefusal, watchPeerEligible } from '../src/interim-runtime';
import { loadProfile, saveProfile, writeSecure, type Profile } from '../src/profile';
import { Watcher } from '../src/watch';
import { issuedFixture } from './support/issued-fixture.mjs';
import { installCourierRegistryFixture } from './support/registry-fixture.mjs';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const iso = (ms: number) => new Date(ms).toISOString();
const inbound = (d: PortableDelegation) => ({ cid: d.cid, expiresAt: d.expiry.toISOString(), delegation: serializeDelegation(d) });

async function pairing() {
  const home = fs.mkdtempSync('/var/tmp/tc4329-activation-');
  const previous = { COURIER_HOME: process.env.COURIER_HOME, COURIER_TEST_HOME: process.env.COURIER_TEST_HOME, COURIER_TEST: process.env.COURIER_TEST };
  Object.assign(process.env, { COURIER_HOME: path.join(home, 'alice'), COURIER_TEST_HOME: home, COURIER_TEST: '1' });
  cleanups.push(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const fixture = issuedFixture();
  const state = { refusal: undefined as { status: number; body: string } | undefined, authorization: '', reads: [] as string[] };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/delegate' && req.headers.authorization === state.authorization && state.refusal) {
      res.writeHead(state.refusal.status);
      res.end(state.refusal.body);
      return;
    }
    if (req.url === '/invoke') {
      const payload = JSON.parse(Buffer.from(String(req.headers.authorization).split('.')[1], 'base64url').toString());
      state.reads.push(...payload.prf);
    }
    await fixture.handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const host = `http://127.0.0.1:${address.port}`;
  const fetch = globalThis.fetch;
  installCourierRegistryFixture(host);
  cleanups.push(() => { globalThis.fetch = fetch; });
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const start = Date.now();
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
  async function owner(handle: string, seed: string) {
    const dir = path.join(home, handle);
    fs.mkdirSync(dir, { mode: 0o700 });
    const id = manager.createSessionKey(handle);
    const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: iso(start) };
    const signer = new PrivateKeySigner(seed.padStart(64, '0'));
    const address = await signer.getAddress();
    const spaceId = wasm.makeSpaceId(address, 1, 'agents');
    const ownerDid = `did:pkh:eip155:1:${address}`;
    const expiresAt = iso(start + 30 * 86_400_000);
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt: iso(start), expirationTime: expiresAt, spaceId, jwk: key.jwk });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    writeSecure(path.join(dir, 'key.json'), key);
    writeSecure(path.join(dir, 'grant.json'), { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid,
      spaceId, ownerDid, address, chainId: 1, verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt, receivedAt: iso(start) });
    const profile: Profile = { version: 4, host, openkeyHost: host, label: handle, selfHandle: handle, courierDid: key.did.split('#')[0],
      ownerDid, spaceId, grantExpiresAt: expiresAt, status: 'ready', peers: {} };
    return { home: dir, profile, node: await courierNode(profile, dir) };
  }
  const alice = await owner('alice', '1');
  for (const [handle, seed] of [['bob', '2'], ['carol', '3']]) {
    const peer = await owner(handle, seed);
    const outgoing = (await alice.node.delegateTo(peer.profile.courierDid, peerReadPermissions(handle, alice.profile.spaceId!), { expiry: '2d', requireActivation: true })).delegation;
    const incoming = (await peer.node.delegateTo(alice.profile.courierDid, peerReadPermissions('alice', peer.profile.spaceId!), { expiry: '2d', requireActivation: true })).delegation;
    alice.profile.peers[handle] = { handle, courierDid: peer.profile.courierDid, ownerDid: peer.profile.ownerDid!, spaceId: peer.profile.spaceId!,
      theirHandleForMe: 'alice', status: 'paired', pairedAt: iso(start), inbound: inbound(incoming), outbound: [{ ...inbound(outgoing), issuedAt: iso(start) }] };
    if (handle === 'bob') state.authorization = incoming.delegationHeader.Authorization;
  }
  process.env.COURIER_HOME = alice.home;
  saveProfile(alice.profile);
  return { ...alice, state };
}

test('revoked inbound activation latches only that peer, collects other peers and stops watcher sync errors', async () => {
  const { home, profile, state } = await pairing();
  const cid = profile.peers.bob.inbound!.cid;
  // Node #760 @b4710710: tinycloud-node-server/src/routes/mod.rs:328–350,394–397;
  // tinycloud-core/src/models/revocation.rs:39–41 and models/delegation.rs:177–184.
  // Policy/v3 stays plain text: tinycloud-node-server/src/policy_v3.rs:61–69,301–313.
  for (const refusal of [
    { status: 401, body: JSON.stringify({ code: 'delegation_revoked', error: `delegation-revoked: ${cid}` }) },
    { status: 401, body: JSON.stringify({ code: 'parent_revoked', error: `delegation-parent-revoked: ${cid}` }) },
    { status: 401, body: JSON.stringify({ code: 'ancestor_revoked', error: `delegation-ancestor-revoked: ancestor=${cid} parent=${cid}` }) },
    { status: 403, body: 'policy-session-root-status-invalid' },
  ]) {
    saveProfile(structuredClone(profile));
    state.refusal = refusal;
    state.reads.length = 0;
    await maintainPeerSet(await courierNode(profile, home), undefined, true);
    assert.ok(loadProfile().peers.bob.interim?.inboundRefusedAt, refusal.body);
    assert.equal(watchPeerEligible(loadProfile().peers.bob), false);
    assert.equal(loadProfile().peers.carol.interim?.inboundRefusedAt, undefined);
    assert.ok(state.reads.includes(profile.peers.carol.inbound!.cid), 'the remaining peer is collected');

    saveProfile(structuredClone(profile));
    const node = await courierNode(profile, home);
    const events: string[] = [];
    const watcher = new Watcher({
      selfKv: node.kv, spaceId: profile.spaceId!, loadPeers: () => Object.values(loadProfile().peers).filter(peer => watchPeerEligible(peer)),
      kvFor: peer => peerKv(node, loadProfile(), peer, { renew: false }), onAuthorityRefusal: recordAuthorityRefusal,
      log: event => { events.push(event); },
    }, { pollMs: 60_000, ticketSeconds: 25, debounceMs: 30_000, wakeBudget: 12 });
    await watcher.sync(profile.peers.bob, 'hook');
    await watcher.syncDirty();
    assert.ok(loadProfile().peers.bob.interim?.inboundRefusedAt, refusal.body);
    assert.equal(events.includes('sync-error'), false);
  }
}, 30_000);

test('other activation refusals retain the SDK classification without latching a peer', async () => {
  const { node, profile, state } = await pairing();
  for (const refusal of [
    { status: 401, body: JSON.stringify({ code: 'invalid_signature', error: 'delegation_revoked' }) },
    { status: 401, body: 'delegation_revoked' },
    { status: 401, body: `delegation-revoked: ${profile.peers.bob.inbound!.cid}` },
    { status: 403, body: 'unrelated refusal: policy-session-root-status-invalid' },
  ]) {
    state.refusal = refusal;
    await assert.rejects(currentInbound(node, profile, profile.peers.bob), error => {
      assert.ok(error instanceof RuntimeDelegationRejectedError);
      assert.equal(error.reason, refusal.status === 401 ? 'activation_unauthenticated' : 'activation_rejected');
      assert.equal(isAuthorizationRefusal(error), false);
      assert.ok(error.cause && typeof error.cause === 'object' && 'status' in error.cause && 'error' in error.cause);
      assert.equal(error.cause.status, refusal.status);
      assert.equal(error.cause.error, refusal.body);
      return true;
    });
    assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, undefined);
  }
}, 30_000);
