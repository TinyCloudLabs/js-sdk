// join when a hello is already stored that this machine cannot confirm is its own (another writer's, or its own whose response was lost),
// and a handle left behind by an earlier failed join. The store and acceptC are injected; acceptC is the real one or one built on the real
// assertPeerDelegation (audience and pinned issuer), because delegations themselves are checked live.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendHello, driveJoin, claimCallMe, resumeBlob, inviteWatcher, readJoin } from '../dist/invite-commands.js';
import { LINK_ISSUER, storedLink } from './support/invite-link-fixture.mjs';
import { buildInviteBlob } from '../dist/invite-blob.js';
import { acceptC as realAcceptC } from '../dist/commands.js';
import { assertPeerDelegation } from '../dist/authority.js';
import { peerReadPermissions } from '../dist/keys.js';
import { InviteWatcher, peersFilesFor } from '../dist/invite-watch.js';
import { secureSubdir, writeSecure } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

const INVITE_ID = 'a'.repeat(25) + 'b';
const OLD_INVITE_ID = 'a'.repeat(25) + 'c';
const HELLO_KEY = 'in/hello.json';
const WELCOME_KEY = 'out/welcome.json';
const ISSUED = '2026-10-07T00:00:00.000Z';
const US = 'did:key:z6MkInvitee';
const INVITER_COURIER = 'did:key:z6MkInviterCourier';
const OTHER_COURIER = 'did:key:z6MkNotThePinnedInviter';
const OTHER_AUDIENCE = 'did:key:z6MkSomeoneElse';
const INVITER_OWNER = `did:pkh:eip155:1:0x${'1'.repeat(40)}`;
const SPACE = `tinycloud:pkh:eip155:1:0x${'1'.repeat(40)}:agents`;
const MAILBOX = 'hunter';

let home;
let saved;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-unconfirmed-'));
  saved = process.env.COURIER_HOME;
  process.env.COURIER_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.COURIER_HOME;
  else process.env.COURIER_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

async function capture(fn) {
  const out = [];
  const log = console.log;
  console.log = (...parts) => out.push(parts.join(' ') + '\n');
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return out.join('');
}

const soon = (ms) => new Date(Date.now() + ms).toISOString();
const artifactA = () => ({
  type: 'courier-pair', v: 0, step: 'A', from: { owner: INVITER_OWNER, courier: INVITER_COURIER, label: 'Sam' },
  spaceId: SPACE, peer: MAILBOX, callMe: 'sam', issuedAt: ISSUED,
});
const blob = (expiresAt) => ({ inviteId: INVITE_ID, helloKey: HELLO_KEY, outPrefix: 'out/', expiresAt, oneTimeKey: { x: 'unused' }, permissions: {}, artifactA: artifactA() });
const hello = () => ({ v: 1, inviteId: INVITE_ID, artifactB: {}, claimedLabel: 'Hunter', sentAt: ISSUED });
const state = (stage = 'hello-ready') => ({ v: 1, inviteId: INVITE_ID, blob: '{}', helloText: JSON.stringify(hello()), stage });
const joinFile = (id = INVITE_ID) => path.join(secureSubdir('joins'), `${id}.json`);
const writeJoinFile = (s) => fs.writeFileSync(joinFile(s.inviteId), JSON.stringify(s), { mode: 0o600 });
const readJoinFile = () => JSON.parse(fs.readFileSync(joinFile(), 'utf8'));

const artifactC = (over = {}) => ({
  type: 'courier-pair', v: 0, step: 'C',
  from: { owner: INVITER_OWNER, courier: INVITER_COURIER },
  spaceId: SPACE, peer: MAILBOX, callMe: 'sam', issuedAt: ISSUED,
  delegation: 'good', delegationExpiresAt: '2099-01-01T00:00:00.000Z',
  ...over,
});
const welcome = (c = artifactC(), over = {}) => ({ v: 1, inviteId: INVITE_ID, tier: 'strict', artifactC: c, sentAt: ISSUED, ...over });

