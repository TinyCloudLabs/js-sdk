import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { parseArgs } from '../dist/args.js';
import { assertApprovalRequestBinding, assertInvitationApprovalGrant, parseApprovalSiwe, siweTimes } from '../dist/authority.js';
import { PREFIX } from '../dist/keys.js';
import { sessionKey } from '../dist/guided.js';
import { runInvite as cmdInvite } from '../dist/invitation.js';
import { claimInviteSend, loadInviteGrant, loadPendingInvite } from '../dist/invite-approval.js';
import { loadGrant, profileDir, saveKey, saveProfile } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';
import { DAY, HOST, KEY_ACTIONS, bodyCidOf, courierNodeFor, inviteGrant, newAgent, newOwner, requestIdOf, shareIdOf, stubActivation } from './support/invite-grant-fixture.mjs';

const owner = await newOwner();
const agent = newAgent('courier');
const stranger = newAgent('stranger');
const network = `urn:tinycloud:encryption:${owner.did}:default`;
const realNode = await courierNodeFor(owner, agent);
let restoreFetch;
beforeEach(() => { restoreFetch = stubActivation(); });
afterEach(() => restoreFetch());

const verify = (grant) => realNode.verifySessionGrant({ ...grant.payload, delegationHeader: { Authorization: grant.payload.delegationHeader.Authorization } });
const signedEntries = (verified) => verified.recap.map((entry) => ({ service: `tinycloud.${entry.service}`, space: entry.space, path: entry.path, actions: entry.actions, caveats: [] }));
const bounds = (hours = 1) => ({ ownerDid: owner.did, acceptanceExpiresAt: new Date(Date.now() + hours * 3_600_000) });
const request = () => ({ requestId: requestIdOf(), bodyCid: bodyCidOf() });

// ---- the signed authority ------------------------------------------------------------------------------------------------

test('a real owner-signed invitation grant yields exactly its key id', async () => {
  const grant = await inviteGrant(owner, agent, { request: request() });
  const verified = verify(grant);
  assert.equal(assertInvitationApprovalGrant(signedEntries(verified), siweTimes(grant.payload.siwe), bounds()), grant.shareId);
});

const keyPath = (id) => `${network}/share/${id}`;
for (const [name, rawAbilities, options, code] of [
  ['more authority than the key pair', { [keyPath(shareIdOf())]: KEY_ACTIONS, [`${network}`]: ['tinycloud.encryption/decrypt'] }, {}, 'bad-grant'],
  ['half a pair', { [keyPath(shareIdOf())]: [KEY_ACTIONS[1]] }, {}, 'bad-grant'],
  ['two keys', { [keyPath(shareIdOf())]: KEY_ACTIONS, [keyPath(shareIdOf())]: KEY_ACTIONS }, {}, 'bad-grant'],
  ['the share prefix', { [`${network}/share/`]: KEY_ACTIONS }, {}, 'bad-grant'],
  ['an upper-case id', { [keyPath(shareIdOf().toUpperCase())]: KEY_ACTIONS }, {}, 'bad-grant'],
  ['another network', { [`urn:tinycloud:encryption:${owner.did}:other/share/${shareIdOf()}`]: KEY_ACTIONS }, {}, 'bad-grant'],
  ['a different account', { [`urn:tinycloud:encryption:did:pkh:eip155:1:0x${'1'.repeat(40)}:default/share/${shareIdOf()}`]: KEY_ACTIONS }, {}, 'bad-grant'],
  ['more than a day', undefined, { lifetimeMs: 3 * DAY }, 'grant-too-long'],
  ['an expiry after the invitation', undefined, { lifetimeMs: 2 * 3_600_000 }, 'grant-too-long'],
]) {
  test(`assertInvitationApprovalGrant refuses ${name}`, async () => {
    const grant = await inviteGrant(owner, agent, { request: request(), rawAbilities, ...options });
    assert.throws(() => assertInvitationApprovalGrant(signedEntries(verify(grant)), siweTimes(grant.payload.siwe), bounds()), { code });
  });
}

