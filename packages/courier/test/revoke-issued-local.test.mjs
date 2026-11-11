// Opt in with TC_COURIER_REVOKE_NODE_BIN, a known local node build. No external endpoint is accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { TinyCloudNode, NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { activateSessionWithHost } from '@tinycloud/sdk-core';
import { courierRegistryFixtureEnv, installCourierRegistryFixture } from './support/registry-fixture.mjs';
import { courierNode, peerKv, nodeOpts } from '../dist/node.js';
import { cmdRevoke } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile } from '../dist/profile.js';
import { AGENT_GRANT, k, peerReadPermissions } from '../dist/keys.js';

const exec = promisify(execFile);
const wasm = new NodeWasmBindings();
const cli = new URL('../dist/cli.js', import.meta.url).pathname;

test('local node: healthy peer read, cmdRevoke all children/current replacement, next read denied', { skip: !process.env.TC_COURIER_REVOKE_NODE_BIN, timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, 'revoke-local-'));
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const host = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(root, 'node.log'), 'w', 0o600);
  const server = spawn(process.env.TC_COURIER_REVOKE_NODE_BIN, ['serve'], { cwd: root, env: {
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
    return home;
  }
  const a = await identity('alice'); const b = await identity('bob');
  const A = await json(a, ['pair', 'start', 'bob']);
  const B = await json(b, ['pair', 'accept', '--file', file('a.json', A)]);
  const C = await json(a, ['pair', 'accept', '--file', file('b.json', B)]);
  await json(b, ['pair', 'accept', '--file', file('c.json', C)]);
  process.env.COURIER_HOME = a;
  const pa = loadProfile(); const na = await courierNode(pa);
  const replacement = await na.delegateTo(pa.peers.bob.courierDid, peerReadPermissions('bob', pa.spaceId), { expiry: '30m' });
  assert.notEqual(replacement.delegation.cid, pa.peers.bob.outbound[0].cid);
  const other = await na.delegateTo(pa.peers.bob.courierDid, peerReadPermissions('other-mailbox', pa.spaceId), { expiry: '30m' });
  const write = await na.kv.put(`${k.toPeer('bob')}proof.txt`, 'healthy'); assert.ok(write.ok);
  process.env.COURIER_HOME = b;
  const pb = loadProfile(); const nb = await courierNode(pb); const kv = await peerKv(nb, pb, pb.peers.alice);
  const before = await kv.get(`${k.toPeer('bob')}proof.txt`); assert.ok(before.ok, JSON.stringify(before));
  t.diagnostic('healthy peer read BEFORE cmdRevoke: ok');
  process.env.COURIER_HOME = a;
  const realFetch = globalThis.fetch;
  let revokes = 0;
  globalThis.fetch = async (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/revoke' && ++revokes === 2) return new Response('injected local outage', { status: 503 });
    return realFetch(input, init);
  };
  try { await assert.rejects(cmdRevoke(parseArgs(['bob'])), /pairing retained for retry/); }
  finally { globalThis.fetch = realFetch; }
  const progress = loadProfile().peers.bob;
  assert.ok(progress);
  assert.equal(progress.outbound.filter((e) => e.revokedAt).length, 1);
  t.diagnostic('partial revoke failure retained pairing and one durable receipt; retry follows');
  const result = await run(a, ['revoke', 'bob']); assert.match(result, /Revoked bob/);
  const after = await kv.get(`${k.toPeer('bob')}proof.txt`); assert.equal(after.ok, false);
  t.diagnostic(`NEXT peer read AFTER cmdRevoke: denied (${after.error?.code})`);
  const listed = await na.delegationManager.queryAllIssued({ space: pa.spaceId }); assert.ok(listed.ok);
  for (const cid of [replacement.delegation.cid, pa.peers.bob.outbound[0].cid]) assert.equal(listed.data.find((r) => r.cid === cid)?.status, 'revoked');
  assert.equal(listed.data.find((r) => r.cid === other.delegation.cid)?.status, 'active');
  const again = await na.delegationManager.revokeIssued(replacement.delegation.cid); assert.ok(again.ok);
  t.diagnostic('already-revoked issued CID succeeds idempotently; other mailbox remains active');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'profile.json'))).peers.bob, undefined);
});