const profile = (status = 'awaiting-C') => ({
  version: 3, host: 'https://node.example.test', openkeyHost: 'https://openkey.example.test', label: 'hunter', courierDid: US, status: 'ready',
  peers: { sam: { handle: 'sam', ownerDid: INVITER_OWNER, courierDid: INVITER_COURIER, spaceId: SPACE, theirHandleForMe: MAILBOX, outbound: [], status, pairedAt: ISSUED } },
});

// What the node would report for a delegation inside an artifact C, by the delegation string. assertPeerDelegation is the real check.
const ACTIVE = {
  good: { audience: US, delegation: { delegatorDID: INVITER_COURIER }, expiry: new Date(Date.now() + 3600e3), effectivePermissions: peerReadPermissions(MAILBOX, SPACE) },
  'other-audience': { audience: OTHER_AUDIENCE, delegation: { delegatorDID: INVITER_COURIER }, expiry: new Date(Date.now() + 3600e3), effectivePermissions: peerReadPermissions(MAILBOX, SPACE) },
  'other-issuer': { audience: US, delegation: { delegatorDID: OTHER_COURIER }, expiry: new Date(Date.now() + 3600e3), effectivePermissions: peerReadPermissions(MAILBOX, SPACE) },
};

function acceptCWithRealChecks(accepted) {
  return async (p, _node, art) => {
    const peer = p.peers[art.callMe];
    assertPeerDelegation(ACTIVE[art.delegation], { issuer: peer.courierDid, audience: p.courierDid, spaceId: peer.spaceId, mailbox: peer.theirHandleForMe });
    accepted.push(art.delegation);
    return { ok: true, paired: peer.handle };
  };
}

const io = (kv, acceptC, extra = {}) => ({ kv: () => kv, acceptC, pollMs: 3, waitMs: 60_000, ...extra });
const unreadableIn = (kv) => ({ ...kv, get: async (key, ...rest) => (key === HELLO_KEY
  ? { ok: false, error: { code: 'KV_UNAUTHORIZED', message: 'unauthorized', service: 'kv', meta: { status: 401 } } }
  : kv.get(key, ...rest)) });

const refusedAtExpiry = (e) => e.code === 'hello-exists'
  && /could not be confirmed and no welcome was seen before the invite expired/.test(e.message)
  && /Ask the inviter for a new invite/.test(e.message)
  && /already exists/.test(e.message)
  && /revoke hunter/.test(e.message);

// A Welcome did arrive but does not verify for this courier: the refusal says so, with a stable code only.
const refusedAfterFailedWelcome = (code) => (e) => e.code === 'hello-exists'
  && e.message.includes(`the welcome that arrived does not verify for this courier (${code})`)
  && !/no welcome was seen/.test(e.message)
  && /Ask the inviter for a new invite/.test(e.message)
  && /already exists/.test(e.message)
  && /revoke hunter/.test(e.message);

// A Welcome did arrive but it could not be checked, or it is a decline: the refusal does not claim it failed verification.
const refusedAfterUnconfirmedWelcome = (code) => (e) => e.code === 'hello-exists'
  && e.message.includes(`the welcome that arrived could not be confirmed (${code})`)
  && !/does not verify/.test(e.message)
  && !/no welcome was seen/.test(e.message)
  && /Ask the inviter for a new invite/.test(e.message)
  && /revoke hunter/.test(e.message);

test('(i) another writer stored a different hello first: nothing is accepted, the join is refused at expiry, the object is untouched', async () => {
  const kv = memoryKv();
  await kv.put(HELLO_KEY, { ...hello(), claimedLabel: 'Someone else' });
  const s = state();
  writeJoinFile(s);
  const accepted = [];
  const b = blob(soon(120));
  await capture(() => sendHello(b, s, io(kv, acceptCWithRealChecks(accepted))));
  assert.equal(s.stage, 'hello-unconfirmed');
  await assert.rejects(capture(() => driveJoin(profile(), {}, b, s, io(kv, acceptCWithRealChecks(accepted)))), refusedAtExpiry);
  assert.deepEqual(accepted, []);
  assert.equal(kv.rows.get(HELLO_KEY).value.claimedLabel, 'Someone else');
  assert.equal(readJoinFile().stage, 'hello-unconfirmed');
});

