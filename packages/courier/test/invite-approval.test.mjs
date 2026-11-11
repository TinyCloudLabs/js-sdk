import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { parseArgs } from '../dist/args.js';
import { assertInvitationApprovalGrant, ownerEncryptionNetwork, siweTimes } from '../dist/authority.js';
import { AGENT_GRANT, COURIER_SPACE, PREFIX } from '../dist/keys.js';
import { sessionKey } from '../dist/guided.js';
import { cmdInvite } from '../dist/invitation.js';
import { loadInviteGrant, loadPendingInvite } from '../dist/invite-approval.js';
import { loadGrant, profileDir, saveKey, saveProfile } from '../dist/profile.js';
import { sendEmailInvitation } from '../dist/email-invitation.js';
import { memoryKv } from './memory-kv.mjs';

const HOST = 'https://node.example';
const DAY = 86_400_000;
const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const keyId = manager.createSessionKey('agent');
const agent = { v: 1, did: manager.getDID(keyId).split('#')[0], jwk: JSON.parse(manager.jwk(keyId)), createdAt: new Date().toISOString() };
const otherKeyId = manager.createSessionKey('other');
const other = { v: 1, did: manager.getDID(otherKeyId).split('#')[0], jwk: JSON.parse(manager.jwk(otherKeyId)), createdAt: new Date().toISOString() };
const owner = new PrivateKeySigner(randomBytes(32).toString('hex'));
const address = await owner.getAddress();
const OWNER = `did:pkh:eip155:1:${address}`;
const SPACE = wasm.makeSpaceId(address, 1, COURIER_SPACE);
const ID_A = 'a1'.repeat(16);
const ID_B = 'b2'.repeat(16);
const network = ownerEncryptionNetwork(OWNER);
const pair = ['tinycloud.encryption/key.create', 'tinycloud.encryption/decrypt'];

/** What the approver's service signs: one key pair (plus whatever `extra` adds), for `holder`, for `lifetimeMs`. */
async function approval({ id = ID_A, holder = agent, lifetimeMs = 3_600_000, issuedAt = new Date(), abilities } = {}) {
  const prepared = wasm.prepareSession({
    abilities: abilities ?? { encryption: { [`${network}/share/${id}`]: pair } },
    address, chainId: 1, domain: 'openkey.offline-test', issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + lifetimeMs).toISOString(), spaceId: SPACE, jwk: holder.jwk,
  });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId: SPACE, address, chainId: 1,
    siwe: prepared.siwe, signature, verificationMethod: holder.did };
}

const caps = async (options) => {
  const { TinyCloudNode } = await import('@tinycloud/node-sdk');
  const { nodeOpts } = await import('../dist/node.js');
  const payload = await approval(options);
  const node = new TinyCloudNode(nodeOpts(HOST));
  const times = siweTimes(payload.siwe);
  await node.restoreSession({ ...payload, jwk: (options?.holder ?? agent).jwk, expiresAt: times.expiresAt.toISOString(), tinycloudHosts: [HOST] });
  return { caps: node.getVerifiedSessionCapabilities(), times };
};

test('assertInvitationApprovalGrant: reads the key id from the signed grant when it is exactly one pair', async () => {
  const { caps: verified, times } = await caps();
  assert.equal(assertInvitationApprovalGrant(verified, times, { ownerDid: OWNER, acceptanceExpiresAt: new Date(Date.now() + DAY) }), ID_A);
});

for (const [name, options, code] of [
  ['more authority than the key pair', { abilities: { encryption: { [`${network}/share/${ID_A}`]: pair }, kv: { [`${PREFIX}/me/`]: ['tinycloud.kv/get'] } } }, 'bad-grant'],
  ['half a pair', { abilities: { encryption: { [`${network}/share/${ID_A}`]: [pair[1]] } } }, 'bad-grant'],
  ['two keys', { abilities: { encryption: { [`${network}/share/${ID_A}`]: pair, [`${network}/share/${ID_B}`]: pair } } }, 'bad-grant'],
  ['the share prefix', { abilities: { encryption: { [`${network}/share/`]: pair } } }, 'bad-grant'],
  ['an upper-case id', { abilities: { encryption: { [`${network}/share/${ID_A.toUpperCase()}`]: pair } } }, 'bad-grant'],
  ['another network', { abilities: { encryption: { [`urn:tinycloud:encryption:${OWNER}:other/share/${ID_A}`]: pair } } }, 'bad-grant'],
  ['a different account', { abilities: { encryption: { [`urn:tinycloud:encryption:did:pkh:eip155:1:0x${'1'.repeat(40)}:default/share/${ID_A}`]: pair } } }, 'bad-grant'],
  ['more than a day', { lifetimeMs: 3 * DAY }, 'grant-too-long'],
  ['an expiry after the invitation', { lifetimeMs: 2 * 3_600_000 }, 'grant-too-long'],
]) {
  test(`assertInvitationApprovalGrant refuses ${name}`, async () => {
    const { caps: verified, times } = await caps(options);
    assert.throws(() => assertInvitationApprovalGrant(verified, times, { ownerDid: OWNER, acceptanceExpiresAt: new Date(Date.now() + 3_600_000) }), { code });
  });
}


