// A live holder keeps its lock (heartbeat), a holder that lost it stops before it writes, every state-changing write is compare-and-set against the
// consume this holder made, and every node call has a deadline. Short windows come from the `timing` seam; the 60 s deadline is tested with mock timers.
// Isolated: HOME and COURIER_HOME point at fresh /var/tmp dirs for every test.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import { storedLink } from './support/invite-link-fixture.mjs';
import { InviteWatcher, INVITE_BUSY_WAIT, NODE_CALL_TIMEOUT_MS, readHeld, readRecord, writeRecord, recordPath } from '../dist/invite-watch.js';
import { writePublicInvite } from '../dist/invite-public.js';
import { inviteFolder } from '../dist/invite-schema.js';
import { newInviteId } from '../dist/invite-blob.js';
import { secureSubdir, writeSecure } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

const NOW = Date.now();
const ISSUED = new Date(NOW).toISOString();
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = `0x${'a'.repeat(40)}`;
const MALLORY_ADDR = `0x${'B'.repeat(40)}`;
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const EVE_ADDR = `0x${'e'.repeat(40)}`;
const EVE_OWNER = `did:pkh:eip155:1:${EVE_ADDR}`;
const EVE_COURIER = 'did:key:z6MkEveCourier';
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const MALLORY_OWNER = `did:pkh:eip155:1:${MALLORY_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';
const MALLORY_COURIER = 'did:key:z6MkMalloryCourier';
const EMAIL = 'hunter@example.test';
const C_ARTIFACT = { type: 'courier-pair', v: 0, step: 'C', from: { owner: SAM_OWNER, courier: SAM_COURIER }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'hunter', callMe: 'sam', delegation: 'DELEGATION-C', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED };

let home;
let sentinel;
let saved;
let kv;
let accepted;
let clock;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-lock-cas-home-'));
  sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-lock-cas-sentinel-'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  delete process.env.COURIER_PEERS_FILE;
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  kv = memoryKv();
  accepted = [];
  accepts = [];
  logs = [];
  clock = NOW;
  assert.ok([process.env.COURIER_HOME, process.env.HOME].every((p) => path.resolve(p).startsWith(path.resolve(process.env.COURIER_TEST_HOME) + path.sep)));
});

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sentinel, { recursive: true, force: true });
});

const publicDir = () => path.join(home, 'public');
const publicOf = (id) => JSON.parse(fs.readFileSync(path.join(publicDir(), `${id}.json`), 'utf8'));

function invite({ expectOwner = null, withPublic = false, alsoAsk = false } = {}) {
  const inviteId = newInviteId();
  const { record, publicRecord } = inviteRecordsFor({
    inviteId, handle: 'hunter', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner, alsoAsk,
    expiresAt: new Date(NOW + 24 * 3600e3), createdAt: ISSUED,
    link: storedLink('store-1'),
    publicDir: withPublic ? publicDir() : undefined,
  });
  writeSecure(recordPath(inviteId), storedRecord(record, 'hash-of-one-time-key'));
  if (withPublic) writePublicInvite(publicDir(), publicRecord);
  return inviteId;
}

async function helloFrom(inviteId, { owner, courier }) {
  await kv.put(`${inviteFolder(inviteId)}in/hello.json`, {
    v: 1,
    inviteId,
    artifactB: {
      type: 'courier-pair', v: 0, step: 'B',
      from: { owner, courier },
      spaceId: `tinycloud:pkh:eip155:1:${owner.split(':').pop()}:agents`,
      peer: 'sam', callMe: 'hunter', delegation: 'DELEGATION-B', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED,
    },
    claimedLabel: 'Hunter',
    sentAt: ISSUED,
    credential: 'CREDENTIAL-FIXTURE',
    possession: 'POSSESSION-FIXTURE',
  });
}

let accepts;
let logs;
const Cn = (n) => ({ ...C_ARTIFACT, delegation: `DELEGATION-C-${n}` });

/** acceptB blocks until released; every call mints a distinct artifact C, as the real one does. */
function blockingAccept() {
  return () => new Promise((resolve) => {
    const n = accepts.length + 1;
    accepts.push({ n, release: () => resolve(Cn(n)) });
  });
}

function watcher({ timing, accept = blockingAccept(), kv: kvOverride, fault } = {}) {
  return new InviteWatcher({
    node: { kv: kvOverride ?? kv },
    profile: () => ({ version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: (entry) => logs.push(entry),
    notify: async () => undefined,
    now: () => new Date(clock),
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }),
    accept,
    deleteLink: async () => undefined,
    peersFiles: [],
    ...(timing ? { timing } : {}),
    ...(fault ? { fault } : {}),
  });
}

/** A held invite (a squatter's hello held with owner-mismatch). */
async function heldInvite() {
  const id = invite({ expectOwner: HUNTER_OWNER });
  await helloFrom(id, { owner: MALLORY_OWNER, courier: MALLORY_COURIER });
  await watcher({ accept: async () => C_ARTIFACT }).onHello(id);
  assert.equal(readRecord(id).status, 'held');
  return id;
}

const lockFile = (id) => path.join(secureSubdir('invites'), `${id}.lock`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Waits with setImmediate only, so it also works while setTimeout is mocked. */
async function until(condition, what) {
  for (let i = 0; i < 20000; i++) {
    if (condition()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${what}`);
}
// Windows for the lock tests: a holder that beats every 20 ms is never stale at 150 ms; one that cannot beat is.
const LIVE = { staleMs: 150, heartbeatMs: 20 };
const DEAD = { staleMs: 150, heartbeatMs: 0 };
const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;

