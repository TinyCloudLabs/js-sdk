// A pairing step that gave up at its deadline must not change anything later (H-A), a stale view must not close a finished invite (M-A), a Welcome that
// is already out is found before a grant is minted (M-B), and a grant that may exist is written down for the owner. The REAL acceptB runs here; only the
// validation of the peer's delegation and the node (kv, delegateTo) are stand-ins. Short deadlines come from the `timing` seam. Isolated under /var/tmp.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inviteRecordsFor, storedRecord, approveSummary } from '../dist/invite-commands.js';
import { InviteWatcher, describeHeld, heldFactsText, readRecord, recordPath } from '../dist/invite-watch.js';
import { writePublicInvite } from '../dist/invite-public.js';
import { listGrants, grantPath } from '../dist/grant-record.js';
import { noticeText } from '../dist/notify.js';
import { inviteFolder } from '../dist/invite-schema.js';
import { newInviteId } from '../dist/invite-blob.js';
import { writeSecure, saveProfile, loadProfile, secureSubdir } from '../dist/profile.js';
import { acceptB } from '../dist/commands.js';
import { memoryKv } from './memory-kv.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const NOW = Date.now();
const ISSUED = new Date(NOW).toISOString();
const DAY = 864e5;
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_OWNER = `did:pkh:eip155:1:0x${'a'.repeat(40)}`;
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';
const SPACE = `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`;
const EMAIL = 'hunter@example.test';
const EXPIRES = new Date(NOW + 7 * DAY).toISOString();

let home;
let saved;
let kv;
let logs;
let clock;
let delegations;
let releases;
let delegateScript;
let validateHangs;
let notices;

beforeEach(() => {
  home = fs.mkdtempSync(path.join('/var/tmp', 'tc712.late.'));
  fs.chmodSync(home, 0o700);
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  process.env.COURIER_HOME = home;
  process.env.HOME = home;
  delete process.env.COURIER_PEERS_FILE;
  assert.ok(process.env.COURIER_HOME.startsWith('/var/tmp/tc712.') && process.env.HOME.startsWith('/var/tmp/tc712.'));
  kv = memoryKv();
  logs = [];
  notices = [];
  clock = NOW;
  delegations = 0;
  releases = [];
  delegateScript = [];
  validateHangs = false;
  saveProfile({ version: 3, host: 'https://h.example.test', openkeyHost: 'https://h.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: SPACE, status: 'ready',
    peers: { hunter: { handle: 'hunter', ownerDid: '', courierDid: '', spaceId: '', outbound: [], theirHandleForMe: 'hunter', status: 'pending-A', pairedAt: ISSUED } } });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(n = 40) { for (let i = 0; i < n; i++) await flush(); }

const stubValidate = async () => {
  if (validateHangs) return new Promise(() => undefined);
  return { delegation: { cid: 'in-cid', expiry: new Date(NOW + 7 * DAY), spaceId: SPACE }, cid: 'in-cid', expiresAt: EXPIRES };
};

/** The node: delegateTo follows `delegateScript` ('hang' answers late through releases[n], anything else answers at once). */
const node = {
  get kv() { return kv; },
  async delegateTo() {
    const n = ++delegations;
    const d = { delegation: { cid: `out-${n}`, expiry: new Date(NOW + 7 * DAY), spaceId: SPACE } };
    if (delegateScript[n - 1] === 'hang') return new Promise((resolve) => { releases[n] = () => resolve(d); });
    return d;
  },
};

const realAccept = (p, n, a, h, deps) => acceptB(p, n, a, h, { ...deps, validatePeerDelegation: stubValidate });
const timing = { nodeTimeoutMs: 40 };
function watcher({ profile = () => loadProfile(), now = () => new Date(clock), accept = realAccept, notify = async (n) => { notices.push(n); } } = {}) {
  return new InviteWatcher({
    node, profile, log: (e) => logs.push(e), notify, now, timing,
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }),
    accept, deleteSealed: async () => undefined, peersFiles: [],
  });
}