test('(ii) the put landed but its response was lost: join --resume finds the conflict, polls, and the inviter\'s welcome pairs', async () => {
  const kv = memoryKv();
  const s = state();
  writeJoinFile(s);
  const accepted = [];
  const b = blob(soon(5000));
  // First attempt: the store commits the hello, the response never arrives.
  const lossy = { ...kv, put: async (...args) => { await kv.put(...args); throw new Error('ECONNRESET'); } };
  await assert.rejects(sendHello(b, s, io(lossy, acceptCWithRealChecks(accepted))), /ECONNRESET/);
  assert.equal(s.stage, 'hello-ready');
  assert.deepEqual(kv.rows.get(HELLO_KEY).value, hello());
  // Resume: the one-time key cannot read in/, so the conflict cannot be confirmed; the join waits instead of refusing.
  const resumed = readJoinFile();
  const readable = unreadableIn(kv);
  await capture(() => sendHello(b, resumed, io(readable, acceptCWithRealChecks(accepted))));
  assert.equal(resumed.stage, 'hello-unconfirmed');
  setTimeout(() => { void kv.put(WELCOME_KEY, welcome()); }, 25);
  await capture(() => driveJoin(profile(), {}, b, resumed, io(readable, acceptCWithRealChecks(accepted))));
  assert.deepEqual(accepted, ['good']);
  assert.equal(fs.existsSync(joinFile()), false);
  assert.deepEqual(kv.rows.get(HELLO_KEY).value, hello());
});

test('a resume from hello-unconfirmed never touches in/ again', async () => {
  const kv = memoryKv();
  const calls = [];
  const spy = { ...kv, put: async (...a) => { calls.push('put'); return kv.put(...a); }, get: async (key, ...a) => { calls.push(`get ${key}`); return kv.get(key, ...a); } };
  await sendHello(blob(soon(5000)), state('hello-unconfirmed'), io(spy, async () => ({})));
  assert.deepEqual(calls, []);
});

test('(iii) a welcome addressed to another audience is rejected and the wait runs to expiry', async () => {
  const kv = memoryKv();
  await kv.put(HELLO_KEY, { ...hello(), claimedLabel: 'Someone else' });
  await kv.put(WELCOME_KEY, welcome(artifactC({ delegation: 'other-audience' })));
  const accepted = [];
  const s = state('hello-unconfirmed');
  await assert.rejects(capture(() => driveJoin(profile(), {}, blob(soon(120)), s, io(kv, acceptCWithRealChecks(accepted)))), refusedAfterFailedWelcome('bad-delegation'));
  assert.deepEqual(accepted, []);
});

test('(iv) a welcome whose delegation is not from the pinned inviter is rejected and the wait runs to expiry', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, welcome(artifactC({ delegation: 'other-issuer' })));
  const accepted = [];
  await assert.rejects(capture(() => driveJoin(profile(), {}, blob(soon(120)), state('hello-unconfirmed'), io(kv, acceptCWithRealChecks(accepted)))), refusedAfterFailedWelcome('bad-delegation'));
  assert.deepEqual(accepted, []);
});

test('(iv) the real acceptC refuses an artifact C from a courier other than the pinned inviter: the peer stays awaiting-C', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, welcome(artifactC({ from: { owner: INVITER_OWNER, courier: OTHER_COURIER } })));
  const p = profile();
  await assert.rejects(capture(() => driveJoin(p, {}, blob(soon(120)), state('hello-unconfirmed'), io(kv, realAcceptC))), refusedAfterFailedWelcome('bad-artifact'));
  assert.equal(p.peers.sam.status, 'awaiting-C');
});

test('a rejected welcome in hello-unconfirmed says nothing about our hello: the wait runs to expiry', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, { v: 1, inviteId: INVITE_ID, tier: 'rejected', sentAt: ISSUED });
  const accepted = [];
  await assert.rejects(capture(() => driveJoin(profile(), {}, blob(soon(120)), state('hello-unconfirmed'), io(kv, acceptCWithRealChecks(accepted)))), refusedAfterUnconfirmedWelcome('rejected'));
  assert.equal(accepted.length, 0);
});