/** An invite held for Mallory's hello, then left `consumed` as a crashed approve leaves it, with the clock past the recovery wait. */
async function heldThenCrashed() {
  const id = await heldInvite();
  const record = readRecord(id);
  record.status = 'consumed';
  record.consumedAt = new Date(NOW).toISOString();
  writeRecord(record);
  clock = NOW + 11 * 60 * 1000;
  return id;
}

const approve = (w, id) => w.approveHeld(id, MALLORY_OWNER);
const startApprove = async (w, id) => {
  const promise = approve(w, id);
  promise.catch(() => undefined);
  await until(() => accepts.length === 1, 'the holder to reach acceptB');
  return { promise }; // wrapped: awaiting the promise itself would wait for the whole approve
};

// (A) deadlines on node calls
test('(1) a node call that never answers is abandoned after NODE_CALL_TIMEOUT_MS (60 s, fake clock): node-timeout, invite recoverable, lock released by token, never completed', async () => {
  assert.equal(NODE_CALL_TIMEOUT_MS, 60_000);
  const id = await heldInvite();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = approve(watcher(), id);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await until(() => accepts.length === 1, 'acceptB');
    mock.timers.tick(NODE_CALL_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, false, 'not abandoned before the deadline');
    assert.equal(fs.existsSync(lockFile(id)), true);
    mock.timers.tick(1);
    await assert.rejects(pending, (e) => e.code === 'node-timeout');
  } finally {
    mock.timers.reset();
  }
  const record = readRecord(id);
  assert.equal(record.status, 'held', 'the same recoverable state as any other failure: held again');
  assert.equal(record.artifactC, undefined);
  assert.equal(welcomeOf(id), undefined);
  assert.equal(fs.existsSync(lockFile(id)), false, 'lock released');
  assert.ok(logs.some((l) => l.event === 'invite-error' && l.reason === 'node-timeout'));
  // The abandoned call answers later: it is only logged, it changes nothing.
  accepts[0].release();
  await flush();
  assert.ok(logs.some((l) => l.event === 'node-call-late' && l.step === 'acceptB' && l.outcome === 'ok'));
  assert.equal(readRecord(id).status, 'held');
  assert.equal(readRecord(id).artifactC, undefined);
  // And the owner can simply approve again.
  assert.equal(await watcher({ accept: async () => C_ARTIFACT }).approveHeld(id, MALLORY_OWNER), 'strict');
});

test('(1b) a KV call that never answers is bounded too: node-timeout, held again, nothing completed', async () => {
  const id = await heldInvite();
  const hanging = { ...kv, put: async (key, ...rest) => (key.endsWith('out/welcome.json') ? new Promise(() => undefined) : kv.put(key, ...rest)) };
  const w = watcher({ timing: { nodeTimeoutMs: 40 }, accept: async () => C_ARTIFACT, kv: hanging });
  await assert.rejects(approve(w, id), (e) => e.code === 'node-timeout');
  assert.equal(readRecord(id).status, 'held');
  assert.equal(welcomeOf(id), undefined);
  assert.equal(fs.existsSync(lockFile(id)), false);
});

test('a node call that answers in time behaves as before', async () => {
  const id = await heldInvite();
  assert.equal(await watcher({ accept: async () => C_ARTIFACT }).approveHeld(id, MALLORY_OWNER), 'strict');
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(logs.some((l) => l.event === 'node-call-late'), false);
});

