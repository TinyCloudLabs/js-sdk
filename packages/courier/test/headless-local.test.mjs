// Run against an isolated loopback node, e.g. TC_COURIER_HEADLESS_NODE_BIN=/path/to/tinycloud.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { TinyCloudNode, NodeWasmBindings, PrivateKeySigner, activateValidatedRuntimeDelegation, deserializeDelegation } from '@tinycloud/node-sdk';
import { activateSessionWithHost } from '@tinycloud/sdk-core';
import { ulid } from 'ulid';
import {
  acceptPairing, acknowledgeInbound, finalizePairing, listInbound, peerReference, sendMessage, unpair,
  AGENT_GRANT, buildMessage, EXT, k, nodeOpts, peerReadPermissions,
} from '@tinycloud/courier';
import { courierRegistryFixtureEnv, installCourierRegistryFixture } from './support/registry-fixture.mjs';

const exec = promisify(execFile);
const bin = process.env.TC_COURIER_HEADLESS_NODE_BIN;
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const full = { prefix: '' };

/** Fresh reads and durable checkpoints, including after a rejected operation. */
function scopedStore() {
  const queues = new Map();
  const records = new Map();
  return {
    transaction(scope, operation) {
      const key = JSON.stringify([scope.ownerDid, scope.courierDid, scope.spaceId, scope.host]);
      const current = queues.get(key) ?? Promise.resolve();
      const ledger = records.get(key) ?? new Map();
      records.set(key, ledger);
      const pending = current.then(() => operation({
        get: async handle => structuredClone(ledger.get(handle)),
        save: async (handle, value) => value === undefined ? ledger.delete(handle) : void ledger.set(handle, structuredClone(value)),
      }));
      queues.set(key, pending.catch(() => {}));
      return pending;
    },
  };
}

function replyFor(peer, threadId, inReplyTo) {
  return { inReplyTo, idempotencyKey: createHash('sha256').update(JSON.stringify([peer.peerDid, threadId, inReplyTo])).digest('hex') };
}