const publicDir = () => path.join(home, 'public');
function newInvite({ withPublic = false } = {}) {
  const inviteId = newInviteId();
  const { record, publicRecord } = inviteRecordsFor({
    inviteId, handle: 'hunter', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: null, alsoAsk: false,
    expiresAt: new Date(NOW + 24 * 3600e3), createdAt: ISSUED, store: { id: 's', cid: 'bafkrei' + 'a'.repeat(52), deleteToken: 'T' },
    publicDir: withPublic ? publicDir() : undefined,
  });
  writeSecure(recordPath(inviteId), storedRecord(record, 'hash'));
  if (withPublic) writePublicInvite(publicDir(), publicRecord);
  return inviteId;
}
const helloBody = (inviteId) => ({
  v: 1, inviteId,
  artifactB: { type: 'courier-pair', v: 0, step: 'B', from: { owner: HUNTER_OWNER, courier: HUNTER_COURIER }, spaceId: `tinycloud:pkh:eip155:1:0x${'a'.repeat(40)}:agents`, peer: 'sam', callMe: 'hunter', delegation: 'DELEGATION-B', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED },
  claimedLabel: 'Hunter', sentAt: ISSUED, credential: 'C', possession: 'P',
});

/** The daemon's acceptB times out: the invite is held again and the call is still running (it answers late through releases[1]). */
async function daemonTimesOut(opts = {}) {
  const inviteId = newInvite(opts);
  await kv.put(`${inviteFolder(inviteId)}in/hello.json`, helloBody(inviteId));
  await watcher().onHello(inviteId);
  return inviteId;
}
const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;
const peerRecordKeys = () => [...kv.rows.keys()].filter((k) => k.includes('me/peers/hunter'));
const profileBytes = () => fs.readFileSync(path.join(home, 'profile.json'), 'utf8');
const recordBytes = (id) => fs.readFileSync(recordPath(id), 'utf8');
const approve = (w, id) => w.approveHeld(id, HUNTER_OWNER);

// ---- H-A
test('H-A (1) acceptB times out, the owner denies, the late answer arrives: the peer is NOT paired, nothing is written, the invite stays denied', async () => {
  delegateScript = ['hang'];
  const id = await daemonTimesOut();
  assert.equal(readRecord(id).status, 'held');
  assert.equal(readRecord(id).held.reason, 'node-timeout');
  assert.equal(loadProfile().peers.hunter.status, 'pending-A');
  await watcher().deny(id);
  assert.equal(readRecord(id).status, 'denied');
  assert.equal(loadProfile().peers.hunter, undefined);
  const profileBefore = profileBytes();
  const recordBefore = recordBytes(id);
  releases[1]();
  await settle();
  assert.equal(profileBytes(), profileBefore, 'profile.json is byte-identical');
  assert.equal(recordBytes(id), recordBefore, 'the invite record is byte-identical');
  assert.equal(loadProfile().peers.hunter, undefined);
  assert.deepEqual(peerRecordKeys(), [], 'no peer record was published for a pairing that was abandoned');
  assert.ok(logs.some((l) => l.event === 'node-call-late' && l.step === 'acceptB' && l.outcome === 'failed' && l.reason === 'node-timeout'));
});

test('H-A (2) acceptB times out, the owner approves again, an unrelated peer is saved, the late answer arrives: profile.json is not overwritten, no peer is lost', async () => {
  delegateScript = ['hang'];
  const id = await daemonTimesOut();
  const cli = loadProfile();
  await approve(watcher({ profile: () => cli }), id);
  const welcome = welcomeOf(id);
  assert.equal(JSON.parse(JSON.stringify(welcome)).artifactC.delegation !== undefined, true);
  const other = loadProfile();
  other.peers.zoe = { handle: 'zoe', status: 'paired', outbound: [], ownerDid: 'x', courierDid: 'y', spaceId: 'z', theirHandleForMe: 'zoe', pairedAt: ISSUED };
  saveProfile(other);
  const before = profileBytes();
  releases[1]();
  await settle();
  assert.equal(profileBytes(), before, 'the abandoned call saved nothing');
  const after = loadProfile();
  assert.equal(after.peers.zoe.status, 'paired', 'zoe is not lost');
  assert.deepEqual(after.peers.hunter.outbound.map((o) => o.cid), ['out-2'], 'only the grant that was delivered is listed');
  assert.equal(readRecord(id).status, 'completed');
});

test('H-A (3) a late answer leaves profile.json and the invite record byte-identical and the grant file gets the real cid', async () => {
  delegateScript = ['hang'];
  const id = await daemonTimesOut();
  const before = { profile: profileBytes(), record: recordBytes(id) };
  assert.equal(listGrants(id)[0].cid, 'unknown');
  releases[1]();
  await settle();
  assert.equal(profileBytes(), before.profile);
  assert.equal(recordBytes(id), before.record);
  const grant = listGrants(id)[0];
  assert.equal(grant.cid, 'out-1');
  assert.equal(grant.notAfter, new Date(NOW + 7 * DAY).toISOString());
  assert.equal(grant.late, 'failed');
  assert.ok(grant.lateAt);
});