// (B) heartbeat and token
test('the lock holds a random token, refreshed by a heartbeat while the holder works, and is gone (and the beat stopped) afterwards', async () => {
  const id = await heldInvite();
  const { promise: a } = await startApprove(watcher({ timing: LIVE }), id);
  const token = fs.readFileSync(lockFile(id), 'utf8');
  assert.match(token, /^[0-9a-f]{32}$/);
  const first = fs.statSync(lockFile(id)).mtimeMs;
  await sleep(120);
  assert.ok(fs.statSync(lockFile(id)).mtimeMs > first, 'mtime refreshed while the holder works');
  assert.equal(fs.readFileSync(lockFile(id), 'utf8'), token);
  accepts[0].release();
  assert.equal(await a, 'strict');
  assert.equal(fs.existsSync(lockFile(id)), false);
  await sleep(80);
  assert.equal(fs.existsSync(lockFile(id)), false, 'no beat after the holder finished');
  const second = await heldInvite();
  accepts.length = 0;
  const { promise: b } = await startApprove(watcher({ timing: LIVE }), second);
  assert.notEqual(fs.readFileSync(lockFile(second), 'utf8'), token, 'a new holder has a new token');
  accepts[0].release();
  await b;
});

test('(S3) a holder alive past the recovery window keeps its lock: recovery skips, a second approve is busy, one acceptB, one Welcome', async () => {
  const id = await heldInvite();
  const { promise: a } = await startApprove(watcher({ timing: LIVE }), id);
  clock = NOW + 11 * 60 * 1000;
  await sleep(400); // far beyond the stale window; the beat keeps the lock fresh
  await watcher({ timing: LIVE }).sweep();
  assert.equal(readRecord(id).status, 'consumed', 'recovery did not re-hold an invite whose holder is alive');
  await assert.rejects(approve(watcher({ timing: LIVE }), id), (e) => e.code === 'invite-busy');
  assert.equal(accepts.length, 1);
  accepts[0].release();
  assert.equal(await a, 'strict');
  assert.equal(readRecord(id).status, 'completed');
  assert.equal(welcomeOf(id).artifactC.delegation, 'DELEGATION-C-1');
  assert.equal(accepts.length, 1);
});

test('a holder that cannot beat (dead) is taken over after the stale window; the late holder then aborts at its next write and removes nothing of the new lock', async () => {
  const id = await heldInvite();
  const { promise: a } = await startApprove(watcher({ timing: DEAD }), id);
  await sleep(250);
  // B takes over the stale lock, finds the invite consumed (A's) and refuses; B releases only its own lock.
  await assert.rejects(approve(watcher({ timing: DEAD }), id), (e) => e.code === 'invite-not-held');
  assert.equal(accepts.length, 1);
  assert.equal(fs.existsSync(lockFile(id)), false);
  accepts[0].release();
  await assert.rejects(a, (e) => e.code === 'invite-lock-lost');
  const record = readRecord(id);
  assert.equal(record.status, 'consumed', 'left for recovery: A wrote nothing more');
  assert.equal(record.artifactC, undefined);
  assert.equal(welcomeOf(id), undefined);
});

test('(S1/S2) a holder whose lock was replaced aborts before writing, and its finally does not delete the other holder\'s lock', async () => {
  const id = await heldInvite();
  const { promise: a } = await startApprove(watcher({ timing: LIVE }), id);
  const heldBefore = logs.filter((l) => l.event === 'invite-held').length;
  fs.writeFileSync(lockFile(id), 'someone-elses-token');
  accepts[0].release();
  await assert.rejects(a, (e) => e.code === 'invite-lock-lost');
  assert.equal(fs.readFileSync(lockFile(id), 'utf8'), 'someone-elses-token', 'token mismatch: the lock is not removed');
  const record = readRecord(id);
  assert.equal(record.status, 'consumed');
  assert.equal(record.artifactC, undefined);
  assert.equal(welcomeOf(id), undefined);
  assert.equal(logs.filter((l) => l.event === 'invite-held').length, heldBefore, 'no hold was attempted either');
});

test('(2) forced steal while A hangs past 10 min: recovery takes the stolen lock and re-holds; A then refuses to write completed, never flips completed to held, one acceptB, no Welcome', async () => {
  const id = await heldInvite();
  const { promise: a } = await startApprove(watcher({ timing: LIVE }), id);
  fs.writeFileSync(lockFile(id), 'thief-token'); // the lock is stolen; the thief does not beat, so it goes stale
  clock = NOW + 11 * 60 * 1000;
  await sleep(250);
  await watcher({ timing: LIVE }).sweep(); // takes the stale lock, sees consumed past the window, re-holds
  assert.equal(readRecord(id).status, 'held');
  accepts[0].release();
  await assert.rejects(a, (e) => e.code === 'invite-lock-lost');
  const record = readRecord(id);
  assert.equal(record.status, 'held', 'A did not write completed, so nothing flipped');
  assert.equal(record.artifactC, undefined, 'A did not persist its artifact C either');
  assert.equal(welcomeOf(id), undefined);
  assert.equal(accepts.length, 1);
});