test('L2: a transient acceptC error is "could not be confirmed (<code>)", never "does not verify"', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, welcome());
  const flaky = async () => { throw Object.assign(new Error('socket hang up with a secret token in it'), { code: 'ECONNRESET' }); };
  const s = state('hello-unconfirmed');
  writeJoinFile(s);
  const out = await capture(() => driveJoin(profile(), {}, blob(soon(60_000)), s, io(kv, flaky, { waitMs: 40 })));
  assert.match(out, /A welcome arrived but could not be confirmed \(ECONNRESET\); still waiting\./);
  assert.doesNotMatch(out, /does not verify|secret token/);
  await assert.rejects(capture(() => driveJoin(profile(), {}, blob(soon(120)), state('hello-unconfirmed'), io(kv, flaky))), refusedAfterUnconfirmedWelcome('ECONNRESET'));
  assert.equal(readJoinFile().welcomeFailure, 'ECONNRESET');
});

// L4: join --resume <id> must not act on a state file that belongs to another invite.
test('L4: a join state file whose in-file id differs from its name is refused and left unchanged', () => {
  const crafted = { ...state('hello-unconfirmed'), inviteId: OLD_INVITE_ID };
  fs.writeFileSync(joinFile(INVITE_ID), JSON.stringify(crafted), { mode: 0o600 });
  const before = fs.readFileSync(joinFile(INVITE_ID), 'utf8');
  assert.throws(() => readJoin(INVITE_ID), (e) => e.code === 'bad-join-state');
  assert.equal(fs.readFileSync(joinFile(INVITE_ID), 'utf8'), before);
  assert.equal(fs.existsSync(joinFile(OLD_INVITE_ID)), false);
});

test('L4: a join state file that is JSON null or not an object is refused with bad-join-state, not a TypeError, and left unchanged', () => {
  for (const body of ['null', '[]', '"text"', '42', 'true']) {
    fs.writeFileSync(joinFile(INVITE_ID), body, { mode: 0o600 });
    assert.throws(() => readJoin(INVITE_ID), (e) => e.code === 'bad-join-state', body);
    assert.equal(fs.readFileSync(joinFile(INVITE_ID), 'utf8'), body);
  }
});

test('L4: a join state file whose id matches its name is read', () => {
  writeJoinFile(state('hello-sent'));
  assert.equal(readJoin(INVITE_ID).stage, 'hello-sent');
  assert.equal(readJoin(OLD_INVITE_ID), undefined);
});

test('(v) a stored hello identical to ours and readable is still sent, not unconfirmed', async () => {
  const kv = memoryKv();
  await kv.put(HELLO_KEY, hello());
  const s = state();
  writeJoinFile(s);
  await sendHello(blob(soon(5000)), s, io(kv, async () => ({})));
  assert.equal(s.stage, 'hello-sent');
  assert.equal(readJoinFile().stage, 'hello-sent');
});