test('the approval window has no slack: an expiry one second past the invitation is refused', async () => {
  const lifetimeMs = 3_600_000 + 1000;
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const acceptanceExpiresAt = new Date(issuedAt.getTime() + 3_600_000);
  const grant = await inviteGrant(owner, agent, { request: request(), issuedAt, lifetimeMs });
  assert.throws(() => assertInvitationApprovalGrant(signedEntries(verify(grant)), siweTimes(grant.payload.siwe), { ownerDid: owner.did, acceptanceExpiresAt }), { code: 'grant-too-long' });
});

test('a grant issued to another key does not verify for this Courier node', async () => {
  const grant = await inviteGrant(owner, stranger, { request: request() });
  assert.throws(() => verify(grant));
});

// ---- the signed request binding ----------------------------------------------------------------------------------------------

test('assertApprovalRequestBinding accepts only the one Request ID of this request', async () => {
  const mine = request();
  const good = await inviteGrant(owner, agent, { request: mine });
  assert.doesNotThrow(() => assertApprovalRequestBinding(good.payload.siwe, mine));
  const wrongId = await inviteGrant(owner, agent, { request: { ...mine, requestId: requestIdOf() } });
  const wrongDigest = await inviteGrant(owner, agent, { request: { ...mine, bodyCid: bodyCidOf() } });
  const missing = await inviteGrant(owner, agent, { request: mine, bind: false });
  const line = `Request ID: urn:tinycloud:approval-request:${mine.requestId}:${mine.bodyCid}`;
  const twice = { payload: { siwe: good.payload.siwe.replace(line, `${line}\n${line}`) } };
  // Texts the signer cannot even produce are still refused by the verifier: edit the signed text (the check is on the text).
  const malformed = { payload: { siwe: good.payload.siwe.replace(line, `Request ID: ${mine.requestId}:${mine.bodyCid}`) } };
  const padded = { payload: { siwe: good.payload.siwe.replace(line, `${line} `) } };
  const lowercased = { payload: { siwe: good.payload.siwe.replace(line, line.replace('Request ID', 'request id')) } };
  for (const bad of [wrongId, wrongDigest, missing, twice, malformed, padded, lowercased]) {
    assert.throws(() => assertApprovalRequestBinding(bad.payload.siwe, mine), { code: 'bad-grant' });
  }
});

// The binding is read only from one strict parse of a canonical message. Each case below calls the binding function directly on its
// own text, so no earlier or unrelated parse can hide the mutation. The text is a real owner signature WITHOUT the binding field, with
// a Request ID line for THIS request injected somewhere the parser does not read as that field.
test('a Request ID injected where the EIP-4361 parser does not read it never binds, whatever else was parsed before', async () => {
  const mine = request();
  const unbound = await inviteGrant(owner, agent, { request: mine, bind: false });
  const siwe = unbound.payload.siwe;
  const line = `Request ID: urn:tinycloud:approval-request:${mine.requestId}:${mine.bodyCid}`;
  const rows = siwe.split('\n');
  const inject = (index) => [...rows.slice(0, index), line, ...rows.slice(index)].join('\n');
  for (const [name, text] of [['line 2', inject(1)], ['line 3', inject(2)], ['line 4', inject(3)], ['after the statement', inject(5)], ['at the end', `${siwe}\n${line}`],
    ['inside the address line', siwe.replace(/(\n0x[0-9a-fA-F]{40})\n/, `$1\n${line}\n`)]]) {
    assert.throws(() => assertApprovalRequestBinding(text, mine), { code: 'bad-grant' }, name);
    assert.throws(() => parseApprovalSiwe(text), { code: 'bad-grant' }, `${name} (parse)`);
  }
  // REPLACEMENT of the blank lines (index 2 and 4) on the real owner-signed unbound text: the attack shape the signer accepts.
  for (const index of [2, 4]) {
    for (const replacement of [line, `Issued At: ${new Date(Date.now() - 10 * DAY).toISOString()}`]) {
      const replaced = rows.map((row, at) => (at === index ? replacement : row)).join('\n');
      assert.throws(() => assertApprovalRequestBinding(replaced, mine), { code: 'bad-grant' }, `replace ${index} with ${replacement.slice(0, 12)}`);
    }
  }
  // The unmodified unbound message parses but carries no binding.
  assert.equal(parseApprovalSiwe(siwe).requestId, undefined);
  assert.throws(() => assertApprovalRequestBinding(siwe, mine), { code: 'bad-grant' });
});