// ---- cmdInvite --mode email with a local approver -------------------------------------------------------------------

function setup() {
  saveKey(agent);
  saveProfile({
    version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: 'issuer', courierDid: agent.did, ownerDid: OWNER, spaceId: SPACE,
    grantExpiresAt: new Date(Date.now() + 20 * DAY).toISOString(), status: 'ready', peers: {},
  });
  const kv = memoryKv();
  const sessionId = ulid();
  kv.rows.set(sessionKey(sessionId), { value: { sessionId, subject: 'plan', createdAt: new Date().toISOString() }, etag: 'e0' });
  const calls = [];
  const node = {
    kv,
    getVerifiedSessionCapabilities: () => AGENT_GRANT.flatMap((permission) => permission.actions.map((action) => ({ ...permission, actions: [action], caveats: [] }))),
    async delegateTo(audience, permissions) {
      calls.push('delegateTo');
      return { delegation: { cid: 'bafyrelay', delegateDID: audience, expiry: new Date(Date.now() + 3_600_000), spaceId: SPACE, delegationHeader: { Authorization: 'Bearer relay' }, permissions } };
    },
  };
  const argv = () => parseArgs(['--session', sessionId, '--mode', 'email', '--recipient', 'Reader@Example.com', '--consent', '--wait', '1']);
  const events = { created: [], polls: 0, acked: 0, sent: [] };
  let answer = { status: 'pending' };
  const approval = {
    async create({ context }) { events.created.push(context); return { approvalUrl: 'https://openkey.example/a/x', transport: { n: events.created.length } }; },
    async poll() { events.polls += 1; return answer; },
    async acknowledge() { events.acked += 1; },
  };
  const send = async (_node, _profile, body, deps) => { events.sent.push({ body, shareId: deps.shareId(), keyNode: deps.keyNode }); return { shareId: deps.shareId() }; };
  const deps = { node: async () => node, approval, send };
  return { kv, calls, argv, events, deps, answer: (value) => { answer = value; } };
}

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const failure = (promise) => promise.then(() => undefined, (error) => error);
const pendingFiles = () => fs.readdirSync(path.join(profileDir(), 'pending-invites')).filter((name) => name.endsWith('.json'));

test('email invite without an approval: the request is made once with the prepared facts, nothing else is created, a rerun resumes it', async () => {
  const { kv, calls, argv, events, deps } = setup();
  const first = await failure(cmdInvite(argv(), deps));
  assert.equal(first?.code, 'invite-approval-pending');
  assert.equal(events.created.length, 1);
  const [context] = events.created;
  assert.equal(context.recipientEmail, 'reader@example.com');
  assert.equal(context.subjectName, 'plan');
  assert.ok(Date.parse(context.acceptanceExpiresAt) - Date.now() <= DAY);
  assert.equal(context.accessExpiresAt, context.acceptanceExpiresAt);
  // Nothing before approval: no relay delegation, no invitation state, nothing sent.
  assert.deepEqual(calls, []);
  assert.deepEqual([...kv.rows.keys()].filter((key) => key.includes('/state/invitations/')), []);
  assert.deepEqual(events.sent, []);
  const pending = loadPendingInvite(context.invitationId);
  assert.equal(pending.status, 'awaiting');
  assert.equal(pending.recipient, 'reader@example.com');
  // The same command again continues the same invitation: same id, no second request.
  const second = await failure(cmdInvite(argv(), deps));
  assert.equal(second?.code, 'invite-approval-pending');
  assert.equal(events.created.length, 1);
  assert.deepEqual(pendingFiles(), [`${context.invitationId}.json`]);
  assert.equal(loadInviteGrant(context.invitationId), undefined);
});