// (B) compare-and-set
test('(3) two completions racing on one consume: the second is refused by compare-and-set, one Welcome, the record stays completed', async () => {
  const id = await heldInvite();
  const held = readHeld(id);
  const consumed = readRecord(id);
  consumed.status = 'consumed';
  consumed.consumedAt = new Date(NOW).toISOString();
  consumed.consumedBy = 'marker-1';
  writeRecord(consumed);
  const a = watcher();
  const b = watcher();
  const pa = a.complete({ ...readRecord(id) }, held);
  const pb = b.complete({ ...readRecord(id) }, held);
  pa.catch(() => undefined);
  pb.catch(() => undefined);
  await until(() => accepts.length === 2, 'both acceptB calls');
  accepts[0].release();
  assert.equal(await pa, undefined);
  assert.equal(readRecord(id).status, 'completed');
  accepts[1].release();
  await assert.rejects(pb, (e) => e.code === 'invite-lock-lost');
  assert.equal(readRecord(id).status, 'completed', 'never flipped to held');
  assert.equal(readRecord(id).artifactC.delegation, 'DELEGATION-C-1');
  assert.equal(welcomeOf(id).artifactC.delegation, 'DELEGATION-C-1');
});

test('(3b) a holder whose consume was replaced by another consume (different marker) cannot write, although the status is still consumed', async () => {
  const id = await heldInvite();
  const held = readHeld(id);
  const mine = readRecord(id);
  mine.status = 'consumed';
  mine.consumedAt = new Date(NOW).toISOString();
  mine.consumedBy = 'marker-mine';
  writeRecord(mine);
  const w = watcher();
  const p = w.complete({ ...mine }, held);
  p.catch(() => undefined);
  await until(() => accepts.length === 1, 'acceptB');
  const theirs = readRecord(id);
  theirs.consumedBy = 'marker-theirs'; // recovery re-held and another approve consumed again
  writeRecord(theirs);
  accepts[0].release();
  await assert.rejects(p, (e) => e.code === 'invite-lock-lost');
  assert.equal(readRecord(id).consumedBy, 'marker-theirs');
  assert.equal(readRecord(id).status, 'consumed');
  assert.equal(readRecord(id).artifactC, undefined);
  assert.equal(welcomeOf(id), undefined);
});

test('every move to consumed writes its own marker (approve, deny, a new hello)', async () => {
  const id = await heldInvite();
  const firstConsume = readRecord(id).consumedBy; // the hello's own consume, before it was held
  assert.match(firstConsume, /^[0-9a-f]{32}$/);
  let seen;
  await watcher({ accept: async () => { seen = readRecord(id).consumedBy; return C_ARTIFACT; } }).approveHeld(id, MALLORY_OWNER);
  assert.match(seen, /^[0-9a-f]{32}$/);
  assert.notEqual(seen, firstConsume, 'approve consumed again with a marker of its own');
  const denied = await heldInvite();
  const before = readRecord(denied).consumedBy;
  await watcher().deny(denied);
  assert.notEqual(readRecord(denied).consumedBy, before);
  assert.match(readRecord(denied).consumedBy, /^[0-9a-f]{32}$/);
});

test('deny: a lost lock stops it before the Welcome and before the denied write', async () => {
  const id = await heldInvite();
  const slowKv = { ...kv, put: async (key, ...rest) => {
    if (key.endsWith('out/welcome.json')) fs.writeFileSync(lockFile(id), 'thief-token');
    return kv.put(key, ...rest);
  } };
  await assert.rejects(watcher({ kv: slowKv }).deny(id), (e) => e.code === 'invite-lock-lost');
  assert.notEqual(readRecord(id).status, 'denied');
  assert.equal(fs.readFileSync(lockFile(id), 'utf8'), 'thief-token');
});