test('public Courier API: Bun/Node loopback pairs, replies once and isolates two owners through unpair recovery', { skip: !bin, timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.COURIER_TEST_HOME, 'headless-'));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const host = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(root, 'node.log'), 'w', 0o600);
  const node = spawn(bin, ['serve'], { cwd: root, env: {
    ...process.env, HOME: root, TC_HOME: root, COURIER_HOME: root,
    TINYCLOUD_STORAGE__DATADIR: path.join(root, 'db'), TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: '127.0.0.1',
    ROCKET_PORT: String(port), ROCKET_ADDRESS: '127.0.0.1', TINYCLOUD_KEYS__TYPE: 'Static', TINYCLOUD_KEYS__SECRET: randomBytes(48).toString('base64url'),
  }, stdio: ['ignore', log, log] });
  t.after(async () => {
    if (node.exitCode === null && node.signalCode === null) {
      const exited = new Promise(resolve => node.once('exit', resolve));
      node.kill('SIGTERM');
      await exited;
    }
    fs.closeSync(log);
  });
  let healthy = false;
  for (let i = 0; i < 200; i++) {
    try { healthy = (await fetch(`${host}/healthz`)).ok; } catch { /* node starting */ }
    if (healthy || node.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(healthy, 'fixture Node did not become healthy');
  assert.ok((await (await fetch(`${host}/info`)).json()).features.includes('delegation-issued-query-v1'));
  const previousFetch = globalThis.fetch;
  installCourierRegistryFixture(host);
  t.after(() => { globalThis.fetch = previousFetch; });
  const oldCourierHome = process.env.COURIER_HOME;
  // Any accidental call to Courier's CLI profile layer fails its own home fence.
  process.env.COURIER_HOME = '/proc/courier-headless-must-not-read';
  t.after(() => { process.env.COURIER_HOME = oldCourierHome; });

  const store = scopedStore();
  const wasm = new NodeWasmBindings();
  async function identity(name, cliProfile = false) {
    const privateKey = randomBytes(32).toString('hex');
    const owner = new TinyCloudNode({ ...nodeOpts(host), privateKey, autoCreateSpace: true, manifest: {
      app_id: 'xyz.tinycloud.courier', name: 'Local headless fixture', space: 'agents', prefix: 'xyz.tinycloud.courier', defaults: false, includePublicSpace: false, expiry: '2h',
      permissions: [{ service: 'tinycloud.kv', path: '/', actions: ['get', 'put', 'list', 'del', 'metadata'] }, { service: 'tinycloud.hooks', path: 'kv/xyz.tinycloud.courier/', actions: ['subscribe'], skipPrefix: true }],
    } });
    await owner.signIn();
    const spaceId = owner.spaceId;
    const manager = wasm.createSessionManager();
    const keyId = manager.createSessionKey(name);
    const key = { v: 1, jwk: JSON.parse(manager.jwk(keyId)), did: manager.getDID(keyId), createdAt: new Date().toISOString() };
    const signer = new PrivateKeySigner(privateKey);
    const address = await signer.getAddress();
    const abilities = {};
    for (const p of AGENT_GRANT) (abilities[p.service.replace('tinycloud.', '')] ??= {})[p.path] = p.actions;
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.local.test', issuedAt: new Date().toISOString(), expirationTime: expiresAt, spaceId, jwk: key.jwk });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    assert.ok((await activateSessionWithHost(host, session.delegationHeader)).success);
    const ownerDid = `did:pkh:eip155:1:${address}`;
    const courierDid = key.did.split('#')[0];
    const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, ownerDid, address, chainId: 1, siwe: prepared.siwe, signature, verificationMethod: key.did, expiresAt, receivedAt: new Date().toISOString() };
    const createReader = async () => {
      const holder = new TinyCloudNode({ ...nodeOpts(host), fetch: (url, init) => globalThis.fetch(url, init) });
      await holder.restoreSession({ ...grant, jwk: key.jwk, tinycloudHosts: [host] });
      return holder;
    };
    const home = path.join(root, name);
    if (cliProfile) {
      const profile = { version: 3, host, openkeyHost: host, label: name, selfHandle: name, courierDid, ownerDid, spaceId, grantExpiresAt: expiresAt, status: 'ready', peers: {} };
      fs.mkdirSync(home, { mode: 0o700 });
      for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) fs.writeFileSync(path.join(home, file), JSON.stringify(body), { mode: 0o600 });
    }
    return { host, ownerDid, courierDid, node: await createReader(), createReader, store, label: name, home, spaceId };
  }
  const [one, two, initiator] = await Promise.all([identity('first'), identity('second'), identity('remote', true)]);
  const invoke = async (...args) => JSON.parse((await exec(process.env.NODE_BINARY ?? 'node', [cli, ...args], {
    env: courierRegistryFixtureEnv(initiator.home, host), timeout: 30000,
  })).stdout);
  const A = await invoke('pair', 'start', 'owner-one', '--call-me', 'remote');
  const A2 = await invoke('pair', 'start', 'owner-two', '--call-me', 'remote');
  const { challengeVersion, ...legacyA } = A;
  await assert.rejects(acceptPairing(one, JSON.stringify(legacyA)), { code: 'courier-update-required' });
  await assert.rejects(acceptPairing(one, JSON.stringify({ ...A, callMe: '../other' })), { code: 'bad-artifact' });
  const delegateTo = two.node.delegateTo;
  let issuedCid;
  two.node.delegateTo = async (...args) => {
    issuedCid = (await delegateTo.apply(two.node, args)).delegation.cid;
    throw new Error('fixture lost activation acknowledgment');
  };
  let pending;
  try {
    [pending] = await Promise.all([
      acceptPairing(one, JSON.stringify(A)),
      assert.rejects(acceptPairing(two, JSON.stringify(A2)), /lost activation acknowledgment/),
    ]);
  } finally {
    two.node.delegateTo = delegateTo;
  }
  const pending2 = await acceptPairing(two, JSON.stringify(A2));
  assert.equal(deserializeDelegation(JSON.parse(pending2.artifactB).delegation).cid, issuedCid);
  assert.deepEqual(await acceptPairing(one, JSON.stringify(A)), pending);
  assert.equal(pending.handle, pending2.handle);
  assert.notEqual(pending.pairingId, pending2.pairingId);
  assert.ok(pending.expiresAt <= Date.now() + 15 * 60_000);
  await assert.rejects(listInbound(one, pending), { code: 'not-paired' });

  const C = await invoke('pair', 'accept', pending.artifactB);
  const C2 = await invoke('pair', 'accept', pending2.artifactB);
  const { completion, ...unsignedC } = C;
  await assert.rejects(finalizePairing(one, pending, JSON.stringify(unsignedC)), { code: 'bad-artifact' });
  await assert.rejects(finalizePairing(two, pending2, JSON.stringify(C)), { code: 'bad-artifact' });
  await assert.rejects(finalizePairing(one, pending, JSON.stringify({ ...C, completion: { ...completion, x: C2.completion.x.replace(/^./, C2.completion.x[0] === 'A' ? 'B' : 'A') } })), { code: 'bad-artifact' });
  const [paired, paired2] = await Promise.all([
    finalizePairing(one, pending, JSON.stringify(C)),
    finalizePairing(two, pending2, JSON.stringify(C2)),
    assert.rejects(finalizePairing(one, pending, JSON.stringify(C)), { code: 'not-pending' }),
  ]);
  await assert.rejects(listInbound(one, paired2), { code: 'peer-changed' });
  await assert.rejects(listInbound({ ...one, node: two.node }, paired), { code: 'bad-grant' });
  await assert.rejects(listInbound({ ...one, host: 'http://127.0.0.1:9' }, paired), { code: 'host-mismatch' });
  await assert.rejects(listInbound({ ...one, createReader: two.createReader }, paired), { code: 'bad-grant' });

  const ask = await invoke('send', 'owner-one', '--new', 'A question', '--intent', 'ask', '--text', 'Scope one?');
  const info = await invoke('send', 'owner-one', '--thread', ask.threadId, '--intent', 'inform', '--text', 'No reply please');
  const request = await invoke('send', 'owner-two', '--new', 'A request', '--intent', 'request', '--text', 'Perform an action');
  const fake = buildMessage({ threadId: ask.threadId, from: { owner: initiator.ownerDid, agent: two.courierDid }, role: 'ROLE_USER', intent: 'ask', text: 'Wrong declared sender' });
  assert.ok((await initiator.node.kv.put(k.msg('owner-one', ask.threadId, fake.messageId), fake, { ...full, ifNoneMatch: '*' })).ok);
  const [incoming, incoming2] = await Promise.all([listInbound(one, paired), listInbound(two, paired2)]);
  assert.deepEqual(incoming.map(item => item.messageId), [ask.messageId, info.messageId]);
  assert.equal(incoming[0].text, 'Scope one?');
  assert.deepEqual(incoming2.map(item => item.intent), ['request']);
  await assert.rejects(sendMessage(one, paired, request.threadId, 'wrong thread', replyFor(paired, request.threadId, ask.messageId)), { code: 'bad-reply' });
  await assert.rejects(sendMessage(two, paired2, ask.threadId, 'wrong peer scope', replyFor(paired2, ask.threadId, ask.messageId)), { code: 'bad-reply' });
  await assert.rejects(sendMessage(one, paired, ask.threadId, 'forged sender', replyFor(paired, ask.threadId, fake.messageId)), { code: 'bad-reply' });
  await assert.rejects(sendMessage(one, paired, ask.threadId, 'must stay silent', replyFor(paired, ask.threadId, info.messageId)), { code: 'bad-reply' });
  await acknowledgeInbound(one, paired, incoming);
  assert.deepEqual(await listInbound(one, paired), []);

  const own = one.node.kv;
  const put = own.put;
  own.put = async (key, value, options) => {
    const result = await put.call(own, key, value, options);
    if (key.startsWith(k.msgPrefix('remote', ask.threadId)) && result.ok) throw new Error('fixture lost reply acknowledgment');
    return result;
  };
  const evidence = replyFor(paired, ask.threadId, ask.messageId);
  try {
    await assert.rejects(sendMessage(one, paired, ask.threadId, 'Owner one reply', evidence), /lost reply acknowledgment/);
  } finally {
    own.put = put;
  }
  const resumed = await sendMessage(one, paired, ask.threadId, 'Owner one reply', evidence);
  await assert.rejects(sendMessage(one, paired, ask.threadId, 'changed body', evidence), { code: 'conflict' });
  const refused = await sendMessage(two, paired2, request.threadId, 'I cannot perform actions.', replyFor(paired2, request.threadId, request.messageId));
  const inbox = await invoke('inbox', '--json');
  assert.deepEqual(inbox.items.filter(item => item.threadId === ask.threadId).map(item => [item.peer, item.messageId, item.text]), [['owner-one', resumed.messageId, 'Owner one reply']]);
  assert.deepEqual(inbox.items.filter(item => item.threadId === request.threadId).map(item => [item.peer, item.messageId, item.text]), [['owner-two', refused.messageId, 'I cannot perform actions.']]);
  const replyWire = await own.get(k.msg('remote', ask.threadId, resumed.messageId), full);
  assert.ok(replyWire.ok);
  // Courier's contract (store.ts getJson): a JSON value may come back from the Node as JSON text.
  const replyBody = typeof replyWire.data.data === 'string' ? JSON.parse(replyWire.data.data) : replyWire.data.data;
  assert.equal(replyBody.metadata[EXT].inReplyTo, ask.messageId);

  // Inventory must include exact unrecorded siblings, but never touch other mailboxes or the other owner.
  const sibling = (await one.node.delegateTo(initiator.courierDid, peerReadPermissions('remote', one.spaceId), { expiry: '20m', requireActivation: true })).delegation;
  const other = (await one.node.delegateTo(initiator.courierDid, peerReadPermissions('unrelated', one.spaceId), { expiry: '20m', requireActivation: true })).delegation;
  assert.ok((await own.put(`${k.toPeer('unrelated')}proof`, 'keep', full)).ok);
  const manager = one.node.delegationManager;
  const revoke = manager.revokeIssued;
  let attempts = 0;
  manager.revokeIssued = async cid => ++attempts === 2 ? { ok: false, error: { code: 'NETWORK_ERROR' } } : revoke.call(manager, cid);
  try {
    await assert.rejects(unpair(one, paired), { code: 'revoke-failed' });
  } finally {
    manager.revokeIssued = revoke;
  }
  await assert.rejects(listInbound(one, paired), { code: 'not-paired' });
  await assert.rejects(sendMessage(one, paired, ask.threadId, 'No write after latch', evidence), { code: 'not-paired' });
  await unpair(one, paired);
  const grants = await manager.queryAllIssued({ space: one.spaceId });
  assert.ok(grants.ok);
  for (const cid of [sibling.cid, deserializeDelegation(JSON.parse(pending.artifactB).delegation).cid]) {
    assert.equal(grants.data.find(grant => grant.cid === cid)?.status, 'revoked');
  }
  assert.equal(grants.data.find(grant => grant.cid === other.cid)?.status, 'active');
  assert.ok((await own.get(`${k.toPeer('unrelated')}proof`, full)).ok);
  const reader = await initiator.createReader();
  const oldGrant = deserializeDelegation(JSON.parse(pending.artifactB).delegation);
  let denied = false;
  try {
    await activateValidatedRuntimeDelegation(reader, oldGrant, { host });
    denied = !(await reader.kvForSpace(one.spaceId).get(k.msg('remote', ask.threadId, resumed.messageId), full)).ok;
  } catch { denied = true; }
  assert.ok(denied, 'the intended peer loses its node-side grant');
  await assert.rejects(listInbound(one, paired), { code: 'not-paired' });
  assert.equal((await listInbound(two, paired2))[0].messageId, request.messageId);
  const replacement = await acceptPairing(one, JSON.stringify(A));
  await assert.rejects(finalizePairing(one, replacement, JSON.stringify(C)), { code: 'bad-artifact' });
  await unpair(one, replacement);

  // Preparation saved but activation never reached the node: retries refuse, and the stored record's reference unpairs it.
  const unsent = one.node.delegateTo;
  one.node.delegateTo = (did, permissions, options) => unsent.call(one.node, did, permissions, {
    ...options, onPrepared: async prepared => { await options.onPrepared(prepared); throw new Error('fixture activation never sent'); },
  });
  try {
    await assert.rejects(acceptPairing(one, JSON.stringify(A)), /activation never sent/);
  } finally {
    one.node.delegateTo = unsent;
  }
  await assert.rejects(acceptPairing(one, JSON.stringify(A)), { code: 'pair-pending' });
  const scope = { ownerDid: one.ownerDid.toLowerCase(), courierDid: one.courierDid, spaceId: one.spaceId, host: one.host };
  const stranded = await one.store.transaction(scope, tx => tx.get('remote'));
  assert.equal(stranded?.phase, 'pending');
  await unpair(one, peerReference(stranded));
  const fresh = await acceptPairing(one, JSON.stringify(A));
  assert.notEqual(fresh.pairingId, stranded.pairingId);
  await unpair(one, fresh);

  // A live grant from an earlier use of the handle, recorded nowhere, blocks reuse until it is revoked; accept never revokes it.
  const leftover = (await one.node.delegateTo(initiator.courierDid, peerReadPermissions('remote', one.spaceId), { expiry: '20m', requireActivation: true })).delegation;
  await assert.rejects(acceptPairing(one, JSON.stringify(A)), { code: 'mailbox-in-use' });
  const stillLive = await manager.queryAllIssued({ space: one.spaceId });
  assert.equal(stillLive.ok && stillLive.data.find(grant => grant.cid === leftover.cid)?.status, 'active');
  assert.ok((await manager.revokeIssued(leftover.cid)).ok);
  await unpair(one, await acceptPairing(one, JSON.stringify(A)));
});