test('while the wait cap is not yet at the invite expiry an unconfirmed join prints the resume command instead of refusing', async () => {
  const kv = memoryKv();
  const out = await capture(() => driveJoin(profile(), {}, blob(soon(60_000)), state('hello-unconfirmed'), io(kv, async () => ({}), { waitMs: 30 })));
  assert.match(out, /No reply yet\. Run `.*join --resume /);
});

// F7: a handle left behind by an earlier failed join.
const blobFor = (inviteId, over = {}) => ({ ...blob(soon(5000)), inviteId, ...over });

test('claimCallMe: an awaiting-C peer from the same inviter is replaced and the earlier join state is dropped, newer and other-handle joins stay', () => {
  const stale = { v: 1, inviteId: OLD_INVITE_ID, blob: JSON.stringify(blobFor(OLD_INVITE_ID)), helloText: '{}', stage: 'hello-unconfirmed' };
  const otherHandle = { v: 1, inviteId: 'b'.repeat(26), blob: JSON.stringify(blobFor('b'.repeat(26), { artifactA: { ...artifactA(), callMe: 'someone-else' } })), helloText: '{}', stage: 'hello-ready' };
  writeJoinFile(stale);
  writeJoinFile(otherHandle);
  claimCallMe(profile('awaiting-C'), blobFor(INVITE_ID));
  assert.equal(fs.existsSync(joinFile(OLD_INVITE_ID)), false);
  assert.equal(fs.existsSync(joinFile('b'.repeat(26))), true);
});

test('claimCallMe: a paired peer under the handle still blocks, and so does an awaiting-C peer of a different courier', () => {
  const blocked = (e) => e.code === 'usage' && /already exists/.test(e.message);
  assert.throws(() => claimCallMe(profile('paired'), blobFor(INVITE_ID)), blocked);
  const other = profile('awaiting-C');
  other.peers.sam.courierDid = OTHER_COURIER;
  assert.throws(() => claimCallMe(other, blobFor(INVITE_ID)), blocked);
});

test('claimCallMe: no peer under the handle is free', () => {
  claimCallMe({ ...profile(), peers: {} }, blobFor(INVITE_ID));
});

// Inviter side: an invite revoked or expired before it completed frees the handle; a paired peer does not.
function inviterWatcher(p, kv) {
  return new InviteWatcher({ node: { kv }, profile: () => p, log: () => undefined, now: () => new Date(), deleteLink: async () => undefined, peersFiles: [] });
}
function openRecord(handle) {
  const inviteId = 'c'.repeat(26);
  const record = {
    v: 1, inviteId, handle, callMe: 'sam', email: 'hunter@example.test', tier: 'strict', alsoAsk: false, expiresAt: soon(3600e3),
    link: storedLink('s'), oneTimeKeyHash: 'h', status: 'open',
  };
  writeSecure(path.join(secureSubdir('invites'), `${inviteId}.json`), record);
  return record;
}

test('invite revoke on its own frees a handle whose pairing never started; a paired peer is kept', async () => {
  const kv = memoryKv();
  const pending = { ...profile('pending-A'), peers: { hunter: { handle: 'hunter', ownerDid: '', courierDid: '', spaceId: '', outbound: [], theirHandleForMe: 'hunter', status: 'pending-A', pairedAt: ISSUED } } };
  await inviterWatcher(pending, kv).revoke(openRecord('hunter'));
  assert.equal(pending.peers.hunter, undefined);

  const paired = { ...profile('paired'), peers: { hunter: { handle: 'hunter', ownerDid: INVITER_OWNER, courierDid: US, spaceId: SPACE, outbound: [], theirHandleForMe: 'sam', status: 'paired', pairedAt: ISSUED } } };
  await inviterWatcher(paired, kv).revoke(openRecord('hunter'));
  assert.equal(paired.peers.hunter.status, 'paired');
});

// N1: the advice must still be reachable after the invite expired, and say which of the two situations it is.
const realBlobText = () => buildInviteBlob({
  inviteId: INVITE_ID, host: 'https://node.example.test', spaceId: SPACE,
  oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) },
  permissions: { put: 'P', read: 'R', hooks: 'H' }, artifactA: artifactA(), expiresAt: new Date(Date.now() + 3600e3),
  issuer: LINK_ISSUER, expectEmail: 'hunter@example.test', expectOwner: null, tier: 'strict',
});
const afterExpiry = () => Date.now() + 2 * 3600e3;

test('N1: resuming an unconfirmed join after the invite expired gives the hello-exists advice, not "invite is expired"', () => {
  const s = { ...state('hello-unconfirmed'), blob: realBlobText() };
  assert.throws(() => resumeBlob(s, afterExpiry()), refusedAtExpiry);
  const failed = { ...s, welcomeFailure: 'bad-delegation' };
  assert.throws(() => resumeBlob(failed, afterExpiry()), refusedAfterFailedWelcome('bad-delegation'));
});

test('N1: before expiry an unconfirmed join resumes, and any other stage still gets the schema\'s expired error', () => {
  const s = { ...state('hello-unconfirmed'), blob: realBlobText() };
  assert.equal(resumeBlob(s).inviteId, INVITE_ID);
  const sent = { ...state('hello-sent'), blob: realBlobText() };
  assert.throws(() => resumeBlob(sent, afterExpiry()), (e) => e.code === 'bad-invite-file' && /expired/.test(e.message));
});

test('N1: the first Welcome that fails verification is noted once, by stable code, and persisted for a later resume', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, welcome(artifactC({ delegation: 'other-audience' })));
  const s = state('hello-unconfirmed');
  writeJoinFile(s);
  await assert.rejects(capture(() => driveJoin(profile(), {}, blob(soon(120)), s, io(kv, acceptCWithRealChecks([])))), refusedAfterFailedWelcome('bad-delegation'));
  assert.equal(readJoinFile().welcomeFailure, 'bad-delegation');
  assert.equal(s.welcomeFailure, 'bad-delegation');
  // The notice is printed once however often the Welcome is polled: count it in a run that ends without refusing.
  const again = state('hello-unconfirmed');
  const out = await capture(() => driveJoin(profile(), {}, blob(soon(60_000)), again, io(kv, acceptCWithRealChecks([]), { waitMs: 40 })));
  assert.equal((out.match(/A welcome arrived but does not verify for this courier \(bad-delegation\)/g) ?? []).length, 1);
  assert.doesNotMatch(out, /did:key/);
});

// N4: revoke and deny never consult peers, so a bad peers path must not stop them.
test('N4: building the watcher for revoke or deny does not resolve the peers path; approve still does', () => {
  const saved = process.env.COURIER_PEERS_FILE;
  process.env.COURIER_PEERS_FILE = 'relative/peers.json';
  try {
    assert.doesNotThrow(() => inviteWatcher({ ...profile(), peers: {} }, { kv: memoryKv() }));
    assert.throws(() => peersFilesFor(), (e) => e.code === 'usage' && /absolute path/.test(e.message));
  } finally {
    if (saved === undefined) delete process.env.COURIER_PEERS_FILE;
    else process.env.COURIER_PEERS_FILE = saved;
  }
});

// N6: join state files are found and removed by NAME inside the joins directory, never by the id written inside them.
const staleBody = (inviteId) => ({ v: 1, inviteId, blob: JSON.stringify(blobFor(OLD_INVITE_ID)), helloText: '{}', stage: 'hello-unconfirmed' });

test('N6: an in-file id with ../ never reaches a path outside the joins directory', () => {
  const victim = path.join(path.dirname(secureSubdir('joins')), 'victim.json');
  fs.writeFileSync(victim, '{}');
  fs.writeFileSync(joinFile(OLD_INVITE_ID), JSON.stringify(staleBody('../victim')));
  claimCallMe(profile('awaiting-C'), blobFor(INVITE_ID));
  assert.equal(fs.existsSync(victim), true);
  assert.equal(fs.existsSync(joinFile(OLD_INVITE_ID)), true);
});

test('N6: a symlinked state file is neither followed nor removed', () => {
  const target = path.join(path.dirname(secureSubdir('joins')), 'target.json');
  fs.writeFileSync(target, JSON.stringify(staleBody(OLD_INVITE_ID)));
  fs.symlinkSync(target, joinFile(OLD_INVITE_ID));
  claimCallMe(profile('awaiting-C'), blobFor(INVITE_ID));
  assert.equal(fs.lstatSync(joinFile(OLD_INVITE_ID)).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), true);
});

test('N6: a state file whose name is not an invite id is left alone, and a join id that is not an invite id is refused as a path', async () => {
  const odd = path.join(secureSubdir('joins'), 'notes.json');
  fs.writeFileSync(odd, JSON.stringify(staleBody(OLD_INVITE_ID)));
  claimCallMe(profile('awaiting-C'), blobFor(INVITE_ID));
  assert.equal(fs.existsSync(odd), true);
  const escaping = { ...state('hello-ready'), inviteId: '../escape' };
  await assert.rejects(sendHello(blob(soon(5000)), escaping, io(memoryKv(), async () => ({}))), (e) => e.code === 'internal');
  assert.equal(fs.existsSync(path.join(path.dirname(secureSubdir('joins')), 'escape.json')), false);
});
