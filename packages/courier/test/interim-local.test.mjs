// Opt in with TC_COURIER_INTERIM_NODE_BIN, a known local node build. No external endpoint is accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createPrivateKey, sign } from 'node:crypto';
import { TinyCloudNode, NodeWasmBindings, PrivateKeySigner, serializeDelegation } from '@tinycloud/node-sdk';
import { activateSessionWithHost, DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL } from '@tinycloud/sdk-core';
import { courierRegistryFixtureEnv, installCourierRegistryFixture } from './support/registry-fixture.mjs';
import { courierNode, peerKv, nodeOpts } from '../dist/node.js';
import { cmdRevoke } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile, saveProfile, withProfileTransaction } from '../dist/profile.js';
import { AGENT_GRANT, k, peerReadPermissions } from '../dist/keys.js';

import { maintainOutbound, successorRecord } from '../dist/interim-renewal.js';
const exec = promisify(execFile);
const wasm = new NodeWasmBindings();
const cli = new URL('../dist/cli.js', import.meta.url).pathname;

test('local node: interim exact successor, parent clamp and peer collection', { skip: !process.env.TC_COURIER_INTERIM_NODE_BIN, timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, 'interim-local-'));
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const host = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(root, 'node.log'), 'w', 0o600);
  const server = spawn(process.env.TC_COURIER_INTERIM_NODE_BIN, ['serve'], { cwd: root, env: {
    ...process.env, HOME: root, TC_HOME: root, COURIER_HOME: root,
    TINYCLOUD_STORAGE__DATADIR: path.join(root, 'db'), TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: '127.0.0.1',
    ROCKET_PORT: String(port), ROCKET_ADDRESS: '127.0.0.1', TINYCLOUD_KEYS__TYPE: 'Static', TINYCLOUD_KEYS__SECRET: randomBytes(48).toString('base64url'),
  }, stdio: ['ignore', log, log] });
  t.after(async () => { server.kill('SIGTERM'); await new Promise((r) => server.exitCode !== null ? r() : server.once('exit', r)); fs.closeSync(log); });
  let healthy = false;
  for (let i = 0; i < 200; i++) {
    try { healthy = (await fetch(`${host}/healthz`)).ok; } catch {}
    if (healthy) break;
    if (server.exitCode !== null) throw new Error(`node exited; see ${root}/node.log`);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(healthy);
  const info = await (await fetch(`${host}/info`)).json();
  assert.ok(info.features.includes('delegation-issued-query-v1'));
  installCourierRegistryFixture(host);
  const run = async (home, args) => (await exec(process.execPath, [cli, ...args], { env: courierRegistryFixtureEnv(home, host), timeout: 30000 })).stdout;
  const json = async (home, args) => JSON.parse(await run(home, args));
  const file = (name, body) => { const p = path.join(root, name); fs.writeFileSync(p, JSON.stringify(body), { mode: 0o600 }); return p; };
  async function identity(name) {
    const home = path.join(root, name);
    const privateKey = randomBytes(32).toString('hex');
    const owner = new TinyCloudNode({ ...nodeOpts(host), privateKey, autoCreateSpace: true, manifest: {
      app_id: 'xyz.tinycloud.courier', name: 'Local revoke fixture', space: 'agents', prefix: 'xyz.tinycloud.courier', defaults: false, includePublicSpace: false, expiry: '2h',
      permissions: [{ service: 'tinycloud.kv', path: '/', actions: ['get', 'put', 'list', 'del', 'metadata'] }, { service: 'tinycloud.hooks', path: 'kv/xyz.tinycloud.courier/', actions: ['subscribe'], skipPrefix: true }],
    } });
    await owner.signIn();
    const manager = wasm.createSessionManager(); const id = manager.createSessionKey('courier');
    const key = { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
    const request = { permissions: AGENT_GRANT, publicJwk: key.jwk, did: key.did };
    const signer = new PrivateKeySigner(privateKey);
    const address = await signer.getAddress();
    const abilities = {};
    for (const p of request.permissions) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.local.test', issuedAt: new Date().toISOString(), expirationTime: expiresAt, spaceId: owner.spaceId, jwk: request.publicJwk });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    assert.ok((await activateSessionWithHost(host, session.delegationHeader)).success);
    const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId: owner.spaceId, ownerDid: `did:pkh:eip155:1:${address}`, address, chainId: 1, siwe: prepared.siwe, signature, verificationMethod: key.did, expiresAt, receivedAt: new Date().toISOString() };
    const profile = { version: 3, host, openkeyHost: host, label: name, selfHandle: name, courierDid: key.did.split('#')[0], ownerDid: grant.ownerDid, spaceId: owner.spaceId, grantExpiresAt: grant.expiresAt, status: 'ready', peers: {} };
    fs.mkdirSync(home, { mode: 0o700 });
    for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) fs.writeFileSync(path.join(home, file), JSON.stringify(body), { mode: 0o600 });
    return { home, owner, key, grant, profile, privateKey };
  }
  const alice = await identity('alice'); const bob = await identity('bob');
  process.env.COURIER_HOME = alice.home;
  let na = await courierNode(loadProfile());
  process.env.COURIER_HOME = bob.home;
  const nb = await courierNode(loadProfile());
  async function pair(name) {
    const aHandle = `bob-${name}`; const bHandle = `alice-${name}`; const sessionId = `session-${name}`;
    const one = (await na.delegateTo(bob.profile.courierDid, peerReadPermissions(aHandle, alice.profile.spaceId, sessionId), { expiry: '5m', requireActivation: true })).delegation;
    const two = (await nb.delegateTo(alice.profile.courierDid, peerReadPermissions(bHandle, bob.profile.spaceId, sessionId), { expiry: '5m', requireActivation: true })).delegation;
    const peer = (handle, other, theirHandleForMe, inbound, outbound) => ({ handle, ownerDid: other.ownerDid, courierDid: other.courierDid, spaceId: other.spaceId,
      theirHandleForMe, sessionId, status: 'paired', pairedAt: new Date().toISOString(),
      inbound: { cid: inbound.cid, delegation: serializeDelegation(inbound), expiresAt: inbound.expiry.toISOString() },
      outbound: [{ cid: outbound.cid, issuedAt: new Date().toISOString(), expiresAt: outbound.expiry.toISOString(), delegation: serializeDelegation(outbound) }] });
    process.env.COURIER_HOME = alice.home;
    const pa = loadProfile(); pa.peers[aHandle] = peer(aHandle, bob.profile, bHandle, two, one); saveProfile(pa);
    process.env.COURIER_HOME = bob.home;
    const pb = loadProfile(); pb.peers[bHandle] = peer(bHandle, alice.profile, aHandle, one, two); saveProfile(pb);
    assert.ok((await na.kv.put(k.peerDelegation(aHandle, sessionId), { v: 0, delegation: serializeDelegation(one) }, { prefix: '', ifNoneMatch: '*' })).ok);
    assert.ok((await nb.kv.put(k.peerDelegation(bHandle, sessionId), { v: 0, delegation: serializeDelegation(two) }, { prefix: '', ifNoneMatch: '*' })).ok);
    return { aHandle, bHandle, sessionId, one, two };
  }
  async function renew(p) {
    process.env.COURIER_HOME = alice.home;
    return withProfileTransaction((profile, save) => maintainOutbound(na, profile, profile.peers[p.aHandle], save, { force: true, manual: true }));
  }
  async function listing() { const value = await na.delegationManager.queryAllIssued({ space: alice.profile.spaceId }); assert.ok(value.ok); return value.data; }
  const happy = await pair('happy');
  const result = await renew(happy);
  assert.equal(result.state, 'renewed');
  assert.ok(result.delegation.expiry.getTime() > happy.one.expiry.getTime());
  assert.ok(result.delegation.expiry.getTime() <= Date.parse(alice.grant.expiresAt));
  assert.ok(result.delegation.expiry.getTime() < Date.now() + 2 * 3600_000, 'Month request is clamped to the actual one-hour parent');
  assert.deepEqual(successorRecord(na, result.delegation).parents, [alice.grant.delegationCid]);
  process.env.COURIER_HOME = bob.home;
  const received = loadProfile();
  await peerKv(nb, received, received.peers[happy.bHandle]);
  assert.equal(loadProfile().peers[happy.bHandle].inbound.cid, result.delegation.cid);
  t.diagnostic('proofless issued listing; strictly later exact signed successor; actual parent clamp; conditional publication; independent peer collection');
  for (const variant of ['action', 'audience', 'caveat', 'parent-end']) {
    const p = await pair(variant); const delegate = na.delegateTo.bind(na); let candidate;
    na.delegateTo = async (audience, entries, options) => {
      const modified = structuredClone(entries);
      if (variant === 'action') modified.find(entry => entry.service === 'tinycloud.kv').actions.push('tinycloud.kv/put');
      if (variant === 'caveat') {
        const priorPayload = JSON.parse(Buffer.from(p.one.delegationHeader.Authorization.split('.')[1], 'base64url').toString());
        const att = structuredClone(priorPayload.att);
        for (const [resource, actions] of Object.entries(att)) if (resource.startsWith(`${alice.profile.spaceId}/kv/`)) {
          for (const action of Object.keys(actions)) actions[action] = [{ limit: 1 }];
        }
        const expiresAt = Math.floor(Date.parse(alice.grant.expiresAt) / 1000);
        const payload = { ...priorPayload, att, prf: [alice.grant.delegationCid], exp: expiresAt,
          nbf: Math.floor(Date.now() / 1000), nnc: `urn:uuid:${crypto.randomUUID()}` };
        const input = `${p.one.delegationHeader.Authorization.split('.')[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
        const authorization = `${input}.${sign(null, Buffer.from(input), createPrivateKey({ key: alice.key.jwk, format: 'jwk' })).toString('base64url')}`;
        candidate = { ...p.one, cid: na.computeDelegationCid(authorization), delegationHeader: { Authorization: authorization }, expiry: new Date(expiresAt * 1000),
          caveats: [{ limit: 1 }], resources: p.one.resources.map(resource => resource.service === 'kv' ? { ...resource, caveats: [{ limit: 1 }] } : resource) };
        const activated = await activateSessionWithHost(host, candidate.delegationHeader);
        assert.ok(activated.success, 'the real node admits the signed narrower caveat; Courier must refuse the scope change');
        return { delegation: candidate };
      }
      const result = await delegate(variant === 'audience' ? alice.profile.courierDid : audience, modified, options);
      candidate = result.delegation;
      if (variant === 'parent-end') {
        const payload = JSON.parse(Buffer.from(candidate.delegationHeader.Authorization.split('.')[1], 'base64url').toString());
        payload.exp = Math.floor(Date.parse(alice.grant.expiresAt) / 1000) + 60;
        const input = `${candidate.delegationHeader.Authorization.split('.')[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
        const authorization = `${input}.${sign(null, Buffer.from(input), createPrivateKey({ key: alice.key.jwk, format: 'jwk' })).toString('base64url')}`;
        assert.equal((await activateSessionWithHost(host, { Authorization: authorization })).success, false, 'the node refuses a signed child extending past its parent');
        result.delegation = { ...candidate, expiry: new Date(Date.parse(alice.grant.expiresAt) + 1000) };
      }
      return result;
    };
    try { await assert.rejects(renew(p), error => { assert.ok(candidate, `${variant} stopped before signing: ${error.code ?? error.name}`); return true; }); } finally { na.delegateTo = delegate; }
    assert.ok(candidate);
    assert.equal((await listing()).find(item => item.cid === candidate.cid).status, 'revoked', variant);
    const published = await na.kv.get(k.peerDelegation(p.aHandle, p.sessionId), { prefix: '' }); assert.ok(published.ok);
    const value = typeof published.data.data === 'string' ? JSON.parse(published.data.data) : published.data.data;
    assert.equal(JSON.parse(value.delegation).cid, p.one.cid);
  }
  t.diagnostic('real activated extra-action/other-audience grants and signed changed caveat and altered parent-end projection are refused and cleaned, never published');

  const external = await pair('external'); const published = await renew(external);
  assert.equal(published.state, 'renewed');
  // Outside Courier's cleanup journal: the direct authorized signer may be identical, but no intent exists.
  assert.ok((await na.delegationManager.revokeIssued(external.one.cid)).ok);
  assert.equal((await renew(external)).state, 'revoked');
  assert.equal((await listing()).find(item => item.cid === published.delegation.cid).status, 'revoked');
  process.env.COURIER_HOME = alice.home;
  assert.ok(loadProfile().peers[external.aHandle].interim.latchedAt);
  t.diagnostic('external single-sibling revocation latches the pairing and revokes the live published sibling');

  const orphan = await pair('orphan');
  const otherHome = path.join(root, 'alice-other-home'); fs.mkdirSync(otherHome, { mode: 0o700 });
  for (const filename of ['profile.json', 'key.json', 'grant.json']) fs.copyFileSync(path.join(alice.home, filename), path.join(otherHome, filename));
  process.env.COURIER_HOME = otherHome; const otherNode = await courierNode(loadProfile());
  const orphanGrant = (await otherNode.delegateTo(bob.profile.courierDid, peerReadPermissions(orphan.aHandle, alice.profile.spaceId, orphan.sessionId), { expiry: '10m', requireActivation: true })).delegation;
  assert.equal((await renew(orphan)).state, 'unavailable');
  assert.equal((await listing()).find(item => item.cid === orphanGrant.cid).status, 'revoked');
  process.env.COURIER_HOME = alice.home;
  assert.ok(!loadProfile().peers[orphan.aHandle].outbound.some(entry => entry.cid === orphanGrant.cid));
  t.diagnostic('a second HOME using the same key creates an orphan: original HOME revokes it and never adopts it');

  const cas = await pair('cas'); const delegate = na.delegateTo.bind(na); let loser;
  na.delegateTo = async (...args) => {
    const result = await delegate(...args); loser = result.delegation;
    // Another authenticated writer changes the row revision while preserving the prior tip.
    assert.ok((await otherNode.kv.put(k.peerDelegation(cas.aHandle, cas.sessionId), { v: 0, delegation: serializeDelegation(cas.one), writer: 'other-home' }, { prefix: '' })).ok);
    return result;
  };
  try { await assert.rejects(renew(cas), /changed|conflict/); } finally { na.delegateTo = delegate; }
  assert.equal((await listing()).find(item => item.cid === loser.cid).status, 'revoked');
  t.diagnostic('real node publication CAS loss revokes its signed losing candidate');

  const inbound = await pair('inbound-source');
  process.env.COURIER_HOME = alice.home;
  const withInbound = loadProfile(); withInbound.peers[inbound.aHandle].outbound[0].cid = inbound.two.cid; saveProfile(withInbound);
  assert.equal((await renew(inbound)).state, 'unavailable');
  const foreignList = await nb.delegationManager.queryAllIssued({ space: bob.profile.spaceId }); assert.ok(foreignList.ok);
  assert.equal(foreignList.data.find(item => item.cid === inbound.two.cid).status, 'active');
  t.diagnostic('an inbound CID issued by another key cannot authorize a successor and is not revoked by us');

  // A real later owner grant replaces the installed CID; an old episode cannot install its earlier approval.
  process.env.COURIER_HOME = alice.home;
  const previousGrant = alice.grant;
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const abilities = {};
  for (const permission of AGENT_GRANT) (abilities[permission.service.replace('tinycloud.', '')] ??= {})[permission.path] = permission.actions;
  const prepared = wasm.prepareSession({ abilities, address: alice.grant.address, chainId: 1, domain: 'courier.local.test',
    issuedAt: new Date().toISOString(), expirationTime: expiresAt, spaceId: alice.profile.spaceId, jwk: alice.key.jwk });
  const signature = await new PrivateKeySigner(alice.privateKey).signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  assert.ok((await activateSessionWithHost(host, session.delegationHeader)).success);
  const nextGrant = { ...alice.grant, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid,
    expiresAt, siwe: prepared.siwe, signature };
  const { writeSecure } = await import('../dist/profile.js');
  const { requestHash } = await import('../dist/canonical.js');
  const { assertEpisodeGrant, preflightOwner: checkOwner, loadOwnerEpisode } = await import('../dist/interim-owner.js');
  const pending = { requestId: 'old-episode-request', request: { requestVersion: 1, targetDid: alice.profile.courierDid } };
  writeSecure(path.join(alice.home, 'renewal-owner.json'), { ownerGrantCid: previousGrant.delegationCid, expiresAt: previousGrant.expiresAt,
    courierDid: alice.profile.courierDid, intentHash: 'old-approved-intent', requestId: pending.requestId, requestHash: requestHash(pending.request), phase: 'requested' });
  writeSecure(path.join(alice.home, 'grant.json'), nextGrant);
  const grantBytes = fs.readFileSync(path.join(alice.home, 'grant.json'), 'utf8');
  assert.throws(() => assertEpisodeGrant(pending, { siwe: previousGrant.siwe }), /doesn't extend/);
  assert.equal(fs.readFileSync(path.join(alice.home, 'grant.json'), 'utf8'), grantBytes);
  assert.equal((await checkOwner({ request: false })).state, 'live');
  assert.equal(loadOwnerEpisode().phase, 'complete');
  alice.grant = nextGrant;
  na = await courierNode(loadProfile());
  t.diagnostic('stale approval episode cannot replace a real later installed owner grant; old episode closes');

  const ancestor = await pair('ancestor');
  const ownerRevoke = await alice.owner.revokeDelegation(alice.grant.delegationCid);
  assert.ok(ownerRevoke.ok, JSON.stringify(ownerRevoke));
  process.env.COURIER_HOME = alice.home;
  const { watchPreflight } = await import('../dist/interim-runtime.js');
  const fetchBeforeCheck = globalThis.fetch; let approvalRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const mockedRegistry = url.origin === new URL(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).origin && /^\/v[12]\/locations\/[^/]+$/.test(url.pathname);
    if (url.origin !== host && !mockedRegistry) { approvalRequests++; throw new Error('external approval must not be requested'); }
    return fetchBeforeCheck(input, init);
  };
  try { await assert.rejects(watchPreflight(na), { code: 'owner-revoked' }); }
  finally { globalThis.fetch = fetchBeforeCheck; }
  assert.equal(approvalRequests, 0, 'ancestor status is discovered before a near-expiry owner request');
  assert.equal((await renew(ancestor)).state, 'owner-revoked');
  process.env.COURIER_HOME = alice.home;
  const { preflightOwner } = await import('../dist/interim-owner.js');
  const realFetch = globalThis.fetch; let attempted = 0;
  globalThis.fetch = async () => { attempted++; throw new Error('terminal state must stay local'); };
  try { assert.equal((await preflightOwner()).state, 'revoked'); } finally { globalThis.fetch = realFetch; }
  assert.equal(attempted, 0);
  t.diagnostic('actual owner ancestor revocation prevents automatic approval and all restart network calls');

});