test('a lock lost while the Welcome is being written stops the holder before the completed write', async () => {
  const id = await heldInvite();
  const stealing = { ...kv, put: async (key, ...rest) => {
    const result = await kv.put(key, ...rest);
    if (key.endsWith('out/welcome.json')) fs.writeFileSync(lockFile(id), 'thief-token');
    return result;
  } };
  await assert.rejects(watcher({ accept: async () => C_ARTIFACT, kv: stealing }).approveHeld(id, MALLORY_OWNER), (e) => e.code === 'invite-lock-lost');
  assert.equal(readRecord(id).status, 'consumed', 'never written as completed');
  assert.equal(fs.readFileSync(lockFile(id), 'utf8'), 'thief-token');
});

test('a lock lost after acceptB, before the Welcome write: no Welcome is written', async () => {
  const id = await heldInvite();
  const w = watcher({ accept: async () => C_ARTIFACT, fault: () => fs.writeFileSync(lockFile(id), 'thief-token') });
  await assert.rejects(w.approveHeld(id, MALLORY_OWNER), (e) => e.code === 'invite-lock-lost');
  assert.equal(welcomeOf(id), undefined);
  assert.equal(readRecord(id).status, 'consumed');
});

test('recovery that loses its lock while re-holding does not write the held state', async () => {
  const id = await heldThenCrashed();
  const stealing = { ...kv, delete: async (key, ...rest) => {
    if (key.endsWith('in/hello.json')) fs.writeFileSync(lockFile(id), 'thief-token');
    return kv.delete(key, ...rest);
  } };
  await watcher({ kv: stealing }).sweep();
  assert.equal(readRecord(id).status, 'consumed', 'not re-held by a recovery that no longer owns the invite');
  assert.ok(logs.some((l) => l.event === 'invite-sweep-error' && l.reason === 'invite-lock-lost'));
  assert.equal(fs.readFileSync(lockFile(id), 'utf8'), 'thief-token');
});

test('every heartbeat timer a holder starts is cleared when it is done', async () => {
  const started = [];
  const cleared = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (...args) => { const t = realSet(...args); started.push(t); return t; };
  globalThis.clearInterval = (t) => { cleared.push(t); return realClear(t); };
  try {
    const id = await heldInvite();
    await watcher({ timing: LIVE, accept: async () => C_ARTIFACT }).approveHeld(id, MALLORY_OWNER);
    await assert.rejects(watcher({ timing: LIVE }).approveHeld(id, MALLORY_OWNER), (e) => e.code === 'invite-not-held');
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  assert.equal(started.length, 2, "one heartbeat per lock taken");
  assert.deepEqual(started.filter((t) => !cleared.includes(t)), []);
});

test('recovery from the remote hello (no held copy) that loses its lock before the hold writes no held file', async () => {
  const id = invite({ expectOwner: HUNTER_OWNER });
  await helloFrom(id, { owner: MALLORY_OWNER, courier: MALLORY_COURIER });
  const consumed = readRecord(id);
  consumed.status = 'consumed';
  consumed.consumedAt = new Date(NOW).toISOString();
  writeRecord(consumed);
  clock = NOW + 11 * 60 * 1000;
  const stealing = { ...kv, get: async (key, ...rest) => {
    if (key.endsWith('in/hello.json')) fs.writeFileSync(lockFile(id), 'thief-token');
    return kv.get(key, ...rest);
  } };
  await watcher({ kv: stealing }).sweep();
  assert.equal(fs.existsSync(path.join(secureSubdir('invites'), `${id}.held.json`)), false);
  assert.equal(readRecord(id).status, 'consumed');
  assert.equal(kv.rows.has(`${inviteFolder(id)}in/hello.json`), true, 'the remote hello was not deleted either');
});

test('every invite-busy message (approve, deny, revoke) ends with the same "Try again in a few minutes." and never promises "a minute"', async () => {
  const id = await heldInvite();
  fs.writeFileSync(lockFile(id), 'someone-elses-token');
  const messages = [];
  for (const run of [() => approve(watcher(), id), () => watcher().deny(id), () => watcher().revoke(readRecord(id))]) {
    await assert.rejects(run(), (e) => { messages.push(e.message); return e.code === 'invite-busy'; });
  }
  assert.equal(INVITE_BUSY_WAIT, 'Try again in a few minutes.');
  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.ok(message.endsWith(` ${INVITE_BUSY_WAIT}`), message);
    assert.doesNotMatch(message, /a minute/);
  }
  assert.match(messages[0], /^Another approve, deny or recovery is working on this invite\. /);
  assert.match(messages[1], /^Another approve, deny or recovery is working on this invite\. /);
  assert.match(messages[2], /^A pairing for this invite is finishing\. /);
  assert.equal(readRecord(id).status, 'held');
  assert.equal(fs.readFileSync(lockFile(id), 'utf8'), 'someone-elses-token');
});