test('the approval message must be canonical: its re-serialisation is the identical text', async () => {
  const mine = request();
  const good = await inviteGrant(owner, agent, { request: mine });
  const siwe = good.payload.siwe;
  const parsed = parseApprovalSiwe(siwe);
  assert.equal(parsed.raw, siwe);
  assert.equal(parsed.requestId, `urn:tinycloud:approval-request:${mine.requestId}:${mine.bodyCid}`);
  assert.doesNotThrow(() => assertApprovalRequestBinding(parsed, mine));
  // The equality branch itself: the EIP-4361 parser accepts 'Chain ID: 01' (it reads 1), but re-serialising gives 'Chain ID: 1', which is not the signed text.
  const leadingZero = siwe.replace('Chain ID: 1', 'Chain ID: 01');
  assert.notEqual(leadingZero, siwe);
  assert.throws(() => parseApprovalSiwe(leadingZero), { code: 'bad-grant', message: /canonical form/ });
  for (const text of [siwe.replace(/\n/g, '\r\n'), `${siwe}\n`, ` ${siwe}`, siwe.replace('Version: 1', 'Version:  1'), siwe.replace(/\n\n/, '\n\n\n')]) {
    assert.throws(() => parseApprovalSiwe(text), { code: 'bad-grant' });
  }
});

// ---- cmdInvite --mode email -------------------------------------------------------------------------------------------------