test('acceptB stops without a trace when its signal is aborted: after validation, after the grant, and before profile.json is saved', async () => {
  for (const abortAt of ['validation', 'grant', 'peer-record']) {
    const profile = loadProfile();
    const before = profileBytes();
    const controller = new AbortController();
    const abortingNode = {
      kv: { ...kv, put: async (key, ...rest) => { const r = await kv.put(key, ...rest); if (abortAt === 'peer-record') controller.abort(); return r; } },
      delegateTo: async () => { const d = await node.delegateTo(); if (abortAt === 'grant') controller.abort(); return d; },
    };
    const validate = async (...args) => { const r = await stubValidate(...args); if (abortAt === 'validation') controller.abort(); return r; };
    let outgoing;
    await assert.rejects(
      acceptB(profile, abortingNode, helloBody('x'.repeat(26)).artifactB, 'hunter', { signal: controller.signal, validatePeerDelegation: validate, onOutgoing: (g) => { outgoing = g; } }),
      (e) => e.code === 'node-timeout',
      abortAt,
    );
    assert.equal(profileBytes(), before, `profile.json untouched (${abortAt})`);
    assert.equal(profile.peers.hunter.status, 'pending-A', `the in-memory peer is restored (${abortAt})`);
    assert.equal(outgoing !== undefined, abortAt !== 'validation', 'the caller is told about a grant that was issued');
    kv.rows.clear();
    delegations = 0;
  }
});

// ---- M-A
test('M-A the sweep re-reads each record: a record listed while held, completed meanwhile, is not flipped to expired by an old view', async () => {
  delegateScript = [];
  const id = await daemonHeldForOwner();
  const listed = readRecord(id);
  assert.equal(listed.status, 'held');
  await approve(watcher(), id);
  assert.equal(readRecord(id).status, 'completed');
  assert.ok(welcomeOf(id));
  const later = watcher({ now: () => new Date(NOW + 25 * 3600e3) });
  await later.sweepOne(listed);
  assert.equal(readRecord(id).status, 'completed');
  assert.ok(readRecord(id).completedPeer, 'completedPeer is not lost');
  assert.notEqual(readRecord(id).status, 'expired');
  assert.equal(loadProfile().peers.hunter.status, 'paired');
});

test('M-A close() on a stale record is refused with invite-lock-lost (revoke, expiry) and changes nothing', async () => {
  const id = await daemonHeldForOwner();
  const stale = readRecord(id);
  await approve(watcher(), id);
  const before = recordBytes(id);
  await assert.rejects(watcher().revoke(stale), (e) => e.code === 'invite-lock-lost');
  assert.equal(recordBytes(id), before);
  assert.ok(welcomeOf(id));
});

// ---- M-B
test('M-B a Welcome that is already out is found before any grant is minted', async () => {
  const id = await daemonHeldForOwner();
  await kv.put(`${inviteFolder(id)}out/welcome.json`, { v: 1, inviteId: id, tier: 'rejected', sentAt: ISSUED });
  const before = delegations;
  await assert.rejects(approve(watcher(), id), (e) => e.code === 'welcome-exists');
  assert.equal(delegations, before, 'no grant was minted');
  assert.equal(loadProfile().peers.hunter.status, 'pending-A');
  assert.deepEqual(loadProfile().peers.hunter.outbound, []);
  assert.equal(readRecord(id).status, 'held');
});

/** An invite held for a hello that expected a different owner, with a quick (not hanging) node. */
async function daemonHeldForOwner() {
  const inviteId = newInvite({ withPublic: true });
  const { record } = inviteRecordsFor({ inviteId, handle: 'hunter', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: `did:pkh:eip155:1:0x${'c'.repeat(40)}`, alsoAsk: false, expiresAt: new Date(NOW + 24 * 3600e3), createdAt: ISSUED, store: { id: 's', cid: 'bafkrei' + 'a'.repeat(52), deleteToken: 'T' } });
  writeSecure(recordPath(inviteId), storedRecord(record, 'hash'));
  await kv.put(`${inviteFolder(inviteId)}in/hello.json`, helloBody(inviteId));
  await watcher().onHello(inviteId);
  assert.equal(readRecord(inviteId).status, 'held');
  return inviteId;
}