for (const [status, message] of [['denied', /declined/], ['expired', /expired/]]) {
  test(`email invite whose approval is ${status}: fails closed with nothing created, and the invitation id is not reused`, async () => {
    const { kv, calls, argv, events, deps, answer } = setup();
    answer({ status });
    const error = await failure(cmdInvite(argv(), deps));
    assert.equal(error?.code, 'invite-authority-missing');
    assert.match(error.message, /nothing was created/);
    assert.deepEqual(calls, []);
    assert.deepEqual([...kv.rows.keys()].filter((key) => key.includes('/state/invitations/')), []);
    assert.deepEqual(events.sent, []);
    const [{ invitationId }] = events.created;
    assert.equal(loadPendingInvite(invitationId).status, 'closed');
    await failure(cmdInvite(argv(), deps));
    assert.equal(events.created.length, 2);
    assert.notEqual(events.created[1].invitationId, invitationId);
    assert.match(String(message), /\//);
  });
}

test('email invite after a good approval: the approved key id, invitation id and expiry reach the single send; a rerun sends nothing more', async () => {
  const { kv, calls, argv, events, deps, answer } = setup();
  await failure(cmdInvite(argv(), deps));
  const [context] = events.created;
  answer({ status: 'approved', payload: await approval({ id: ID_A, lifetimeMs: Date.parse(context.acceptanceExpiresAt) - Date.now() - 60_000 }) });
  await quiet(() => failure(cmdInvite(argv(), deps)));
  assert.equal(events.sent.length, 1);
  const [sent] = events.sent;
  assert.equal(sent.shareId, ID_A);
  assert.equal(sent.body.id, context.invitationId);
  assert.equal(sent.body.expiresAt, context.acceptanceExpiresAt);
  assert.equal(sent.body.recipient, 'reader@example.com');
  assert.ok(sent.keyNode, 'the exact-key node is used for the key');
  assert.equal(events.acked, 1);
  assert.equal(loadPendingInvite(context.invitationId).status, 'sent');
  assert.equal(loadInviteGrant(context.invitationId).shareId, ID_A);
  assert.equal(loadGrant(), undefined, 'the main Courier grant is untouched');
  assert.ok(calls.includes('delegateTo'));
  assert.ok([...kv.rows.keys()].some((key) => key.includes(`/state/invitations/${context.invitationId}`)));
  // Running it again does not send another email for that approval.
  await quiet(() => failure(cmdInvite(argv(), deps)));
  assert.equal(events.sent.length, 1);
});

test('two runs racing on one approved invitation send exactly once', async () => {
  const { argv, events, deps, answer } = setup();
  await failure(cmdInvite(argv(), deps));
  const [context] = events.created;
  answer({ status: 'approved', payload: await approval({ id: ID_B, lifetimeMs: Date.parse(context.acceptanceExpiresAt) - Date.now() - 60_000 }) });
  const results = await quiet(() => Promise.all([failure(cmdInvite(argv(), deps)), failure(cmdInvite(argv(), deps))]));
  assert.equal(events.sent.length, 1);
  assert.equal(results.filter((error) => error?.code === 'invite-in-progress').length, 1);
});

for (const [name, build, code] of [
  ['an approval issued to another key', (context) => approval({ holder: other, lifetimeMs: Date.parse(context.acceptanceExpiresAt) - Date.now() - 60_000 }), 'bad-grant'],
  ['an approval for a prefix', (context) => approval({ abilities: { encryption: { [`${network}/share/`]: pair } }, lifetimeMs: Date.parse(context.acceptanceExpiresAt) - Date.now() - 60_000 }), 'bad-grant'],
  ['an approval that outlasts the invitation', (context) => approval({ lifetimeMs: Date.parse(context.acceptanceExpiresAt) - Date.now() + 2 * 3_600_000 }), 'grant-too-long'],
  ['an approval that has already lapsed', () => approval({ issuedAt: new Date(Date.now() - 2 * 3_600_000), lifetimeMs: 3_600_000 }), 'grant-expired'],
]) {
  test(`email invite refuses ${name}: nothing is created or sent`, async () => {
    const { kv, calls, argv, events, deps, answer } = setup();
    await failure(cmdInvite(argv(), deps));
    answer({ status: 'approved', payload: await build(events.created[0]) });
    const error = await failure(cmdInvite(argv(), deps));
    assert.equal(error?.code, code);
    assert.deepEqual(calls, []);
    assert.deepEqual(events.sent, []);
    assert.deepEqual([...kv.rows.keys()].filter((key) => key.includes('/state/invitations/')), []);
    assert.equal(loadInviteGrant(events.created[0].invitationId), undefined);
  });
}

test('the approved grant is reusable only for its own invitation and its own key', async () => {
  const { caps: verified } = await caps();
  const keyNode = { getVerifiedSessionCapabilities: () => verified, keys: { createKey: async () => { throw new Error('must not run'); } }, encryption: {} };
  const profile = { ownerDid: OWNER, spaceId: SPACE };
  const body = { mode: 'email', recipient: 'reader@example.com', id: ulid(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const error = await failure(sendEmailInvitation({}, profile, body, { shareId: () => ID_B, keyNode }));
  assert.equal(error?.code, 'invite-authority-missing');
});