function setup() {
  saveKey(agent);
  saveProfile({
    version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: 'issuer', courierDid: agent.did, ownerDid: owner.did, spaceId: owner.space,
    grantExpiresAt: new Date(Date.now() + 20 * DAY).toISOString(), status: 'ready', peers: {},
  });
  const kv = memoryKv();
  const sessionId = ulid();
  kv.rows.set(sessionKey(sessionId), { value: { sessionId, subject: 'plan', createdAt: new Date().toISOString() }, etag: 'e0' });
  const calls = [];
  const node = new Proxy(realNode, {
    get(target, property) {
      if (property === 'kv') return kv;
      if (property === 'delegateTo') {
        return async (audience, permissions) => {
          calls.push('delegateTo');
          return { delegation: { cid: 'bafyrelay', delegateDID: audience, expiry: new Date(Date.now() + 3_600_000), spaceId: owner.space, delegationHeader: { Authorization: 'Bearer relay' }, permissions } };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const argv = () => parseArgs(['--session', sessionId, '--mode', 'email', '--recipient', 'Reader@Example.com', '--consent', '--wait', '1']);
  const events = { created: [], polls: 0, acked: 0, sent: [], failSend: false };
  let answer = async () => ({ status: 'pending' });
  const approval = {
    async create({ context }) { events.created.push(context); return { approvalUrl: 'https://openkey.example/a/x', transport: { requestId: requestIdOf(), bodyCid: bodyCidOf() } }; },
    async poll(pending) { events.polls += 1; return answer(pending); },
    async acknowledge() { events.acked += 1; },
  };
  const send = async (_node, _profile, body, deps) => {
    if (events.failSend) throw new Error('the Share service is unavailable');
    events.sent.push({ body, shareId: deps.shareId() });
    return { shareId: deps.shareId() };
  };
  const approve = (options = {}) => { answer = async (pending) => ({ status: 'approved', payload: (await inviteGrant(owner, options.holder ?? agent, { request: pending.transport, ...options })).payload }); };
  return { kv, calls, argv, events, deps: { node: async () => node, approval, send }, answer: (value) => { answer = async () => value; }, approve, node };
}

const quiet = async (fn) => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = error; }
};
const failure = (promise) => promise.then(() => undefined, (caught) => caught);
const invitationState = (kv) => [...kv.rows.keys()].filter((key) => key.includes('/state/invitations/'));
const pendingFiles = () => fs.readdirSync(path.join(profileDir(), 'pending-invites')).filter((name) => name.endsWith('.json'));

test('email invite without an approval: one request with the prepared facts, nothing else created, a rerun resumes it', async () => {
  const { kv, calls, argv, events, deps } = setup();
  const first = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(first?.code, 'invite-approval-pending');
  assert.equal(events.created.length, 1);
  const [context] = events.created;
  assert.equal(context.recipientEmail, 'reader@example.com');
  assert.equal(context.subjectName, 'plan');
  assert.ok(Date.parse(context.acceptanceExpiresAt) - Date.now() <= DAY);
  assert.equal(context.accessExpiresAt, context.acceptanceExpiresAt);
  assert.deepEqual(calls, []);
  assert.deepEqual(invitationState(kv), []);
  assert.deepEqual(events.sent, []);
  assert.equal(loadPendingInvite(context.invitationId).status, 'awaiting');
  const second = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(second?.code, 'invite-approval-pending');
  assert.equal(events.created.length, 1);
  assert.deepEqual(pendingFiles(), [`${context.invitationId}.json`]);
  assert.equal(loadInviteGrant(context.invitationId), undefined);
});

for (const status of ['denied', 'expired']) {
  test(`email invite whose approval is ${status}: fails closed with nothing created, and a rerun asks afresh`, async () => {
    const { kv, calls, argv, events, deps, answer } = setup();
    answer({ status });
    const error = await failure(quiet(() => cmdInvite(argv(), deps)));
    assert.equal(error?.code, 'invite-authority-missing');
    assert.match(error.message, /nothing was created/);
    assert.deepEqual(calls, []);
    assert.deepEqual(invitationState(kv), []);
    assert.deepEqual(events.sent, []);
    const [{ invitationId }] = events.created;
    assert.equal(loadPendingInvite(invitationId).status, 'closed');
    await failure(quiet(() => cmdInvite(argv(), deps)));
    assert.equal(events.created.length, 2);
    assert.notEqual(events.created[1].invitationId, invitationId);
  });
}

test('an approval transport that cannot be reached fails closed with nothing created', async () => {
  const { kv, calls, argv, events, deps } = setup();
  deps.approval.create = async () => { throw Object.assign(new Error('x'), { name: 'CourierError', code: 'approval-unavailable' }); };
  const { CourierError } = await import('../dist/errors.js');
  deps.approval.create = async () => { throw new CourierError('approval-unavailable', 'unreachable'); };
  const error = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(error?.code, 'invite-authority-missing');
  assert.deepEqual(calls, []);
  assert.deepEqual(invitationState(kv), []);
  assert.deepEqual(events.sent, []);
});

test('after a good approval: the signed key id, invitation id and expiry reach the single send; the base grant is unchanged; a rerun sends nothing more', async () => {
  const { kv, calls, argv, events, deps, approve, answer, node } = setup();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [context] = events.created;
  approve({ lifetimeMs: Date.parse(context.acceptanceExpiresAt) - Date.now() - 60_000 });
  await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(events.sent.length, 1);
  const [sent] = events.sent;
  const stored = loadInviteGrant(context.invitationId);
  assert.equal(sent.shareId, stored.shareId);
  assert.equal(sent.body.id, context.invitationId);
  assert.equal(sent.body.expiresAt, context.acceptanceExpiresAt);
  assert.equal(sent.body.recipient, 'reader@example.com');
  assert.equal(events.acked, 1);
  assert.equal(loadPendingInvite(context.invitationId).status, 'sent');
  assert.equal(loadGrant(), undefined, 'the main Courier grant is untouched');
  // The grant is installed as exactly this one key's runtime authority; the session's own authority has no encryption entry.
  const installedKeys = node.getRuntimePermissionDelegations().flatMap((delegation) => delegation.resources ?? []).filter((resource) => resource.path.includes('/share/'));
  assert.deepEqual(installedKeys.map((resource) => resource.path), [`${network}/share/${stored.shareId}`]);
  assert.deepEqual([...installedKeys[0].actions].sort(), [...KEY_ACTIONS].sort());
  assert.equal(node.getVerifiedSessionCapabilities().some((entry) => entry.service === 'tinycloud.encryption'), false);
  assert.ok(calls.includes('delegateTo'));
  assert.ok([...kv.rows.keys()].some((key) => key.includes(`/state/invitations/${context.invitationId}`)));
  // Running it again is a NEW invitation: it asks for its own approval and, until that is given, sends nothing.
  answer({ status: 'pending' });
  const again = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(again?.code, 'invite-approval-pending');
  assert.equal(events.created.length, 2);
  assert.notEqual(events.created[1].invitationId, context.invitationId);
  assert.equal(events.sent.length, 1);
});

test('two runs racing on one approved invitation send exactly once', async () => {
  const { argv, events, deps, approve } = setup();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  approve({ lifetimeMs: Date.parse(events.created[0].acceptanceExpiresAt) - Date.now() - 60_000 });
  const results = await quiet(() => Promise.all([failure(cmdInvite(argv(), deps)), failure(cmdInvite(argv(), deps))]));
  assert.equal(events.sent.length, 1);
  assert.equal(results.filter((error) => error?.code === 'invite-in-progress').length, 1);
});

test('a claim that finds the marker never overwrites a send already recorded as sent', async () => {
  const { argv, events, deps, approve } = setup();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [context] = events.created;
  approve({ lifetimeMs: lifetimeFor(context) });
  await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(events.sent.length, 1);
  assert.equal(loadPendingInvite(context.invitationId).status, 'sent');
  // A concurrent run holding a stale in-memory copy still says awaiting: its claim is refused and the recorded status is untouched.
  const stale = { ...loadPendingInvite(context.invitationId), status: 'awaiting' };
  assert.throws(() => claimInviteSend(stale), { code: 'invite-in-progress' });
  assert.equal(loadPendingInvite(context.invitationId).status, 'sent');
});

test('a host that cannot be reached while installing the approval keeps the pending invitation; the next run installs the same approval', async () => {
  const { argv, events, deps, approve } = setup();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [context] = events.created;
  approve({ lifetimeMs: lifetimeFor(context) });
  const working = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/delegate') throw new TypeError('fetch failed');
    return working(input, init);
  };
  let down;
  try { down = await failure(quiet(() => cmdInvite(argv(), deps))); } finally { globalThis.fetch = working; }
  assert.equal(down?.code, 'activation-unavailable', down?.message);
  assert.equal(loadPendingInvite(context.invitationId).status, 'awaiting', 'the approved pending invitation is kept');
  assert.equal(events.sent.length, 0);
  assert.equal(events.created.length, 1, 'no new approval is requested');
  assert.equal(fs.existsSync(path.join(profileDir(), 'pending-invites', `${context.invitationId}.sending`)), false, 'nothing was claimed');
  await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(events.sent.length, 1, 'the same approval is used once the host answers');
  assert.equal(events.sent[0].body.id, context.invitationId);
  assert.equal(events.created.length, 1);
});

// What is refused, and that a refused result closes the pending invitation but never deletes anything approved.
const replaceRow = (index, replacement) => (siwe, { binding }) => siwe.split('\n').map((row, at) => (at === index ? replacement(binding) : row)).join('\n');
const lifetimeFor = (context) => Date.parse(context.acceptanceExpiresAt) - Date.now() - 60_000;
for (const [name, options, code] of [
  ['an approval issued to another key', (context) => ({ holder: stranger, lifetimeMs: lifetimeFor(context) }), 'bad-grant'],
  ['an approval for a prefix', (context) => ({ rawAbilities: { [`${network}/share/`]: KEY_ACTIONS }, lifetimeMs: lifetimeFor(context) }), 'bad-grant'],
  ['an approval with more authority than one key', (context) => ({ rawAbilities: { [keyPath(shareIdOf())]: KEY_ACTIONS, [keyPath(shareIdOf())]: KEY_ACTIONS }, lifetimeMs: lifetimeFor(context) }), 'bad-grant'],
  ['an approval that outlasts the invitation', (context) => ({ lifetimeMs: lifetimeFor(context) + 2 * 3_600_000 }), 'grant-too-long'],
  ['an approval signed without the request binding', (context) => ({ bind: false, lifetimeMs: lifetimeFor(context) }), 'bad-grant'],
  // The owner really signs a message whose blank line 2 or 4 is REPLACED (not inserted) by a Request ID or Issued At line: the strict parse refuses it, nothing is installed.
  ...[2, 4].flatMap((index) => [
    [`an approval whose blank line ${index} is replaced by the Request ID`, (context) => ({ bind: false, rewrite: replaceRow(index, (binding) => binding), lifetimeMs: lifetimeFor(context) }), 'bad-grant'],
    [`an approval whose blank line ${index} is replaced by an Issued At`, (context) => ({ rewrite: replaceRow(index, () => `Issued At: ${new Date(Date.now() - 10 * DAY).toISOString()}`), lifetimeMs: lifetimeFor(context) }), 'bad-grant'],
  ]),
  ['an approval whose binding names another request id', (context) => ({ request: { requestId: requestIdOf(), bodyCid: 'x' }, lifetimeMs: lifetimeFor(context) }), 'bad-grant'],
]) {
  test(`email invite refuses ${name}: nothing is created or sent and the pending invitation is closed`, async () => {
    const { kv, calls, argv, events, deps, approve } = setup();
    await failure(quiet(() => cmdInvite(argv(), deps)));
    const [context] = events.created;
    approve(options(context));
    const error = await failure(quiet(() => cmdInvite(argv(), deps)));
    assert.equal(error?.code, code);
    assert.deepEqual(calls, []);
    assert.deepEqual(events.sent, []);
    assert.deepEqual(invitationState(kv), []);
    assert.equal(loadInviteGrant(context.invitationId), undefined);
    assert.equal(loadPendingInvite(context.invitationId).status, 'closed');
  });
}

test('a valid owner approval for request X, returned as the result for request Y, is refused', async () => {
  const { kv, calls, argv, events, deps, answer } = setup();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [context] = events.created;
  const x = await inviteGrant(owner, agent, { request: request(), lifetimeMs: lifetimeFor(context) });
  answer({ status: 'approved', payload: x.payload });
  const error = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(error?.code, 'bad-grant');
  assert.match(error.message, /not signed for this invitation request/);
  assert.deepEqual(calls, []);
  assert.deepEqual(events.sent, []);
  assert.deepEqual(invitationState(kv), []);
});

test('one key id cannot serve two invitations, even with a correctly bound approval', async () => {
  const { argv, events, deps, answer } = setup();
  const reused = shareIdOf();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  answer({ status: 'pending' });
  deps.approval.poll = async (pending) => ({ status: 'approved', payload: (await inviteGrant(owner, agent, { request: pending.transport, shareId: reused, lifetimeMs: lifetimeFor(events.created.at(-1)) })).payload });
  await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(events.sent.length, 1);
  // A second invitation (the first is sent, so this one asks afresh) is approved with the SAME key id.
  const second = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(second?.code, 'bad-grant');
  assert.match(second.message, /already used for another invitation/);
  assert.equal(events.sent.length, 1);
});

// ---- a failed send ends the invitation, not the next 24 hours ----------------------------------------------------------------

test('a send that fails closes the pending invitation; the claim stays, so the same approval is never used twice, and a rerun asks afresh', async () => {
  const { argv, events, deps, approve } = setup();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [context] = events.created;
  approve({ lifetimeMs: lifetimeFor(context) });
  events.failSend = true;
  const failed = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.match(failed.message, /Share service is unavailable/);
  assert.equal(loadPendingInvite(context.invitationId).status, 'closed');
  assert.ok(fs.existsSync(path.join(profileDir(), 'pending-invites', `${context.invitationId}.sending`)), 'the send claim is kept');
  assert.ok(loadInviteGrant(context.invitationId), 'the approved grant is kept, never deleted');
  events.failSend = false;
  approve({ lifetimeMs: Date.parse(new Date(Date.now() + DAY).toISOString()) - Date.now() - 120_000 });
  const rerun = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(events.created.length, 2, 'a new approval is requested instead of waiting out the old window');
  assert.notEqual(events.created[1].invitationId, context.invitationId);
  assert.equal(rerun?.code === undefined || rerun.code === 'invite-approval-pending' || rerun.code === 'invite-pending', true);
});

test('an attempt interrupted after the send claim: the next run closes the stale invitation, keeps the claim and the approval, and asks afresh', async () => {
  const { argv, events, deps, approve } = setup();
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [context] = events.created;
  approve({ lifetimeMs: lifetimeFor(context) });
  // The earlier process died after claiming and before sending or closing: the marker exists, the pending invitation is still open.
  fs.writeFileSync(path.join(profileDir(), 'pending-invites', `${context.invitationId}.sending`), '', { mode: 0o600 });
  assert.equal(loadPendingInvite(context.invitationId).status, 'awaiting');
  const stale = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(stale?.code, 'invite-in-progress');
  assert.equal(events.sent.length, 0, 'the claimed approval is never used to send');
  assert.equal(loadPendingInvite(context.invitationId).status, 'closed');
  assert.ok(fs.existsSync(path.join(profileDir(), 'pending-invites', `${context.invitationId}.sending`)), 'the claim is kept');
  assert.ok(loadInviteGrant(context.invitationId), 'the approved grant is kept, never deleted');
  const fresh = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(events.created.length, 2, 'the retry asks the owner for a new approval');
  assert.notEqual(events.created[1].invitationId, context.invitationId);
  // The fixture answers every request as approved, so the retry may complete: only as its OWN invitation under its OWN approval.
  assert.ok(fresh === undefined || ['invite-approval-pending', 'invite-pending'].includes(fresh.code));
  for (const sent of events.sent) {
    assert.notEqual(sent.body.id, context.invitationId, 'the interrupted invitation is never sent');
    assert.notEqual(sent.shareId, loadInviteGrant(context.invitationId).shareId, 'the stale approval is never used');
  }
  assert.ok(events.sent.length <= 1);
});

test('an approver that no longer knows the request closes the pending invitation', async () => {
  const { argv, events, deps } = setup();
  const { CourierError } = await import('../dist/errors.js');
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [context] = events.created;
  deps.approval.poll = async () => { throw new CourierError('approval-unavailable', 'OpenKey does not recognise this approval request.'); };
  const error = await failure(quiet(() => cmdInvite(argv(), deps)));
  assert.equal(error?.code, 'invite-authority-missing');
  assert.equal(loadPendingInvite(context.invitationId).status, 'closed');
});

// ---- the recipient is only ever the one the owner was asked about ------------------------------------------------------------

test('the invitation goes to the recipient of the approved pending invitation: another recipient needs its own approval', async () => {
  const { argv, events, deps, approve } = setup();
  const sessionArg = argv().get('session');
  const other = () => parseArgs(['--session', sessionArg, '--mode', 'email', '--recipient', 'Blair@Example.com', '--consent', '--wait', '1']);
  await failure(quiet(() => cmdInvite(argv(), deps)));
  const [first] = events.created;
  assert.equal(first.recipientEmail, 'reader@example.com');
  // A run for someone else does not pick up the first recipient's pending invitation or approval.
  await failure(quiet(() => cmdInvite(other(), deps)));
  assert.equal(events.created.length, 2);
  assert.equal(events.created[1].recipientEmail, 'blair@example.com');
  assert.notEqual(events.created[1].invitationId, first.invitationId);
  // Approving the second request sends to the second recipient only; the first stays unanswered.
  approve({ lifetimeMs: lifetimeFor(events.created[1]) });
  deps.approval.poll = ((poll) => async (pending) => (pending.invitationId === events.created[1].invitationId ? poll(pending) : { status: 'pending' }))(deps.approval.poll);
  await failure(quiet(() => cmdInvite(other(), deps)));
  assert.deepEqual(events.sent.map((sent) => sent.body.recipient), ['blair@example.com']);
  assert.equal(loadPendingInvite(first.invitationId).status, 'awaiting');
  assert.equal(loadInviteGrant(first.invitationId), undefined);
});