// ---- orphaned grant record
test('grant record (1) validation hangs: no grant was requested, so no grant file; held with node-timeout', async () => {
  validateHangs = true;
  const id = await daemonTimesOut();
  assert.equal(readRecord(id).status, 'held');
  assert.equal(readRecord(id).held.reason, 'node-timeout');
  assert.deepEqual(listGrants(id), []);
  assert.equal(delegations, 0);
});

test('grant record (2) delegateTo hangs: a private file says a grant may exist (cid unknown, at most 7 days), and the owner is told in every place', async () => {
  delegateScript = ['hang'];
  const id = await daemonTimesOut({ withPublic: true });
  const [grant] = listGrants(id);
  assert.equal(grant.cid, 'unknown');
  assert.equal(grant.peerCourierDid, HUNTER_COURIER);
  assert.equal(grant.peerOwnerDid, HUNTER_OWNER);
  assert.equal(grant.space, SPACE);
  assert.equal(grant.handle, 'hunter');
  assert.equal(grant.attempt, readRecord(id).consumedBy);
  assert.ok(Date.parse(grant.notAfter) <= Date.parse(grant.timedOutAt) + 7 * DAY && Date.parse(grant.notAfter) > Date.parse(grant.timedOutAt) + 6 * DAY);
  const file = grantPath(id, grant.attempt);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(secureSubdir('invites')).filter((n) => /^[a-z2-7]{26}\.json$/.test(n)).length, 1, 'the grant file is not an invite record');
  // held facts
  const text = heldFactsText(describeHeld(id));
  assert.match(text, /An earlier pairing attempt timed out at \S+ after asking the node for a read grant to courier did:key:z6MkHunterCourier\. That grant may exist until \S+ \(cid unknown\)\. It was not sent to the invitee and is not revoked automatically yet\./);
  // invite list
  const listed = spawnSync(process.execPath, [CLI, 'invite', 'list'], { env: { ...process.env, COURIER_HOME: home, HOME: home }, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout)[0].possibleGrants, [{ cid: 'unknown', peerCourierDid: HUNTER_COURIER, notAfter: grant.notAfter }]);
  // approve failure text (the second attempt times out too)
  delegateScript = ['hang', 'hang'];
  await assert.rejects(approve(watcher(), id), (e) => e.code === 'node-timeout' && /Pairing timed out \(node-timeout\); the invite is held again\. A read grant to courier did:key:z6MkHunterCourier may exist until \S+; see courier invite list\./.test(e.message));
  // notice
  const held = notices.filter((n) => n.kind === 'invite-held').at(-1);
  assert.equal(held.invite.possibleGrantUntil !== undefined, true);
  assert.match(noticeText(held, '').body, /A read grant from an earlier attempt may exist until \S+\. No agent was woken\./);
  // public copy: only the allowed keys, nothing about a grant
  const pub = JSON.parse(fs.readFileSync(path.join(publicDir(), `${id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(pub), ['v', 'inviteId', 'handle', 'expectEmail', 'expectOwner', 'tier', 'createdAt', 'expiresAt', 'status', 'completedPeer', 'heldReason', 'helloOwner']);
  assert.equal(pub.heldReason, 'node-timeout');
  assert.doesNotMatch(JSON.stringify(pub), /unknown|out-1|grant|attempt|did:key/);
  // the invite record does not carry it either
  assert.doesNotMatch(recordBytes(id), /possible|grant|out-1/);
});

test('grant record: after approve or deny the owner is reminded of an earlier possible grant', async () => {
  delegateScript = ['hang'];
  const id = await daemonTimesOut();
  const [grant] = listGrants(id);
  const note = `Note: an earlier attempt may have left read grant unknown to ${HUNTER_COURIER} until ${grant.notAfter}.`;
  assert.ok(approveSummary(id, 'strict', listGrants(id)).split('\n').includes(note));
  assert.equal(approveSummary(id, 'strict'), `Invite ${id} paired. Requested tier: strict. The peer starts as strict until you confirm trusted status.`);
  await approve(watcher(), id); // the second attempt answers at once
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(listGrants(id).length, 1, 'finishing the invite does not delete the record of the abandoned attempt');
});

test('grant record: a failure AFTER the grant was issued records the known cid even without a timeout', async () => {
  const id = newInvite();
  await kv.put(`${inviteFolder(id)}in/hello.json`, helloBody(id));
  const loaded = loadProfile();
  const file = path.join(home, 'profile.json');
  fs.rmSync(file);
  fs.mkdirSync(file); // saveProfile can no longer replace profile.json: the commit point of acceptB fails after the grant was issued
  await watcher({ profile: () => loaded }).onHello(id);
  assert.equal(readRecord(id).status, 'held');
  assert.equal(readRecord(id).held.reason, 'internal-error');
  const [grant] = listGrants(id);
  assert.equal(grant.cid, 'out-1');
  assert.equal(grant.notAfter, new Date(NOW + 7 * DAY).toISOString());
  fs.rmdirSync(file);
});

test('grant record: a grant that artifact C carries is not recorded as possible', async () => {
  const id = await daemonHeldForOwner();
  await approve(watcher(), id);
  assert.deepEqual(listGrants(id), []);
});

test('grant record (5) the sweep keeps the record until notAfter has passed and then deletes it, and only it', async () => {
  delegateScript = ['hang'];
  const id = await daemonTimesOut();
  const [grant] = listGrants(id);
  await watcher().sweep();
  assert.equal(listGrants(id).length, 1);
  await watcher({ now: () => new Date(Date.parse(grant.notAfter) - 1000) }).sweep();
  assert.equal(listGrants(id).length, 1, 'kept until notAfter');
  await watcher({ now: () => new Date(Date.parse(grant.notAfter) + 1000) }).sweep();
  assert.equal(listGrants(id).length, 0, 'deleted after notAfter');
});

test('grant record: a late answer for another attempt or a changed marker updates nothing', async () => {
  delegateScript = ['hang'];
  const id = await daemonTimesOut();
  const [grant] = listGrants(id);
  const file = grantPath(id, grant.attempt);
  const other = path.join(path.dirname(file), `${id}.grant-${'0'.repeat(32)}.json`);
  fs.copyFileSync(file, other);
  fs.writeFileSync(other, fs.readFileSync(other, 'utf8').replace(grant.attempt, '0'.repeat(32)));
  assert.equal(listGrants(id).length, 2);
  releases[1]();
  await settle();
  const byAttempt = Object.fromEntries(listGrants(id).map((g) => [g.attempt, g.cid]));
  assert.equal(byAttempt[grant.attempt], 'out-1');
  assert.equal(byAttempt['0'.repeat(32)], 'unknown', 'the other attempt\'s file is untouched');
});

// ---- close() and the Welcome pre-check: the later checks matter when something changes DURING the awaits
const lockFile = (id) => path.join(secureSubdir('invites'), `${id}.lock`);

test('M-A close(): an invite that completes while close() is deleting remote state is not overwritten with expired', async () => {
  const id = await daemonHeldForOwner();
  const stale = readRecord(id);
  const flipping = new InviteWatcher({
    node, profile: () => loadProfile(), log: (e) => logs.push(e), now: () => new Date(clock), timing, accept: realAccept, peersFiles: [],
    deleteSealed: async () => { await approve(watcher(), id); },
  });
  await assert.rejects(flipping.revoke(stale), (e) => e.code === 'invite-lock-lost');
  assert.equal(readRecord(id).status, 'completed');
  assert.ok(readRecord(id).completedPeer);
});

test('M-A heldRecord: an expired held invite whose lock is lost while it is being closed is not written as expired', async () => {
  const id = await daemonHeldForOwner();
  clock = NOW + 25 * 3600e3;
  const stealing = new InviteWatcher({
    node, profile: () => loadProfile(), log: (e) => logs.push(e), now: () => new Date(clock), timing, accept: realAccept, peersFiles: [],
    deleteSealed: async () => { fs.writeFileSync(lockFile(id), 'thief-token'); },
  });
  await assert.rejects(approve(stealing, id), (e) => e.code === 'invite-lock-lost');
  assert.equal(readRecord(id).status, 'held', 'not closed by a holder that no longer has the lock');
  assert.equal(fs.readFileSync(lockFile(id), 'utf8'), 'thief-token');
});

test('M-B the lock is re-checked after the Welcome lookup: a holder that lost it mints no grant', async () => {
  const id = await daemonHeldForOwner();
  const stealing = { ...kv, get: async (key, ...rest) => {
    if (key.endsWith('out/welcome.json')) fs.writeFileSync(lockFile(id), 'thief-token');
    return kv.get(key, ...rest);
  } };
  const before = delegations;
  const w = new InviteWatcher({
    node: { kv: stealing, delegateTo: node.delegateTo }, profile: () => loadProfile(), log: (e) => logs.push(e), now: () => new Date(clock), timing, accept: realAccept, peersFiles: [],
    deleteSealed: async () => undefined,
  });
  await assert.rejects(approve(w, id), (e) => e.code === 'invite-lock-lost');
  assert.equal(delegations, before);
});
