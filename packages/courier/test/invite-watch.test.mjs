import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InviteWatcher, loadSeenCredentials, readHeld, readRecord, recordPath, requestedTier } from '../dist/invite-watch.js';
import { inviteFolder } from '../dist/invite-schema.js';
import { writePublicInvite } from '../dist/invite-public.js';
import { writeSecure, secureSubdir } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const TTL_MS = 24 * 3600e3;
const ISSUED = '2026-10-21T00:00:00.000Z';
const LATER = '2026-10-22T00:00:00.000Z';
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';
const EMAIL = 'hunter@example.test';
const CRED = 'cred-1';
const DELETE_TOKEN = 'DELETE-TOKEN-FIXTURE';
const idOf = (n) => 'a'.repeat(25) + 'abcdefghijklmnopqrstuvwxyz'[n];
const ID = idOf(0);
const ID2 = idOf(1);
const ID3 = idOf(2);
const ID4 = idOf(3);
const C_ARTIFACT = { type: 'courier-pair', v: 0, step: 'C', from: { owner: SAM_OWNER, courier: SAM_COURIER }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'hunter', callMe: 'sam', issuedAt: ISSUED };

const okVerify = async (input) => ({ ok: true, address: EMAIL, credentialId: CRED, issuedAt: ISSUED, _input: input });
const okAccept = async () => C_ARTIFACT;

let home;
let sentinel;
let savedEnv;
let kv;
let profile;
let logs;
let notices;
let deletes;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-watch-home-'));
  sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-watch-sentinel-'));
  savedEnv = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, PUBLIC: process.env.COURIER_INVITES_PUBLIC_DIR };
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  delete process.env.COURIER_INVITES_PUBLIC_DIR;
  kv = memoryKv();
  profile = { version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} };
  logs = [];
  notices = [];
  deletes = [];
});

afterEach(() => {
  for (const [key, envName] of [['COURIER_HOME', 'COURIER_HOME'], ['HOME', 'HOME'], ['PUBLIC', 'COURIER_INVITES_PUBLIC_DIR']]) {
    if (savedEnv[key] === undefined) delete process.env[envName];
    else process.env[envName] = savedEnv[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sentinel, { recursive: true, force: true });
});

function watcher(over = {}) {
  return new InviteWatcher({
    node: { kv },
    profile: () => profile,
    log: (entry) => logs.push(entry),
    notify: async (notice) => {
      notices.push(notice);
    },
    now: () => new Date(NOW),
    verify: okVerify,
    accept: okAccept,
    deleteSealed: async (_origin, id, token) => {
      deletes.push({ id, token });
    },
    ...over,
  });
}

function invite(id, over = {}) {
  const record = {
    v: 1,
    inviteId: id,
    handle: 'hunter',
    callMe: 'sam',
    email: EMAIL,
    tier: 'strict',
    alsoAsk: false,
    expiresAt: new Date(NOW + TTL_MS).toISOString(),
    store: { id: 'store-1', cid: 'bafkrei' + 'a'.repeat(52), deleteToken: DELETE_TOKEN },
    oneTimeKeyHash: 'hash-of-one-time-key',
    status: 'open',
    ...over,
  };
  writeSecure(recordPath(id), record);
  return record;
}

function helloBody(id, over = {}) {
  return {
    v: 1,
    inviteId: id,
    artifactB: {
      type: 'courier-pair', v: 0, step: 'B',
      from: { owner: HUNTER_OWNER, courier: HUNTER_COURIER },
      spaceId: `tinycloud:pkh:eip155:1:${HUNTER_ADDR}:agents`,
      peer: 'sam', callMe: 'hunter', delegation: 'DELEGATION-B', delegationExpiresAt: LATER, issuedAt: ISSUED,
    },
    claimedLabel: 'Hunter Agent',
    sentAt: ISSUED,
    credential: 'CREDENTIAL-FIXTURE',
    possession: 'POSSESSION-FIXTURE',
    ...over,
  };
}

async function putHello(id, over = {}) {
  await kv.put(`${inviteFolder(id)}in/hello.json`, helloBody(id, over));
}

const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;
const outKeys = (id) => [...kv.rows.keys()].filter((k) => k.startsWith(`${inviteFolder(id)}out/`));
const inKeys = (id) => [...kv.rows.keys()].filter((k) => k.startsWith(`${inviteFolder(id)}in/`));

function treeOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const publicFile = (dir, id) => path.join(dir, `${id}.json`);
const readPublic = (dir, id) => JSON.parse(fs.readFileSync(publicFile(dir, id), 'utf8'));

function seedPublic(dir, id) {
  writePublicInvite(dir, {
    v: 1, inviteId: id, handle: 'hunter', expectEmail: EMAIL, expectOwner: null, tier: 'strict',
    createdAt: ISSUED, expiresAt: new Date(NOW + TTL_MS).toISOString(), status: 'open', completedPeer: null,
  });
}

test('valid hello pairs, writes one strict Welcome, and notifies invite-completed', async () => {
  invite(ID);
  await putHello(ID);
  let verifyInput;
  await watcher({ verify: async (input) => { verifyInput = input; return okVerify(input); } }).onHello(ID);

  const record = readRecord(ID);
  assert.equal(record.status, 'completed');
  assert.equal(welcomeOf(ID).tier, 'strict');
  assert.equal(welcomeOf(ID).artifactC.step, 'C');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'invite-completed');
  assert.deepEqual(notices[0].invite, { id: ID, handle: 'hunter', label: 'Hunter Agent', owner: HUNTER_OWNER, courierDid: HUNTER_COURIER, reason: '', tier: 'strict' });
  assert.deepEqual(deletes, [{ id: 'store-1', token: DELETE_TOKEN }]);
  assert.deepEqual(inKeys(ID), []);
  assert.deepEqual([...loadSeenCredentials()], [`${CRED}:${ID}`]);
  assert.equal(verifyInput.expectEmail, EMAIL);
  assert.equal(verifyInput.inviteId, ID);
  assert.equal(verifyInput.oneTimeKeyHash, 'hash-of-one-time-key');
  assert.equal(verifyInput.now, NOW);
});

function countPuts(key) {
  const real = kv.put;
  const counter = { n: 0 };
  kv.put = async (k, v, o) => {
    const r = await real(k, v, o);
    if (k === key && r.ok) counter.n += 1;
    return r;
  };
  return counter;
}

function failPutOnce(key) {
  const real = kv.put;
  let armed = true;
  kv.put = async (k, v, o) => {
    if (armed && k === key) {
      armed = false;
      throw new Error(`injected put failure: ${k}`);
    }
    return real(k, v, o);
  };
}

function assertHeldOnce(reason) {
  assert.equal(readRecord(ID).status, 'held');
  assert.equal(readRecord(ID).held.reason, reason);
  assert.deepEqual(notices.map((n) => [n.kind, n.invite.reason]), [['invite-held', reason]]);
}

test('acceptB throws after consumed: held with internal-error, one notice, approve completes once', async () => {
  invite(ID);
  await putHello(ID);
  let calls = 0;
  let statusInAccept;
  const w = watcher({
    accept: async () => {
      calls += 1;
      statusInAccept = readRecord(ID).status;
      if (calls === 1) throw new Error('accept crashed');
      return C_ARTIFACT;
    },
  });
  await w.onHello(ID);
  assert.equal(statusInAccept, 'consumed');
  assertHeldOnce('internal-error');
  assert.equal(welcomeOf(ID), undefined);
  assert.deepEqual(inKeys(ID), []);
  assert.ok(logs.some((e) => e.event === 'invite-error' && e.inviteId === ID));

  await w.approveHeld(ID, HUNTER_OWNER);
  assert.equal(calls, 2);
  assert.equal(readRecord(ID).status, 'completed');
  assert.equal(welcomeOf(ID).artifactC.step, 'C');
  assert.deepEqual(notices.map((n) => n.kind), ['invite-held', 'invite-completed']);
});

test('fault after acceptB, before the Welcome write: held, approve reuses artifact C and writes one Welcome', async () => {
  invite(ID);
  await putHello(ID);
  let accepts = 0;
  let armed = true;
  const welcomePuts = countPuts(`${inviteFolder(ID)}out/welcome.json`);
  const w = watcher({
    accept: async () => {
      accepts += 1;
      return C_ARTIFACT;
    },
    fault: (step) => {
      if (step === 'before-welcome' && armed) {
        armed = false;
        throw new Error('crash before welcome');
      }
    },
  });
  await w.onHello(ID);
  assertHeldOnce('internal-error');
  assert.equal(welcomeOf(ID), undefined);
  assert.equal(accepts, 1);

  await w.approveHeld(ID, HUNTER_OWNER);
  assert.equal(accepts, 1);
  assert.equal(welcomePuts.n, 1);
  assert.equal(readRecord(ID).status, 'completed');
  assert.deepEqual(notices.map((n) => n.kind), ['invite-held', 'invite-completed']);
});

test('Welcome put fails once: held with internal-error, approve writes exactly one Welcome', async () => {
  invite(ID);
  await putHello(ID);
  failPutOnce(`${inviteFolder(ID)}out/welcome.json`);
  const welcomePuts = countPuts(`${inviteFolder(ID)}out/welcome.json`);
  const w = watcher();
  await w.onHello(ID);
  assertHeldOnce('internal-error');
  assert.equal(welcomeOf(ID), undefined);

  await w.approveHeld(ID, HUNTER_OWNER);
  assert.equal(welcomePuts.n, 1);
  assert.equal(welcomeOf(ID).artifactC.step, 'C');
  assert.equal(readRecord(ID).status, 'completed');
  assert.deepEqual(notices.map((n) => n.kind), ['invite-held', 'invite-completed']);
});

test('public update fails during completion: pairing completes; the next sweep repairs the public copy', async () => {
  const dir = path.join(home, 'public');
  fs.mkdirSync(dir);
  invite(ID, { publicDir: dir });
  seedPublic(dir, ID);
  await putHello(ID);
  fs.rmSync(publicFile(dir, ID));
  fs.mkdirSync(publicFile(dir, ID));
  const w = watcher();
  await w.onHello(ID);
  assert.equal(readRecord(ID).status, 'completed');
  assert.equal(welcomeOf(ID).artifactC.step, 'C');
  assert.deepEqual(notices.map((n) => n.kind), ['invite-completed']);
  assert.ok(logs.some((e) => e.event === 'public-write-failed' && e.inviteId === ID));

  fs.rmdirSync(publicFile(dir, ID));
  seedPublic(dir, ID);
  assert.equal(readPublic(dir, ID).status, 'open');
  await w.sweep();
  assert.equal(readPublic(dir, ID).status, 'completed');
  assert.ok(readPublic(dir, ID).completedPeer);
  assert.deepEqual(notices.map((n) => n.kind), ['invite-completed']);
});

test('deny after completion is refused with invite-not-held; a stale public copy does not hold the invite', async () => {
  const dir = path.join(home, 'public');
  fs.mkdirSync(dir);
  invite(ID, { publicDir: dir });
  seedPublic(dir, ID);
  await putHello(ID);
  fs.rmSync(publicFile(dir, ID));
  fs.mkdirSync(publicFile(dir, ID));
  const w = watcher();
  await w.onHello(ID);
  assert.equal(readRecord(ID).status, 'completed');
  assert.ok(welcomeOf(ID));

  await assert.rejects(w.deny(ID), { code: 'invite-not-held' });
  assert.equal(readRecord(ID).status, 'completed');
  assert.equal(welcomeOf(ID).tier, 'strict');
});

test('expectOwner set and hello owner differs: held owner-mismatch, no pairing, no Welcome', async () => {
  invite(ID, { expectOwner: SAM_OWNER });
  await putHello(ID);
  let accepts = 0;
  await watcher({ accept: async () => {
    accepts += 1;
    return C_ARTIFACT;
  } }).onHello(ID);
  assertHeldOnce('owner-mismatch');
  assert.equal(accepts, 0);
  assert.equal(welcomeOf(ID), undefined);
});

test('a verified credential is recorded even when pairing then fails', async () => {
  invite(ID);
  await putHello(ID);
  await watcher({ accept: async () => { throw new Error('accept crashed'); } }).onHello(ID);
  assertHeldOnce('internal-error');
  assert.ok(loadSeenCredentials().has(`${CRED}:${ID}`));
});

test('a public copy that cannot be written is logged and does not block the hold', async () => {
  const dir = path.join(home, 'public');
  fs.mkdirSync(dir);
  invite(ID, { publicDir: dir });
  seedPublic(dir, ID);
  await putHello(ID);
  fs.rmSync(publicFile(dir, ID));
  fs.mkdirSync(publicFile(dir, ID));
  await watcher({ accept: async () => { throw new Error('accept crashed'); } }).onHello(ID);
  assertHeldOnce('internal-error');
  assert.ok(logs.some((e) => e.event === 'public-write-failed' && e.inviteId === ID));
});

test('a second hello for a completed invite is ignored and deleted', async () => {
  invite(ID);
  await putHello(ID);
  let calls = 0;
  const w = watcher({ accept: async () => { calls += 1; return C_ARTIFACT; } });
  await w.onHello(ID);
  await putHello(ID);
  await w.onHello(ID);
  assert.equal(calls, 1);
  assert.equal(notices.length, 1);
  assert.deepEqual(inKeys(ID), []);
});

test('every key under in/ is removed; only hello.json is read', async () => {
  invite(ID);
  await putHello(ID, { credential: undefined, possession: undefined });
  await kv.put(`${inviteFolder(ID)}in/extra.json`, { junk: true });
  await watcher().onHello(ID);
  assert.deepEqual(inKeys(ID), []);
});

test('unparseable hello is deleted with a reason code and the invite stays open', async () => {
  invite(ID);
  await kv.put(`${inviteFolder(ID)}in/hello.json`, { v: 1 });
  await watcher().onHello(ID);
  assert.equal(readRecord(ID).status, 'open');
  assert.deepEqual(inKeys(ID), []);
  assert.ok(logs.some((e) => e.event === 'invite-bad-hello' && typeof e.reason === 'string' && /^[a-z-]+$/.test(e.reason)));
  assert.equal(notices.length, 0);
});

test('a hello with no credential is held: one notice, nothing in out/, held hello stored', async () => {
  invite(ID);
  await putHello(ID, { credential: undefined, possession: undefined });
  let verifyCalls = 0;
  await watcher({ verify: async (i) => { verifyCalls += 1; return okVerify(i); } }).onHello(ID);
  const record = readRecord(ID);
  assert.equal(record.status, 'held');
  assert.equal(record.held.reason, 'no-credential');
  assert.equal(verifyCalls, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'invite-held');
  assert.equal(notices[0].invite.reason, 'no-credential');
  assert.deepEqual(outKeys(ID), []);
  assert.equal(readHeld(ID).inviteId, ID);
});

test('each verifier failure reason holds the invite', async () => {
  const reasons = ['bad-format', 'issuer-not-pinned', 'descriptor-mismatch', 'from-the-future', 'expired', 'too-old', 'address-mismatch', 'bad-signature', 'holder-mismatch', 'bad-possession', 'replayed'];
  for (const [n, reason] of reasons.entries()) {
    const id = idOf(10 + n);
    invite(id);
    await putHello(id);
    await watcher({ verify: async () => ({ ok: false, reason }) }).onHello(id);
    assert.equal(readRecord(id).status, 'held', reason);
    assert.equal(readRecord(id).held.reason, reason);
    assert.deepEqual(outKeys(id), []);
  }
  assert.equal(notices.filter((n) => n.kind === 'invite-held').length, reasons.length);
  assert.equal(notices.filter((n) => n.kind === 'invite-completed').length, 0);
});

test('verified address that differs from the invited email is held', async () => {
  invite(ID);
  await putHello(ID);
  await watcher({ verify: async () => ({ ok: true, address: 'other@example.test', credentialId: CRED, issuedAt: ISSUED }) }).onHello(ID);
  assert.equal(readRecord(ID).held.reason, 'address-mismatch');
  assert.deepEqual(outKeys(ID), []);
});

test('owner mismatch is held; matching owner completes', async () => {
  invite(ID, { expectOwner: `did:pkh:eip155:1:0x${'1'.repeat(40)}` });
  await putHello(ID);
  await watcher().onHello(ID);
  assert.equal(readRecord(ID).held.reason, 'owner-mismatch');

  invite(ID2, { expectOwner: HUNTER_OWNER });
  await putHello(ID2);
  await watcher().onHello(ID2);
  assert.equal(readRecord(ID2).status, 'completed');
});

test('also-ask holds even a valid, verified hello', async () => {
  invite(ID, { alsoAsk: true });
  await putHello(ID);
  let calls = 0;
  await watcher({ accept: async () => { calls += 1; return C_ARTIFACT; } }).onHello(ID);
  assert.equal(readRecord(ID).held.reason, 'also-ask');
  assert.equal(calls, 0);
  assert.deepEqual(outKeys(ID), []);
});

test('approve pairs a held invite at the requested tier and notifies', async () => {
  invite(ID);
  await putHello(ID);
  const w = watcher({ verify: async () => ({ ok: false, reason: 'bad-signature' }) });
  await w.onHello(ID);
  await w.approveHeld(ID, HUNTER_OWNER);
  assert.equal(readRecord(ID).status, 'completed');
  assert.equal(welcomeOf(ID).tier, 'strict');
  assert.equal(readHeld(ID), undefined);
  assert.deepEqual(notices.map((n) => n.kind), ['invite-held', 'invite-completed']);
});

test('approve --tier trusted pairs, writes trusted-requested, grants nothing, writes nothing new to disk', async () => {
  invite(ID);
  await putHello(ID);
  const w = watcher({ verify: async () => ({ ok: false, reason: 'bad-signature' }) });
  await w.onHello(ID);
  const filesBefore = treeOf(home);
  const peersBefore = JSON.stringify(profile.peers);

  await w.approveHeld(ID, HUNTER_OWNER, requestedTier('trusted'));

  assert.equal(readRecord(ID).status, 'completed');
  assert.equal(welcomeOf(ID).tier, 'trusted-requested');
  const last = notices.at(-1);
  assert.equal(last.kind, 'invite-completed');
  assert.equal(last.invite.tier, 'trusted-requested');
  assert.equal(JSON.stringify(profile.peers), peersBefore);
  assert.deepEqual(treeOf(home), filesBefore.filter((p) => !p.endsWith('.held.json')));
});

test('approve refuses an invite that is not held', async () => {
  invite(ID);
  await assert.rejects(watcher().approveHeld(ID, HUNTER_OWNER), { code: 'invite-not-held' });
});

test('approve after the held invite expired is refused and the invite expires', async () => {
  invite(ID);
  await putHello(ID);
  await watcher({ verify: async () => ({ ok: false, reason: 'bad-signature' }) }).onHello(ID);
  const later = new Date(NOW + TTL_MS + 1000);
  await assert.rejects(watcher({ now: () => later }).approveHeld(ID, HUNTER_OWNER), { code: 'invite-expired' });
  assert.equal(readRecord(ID).status, 'expired');
});

test('deny writes a rejected Welcome with no artifact, drops the pending peer, and invokes no acceptB', async () => {
  invite(ID);
  await putHello(ID);
  profile.peers.hunter = { status: 'pending-A' };
  const w = watcher({ verify: async () => ({ ok: false, reason: 'bad-signature' }) });
  await w.onHello(ID);
  let calls = 0;
  await watcher({ accept: async () => { calls += 1; return C_ARTIFACT; } }).deny(ID);
  assert.equal(calls, 0);
  assert.equal(readRecord(ID).status, 'denied');
  assert.equal(welcomeOf(ID).tier, 'rejected');
  assert.equal('artifactC' in welcomeOf(ID), false);
  assert.equal(profile.peers.hunter, undefined);
  assert.deepEqual(inKeys(ID), []);
});

test('deny refuses an invite that is not held', async () => {
  invite(ID);
  await assert.rejects(watcher().deny(ID), { code: 'invite-not-held' });
});

test('expired open invite ignores a hello and expires', async () => {
  invite(ID, { expiresAt: new Date(NOW - 1000).toISOString() });
  await putHello(ID);
  let calls = 0;
  await watcher({ accept: async () => { calls += 1; return C_ARTIFACT; } }).onHello(ID);
  assert.equal(readRecord(ID).status, 'expired');
  assert.equal(calls, 0);
  assert.equal(notices.length, 0);
  assert.deepEqual(inKeys(ID), []);
});

test('revoked invite ignores a hello and keeps its revoked status', async () => {
  invite(ID, { status: 'revoked' });
  await putHello(ID);
  let calls = 0;
  await watcher({ accept: async () => { calls += 1; return C_ARTIFACT; } }).onHello(ID);
  assert.equal(readRecord(ID).status, 'revoked');
  assert.equal(calls, 0);
  assert.deepEqual(inKeys(ID), []);
});

test('a handler exception holds the invite, and the next invite still pairs', async () => {
  invite(ID);
  await putHello(ID);
  const broken = watcher({ verify: async () => { throw new Error('verifier exploded'); } });
  await broken.onHello(ID);
  assert.equal(readRecord(ID).status, 'held');
  assert.equal(readRecord(ID).held.reason, 'internal-error');
  assert.equal(welcomeOf(ID), undefined);

  invite(ID2);
  await putHello(ID2);
  await watcher().onHello(ID2);
  assert.equal(readRecord(ID2).status, 'completed');
});

test('seen credentials persist across watcher instances and are passed to the verifier', async () => {
  invite(ID);
  await putHello(ID);
  await watcher().onHello(ID);
  assert.ok(loadSeenCredentials().has(`${CRED}:${ID}`));

  const seenFile = path.join(secureSubdir('invites'), 'seen-credentials.json');
  assert.ok(fs.readFileSync(seenFile, 'utf8').includes(`${CRED}:${ID}`));

  writeSecure(seenFile, { ids: [`${CRED}:${ID2}`] });
  invite(ID2);
  await putHello(ID2);
  await watcher({
    verify: async (input) => (input.seenCredentials.has(`${CRED}:${input.inviteId}`)
      ? { ok: false, reason: 'replayed' }
      : okVerify(input)),
  }).onHello(ID2);
  assert.equal(readRecord(ID2).held.reason, 'replayed');
});

test('public record reaches consumed and completed, with the completed peer', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-watch-pub-'));
  try {
    seedPublic(pub, ID);
    invite(ID, { publicDir: pub });
    await putHello(ID);
    let seenInAccept;
    await watcher({ accept: async () => { seenInAccept = readPublic(pub, ID).status; return C_ARTIFACT; } }).onHello(ID);
    assert.equal(seenInAccept, 'consumed');
    const done = readPublic(pub, ID);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.completedPeer, { handle: 'hunter', courierDid: HUNTER_COURIER, ownerDid: HUNTER_OWNER });
  } finally {
    fs.rmSync(pub, { recursive: true, force: true });
  }
});

test('public record reaches held, denied, expired, and revoked', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-watch-pub-'));
  try {
    seedPublic(pub, ID);
    invite(ID, { publicDir: pub });
    await putHello(ID, { credential: undefined, possession: undefined });
    await watcher().onHello(ID);
    assert.equal(readPublic(pub, ID).status, 'held');
    await watcher().deny(ID);
    assert.equal(readPublic(pub, ID).status, 'denied');

    seedPublic(pub, ID2);
    invite(ID2, { publicDir: pub, expiresAt: new Date(NOW - 1000).toISOString() });
    await watcher().sweep();
    assert.equal(readPublic(pub, ID2).status, 'expired');

    seedPublic(pub, ID3);
    const revoked = invite(ID3, { publicDir: pub });
    await watcher().revoke(revoked);
    assert.equal(readPublic(pub, ID3).status, 'revoked');
  } finally {
    fs.rmSync(pub, { recursive: true, force: true });
  }
});

test('no public directory on the record means no public writes, even with the env set', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-watch-pub-'));
  try {
    process.env.COURIER_INVITES_PUBLIC_DIR = pub;
    invite(ID);
    await putHello(ID);
    await watcher().onHello(ID);
    assert.equal(readRecord(ID).status, 'completed');
    assert.deepEqual(fs.readdirSync(pub), []);
  } finally {
    fs.rmSync(pub, { recursive: true, force: true });
  }
});

test('a failed public write during complete does not change the pairing; the log keeps only the reason code', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-watch-pub-'));
  try {
    invite(ID, { publicDir: pub });
    await putHello(ID);
    await watcher().onHello(ID);
    assert.equal(readRecord(ID).status, 'completed');
    assert.deepEqual(notices.map((n) => n.kind), ['invite-completed']);
    const failure = logs.find((e) => e.event === 'public-write-failed');
    assert.ok(failure, 'failure is logged');
    assert.deepEqual(Object.keys(failure).sort(), ['event', 'inviteId', 'reason']);
    assert.match(failure.reason, /^[A-Za-z0-9_-]{1,40}$/);
  } finally {
    fs.rmSync(pub, { recursive: true, force: true });
  }
});

test('consumed with a valid remote hello: sweep holds it with internal-error, one notice, remote hello removed', async () => {
  invite(ID, { status: 'consumed', consumedAt: new Date(NOW - 11 * 60e3).toISOString() });
  await putHello(ID);
  await watcher().sweep();
  assertHeldOnce('internal-error');
  assert.deepEqual(inKeys(ID), []);
  assert.ok(readHeld(ID));
});

test('consumed with no remote hello: sweep fails the invite with hello-lost, one notice', async () => {
  invite(ID, { status: 'consumed', consumedAt: new Date(NOW - 11 * 60e3).toISOString() });
  await watcher().sweep();
  assert.equal(readRecord(ID).status, 'failed');
  assert.deepEqual(notices.map((n) => [n.kind, n.detail]), [['invite-failed', 'hello-lost']]);
  assert.ok(logs.some((e) => e.event === 'invite-failed' && e.reason === 'hello-lost'));
});

test('consumed with an invalid remote hello: sweep fails the invite with hello-lost', async () => {
  invite(ID, { status: 'consumed', consumedAt: new Date(NOW - 11 * 60e3).toISOString() });
  await kv.put(`${inviteFolder(ID)}in/hello.json`, { v: 1, inviteId: ID, junk: true });
  await watcher().sweep();
  assert.equal(readRecord(ID).status, 'failed');
  assert.deepEqual(notices.map((n) => [n.kind, n.detail]), [['invite-failed', 'hello-lost']]);
});

test('crash between consumed and held: the remote hello survives and the next sweep recovers it once', async () => {
  const heldPath = path.join(secureSubdir('invites'), `${ID}.held.json`);
  invite(ID);
  await putHello(ID);
  fs.mkdirSync(heldPath);
  await watcher({ accept: async () => { throw new Error('accept crashed'); } }).onHello(ID);
  assert.equal(readRecord(ID).status, 'consumed');
  assert.ok(inKeys(ID).length > 0);
  assert.deepEqual(notices, []);
  fs.rmdirSync(heldPath);
  await watcher({ now: () => new Date(NOW + 11 * 60e3) }).sweep();
  assertHeldOnce('internal-error');
  assert.deepEqual(inKeys(ID), []);
});

test('a consumed invite younger than the recovery window is left alone until it ages out', async () => {
  invite(ID, { status: 'consumed', consumedAt: new Date(NOW).toISOString() });
  await putHello(ID);
  await watcher().sweep();
  assert.equal(readRecord(ID).status, 'consumed');
  assert.deepEqual(notices, []);
  assert.ok(inKeys(ID).length > 0);
  await watcher({ now: () => new Date(NOW + 11 * 60e3) }).sweep();
  assertHeldOnce('internal-error');
});

test('sweep repairs a public copy that is stale after completion', async () => {
  const dir = path.join(home, 'public');
  fs.mkdirSync(dir);
  seedPublic(dir, ID);
  invite(ID, { publicDir: dir, status: 'completed', completedPeer: { handle: 'hunter', courierDid: HUNTER_COURIER, ownerDid: HUNTER_OWNER } });
  await watcher().sweep();
  assert.equal(readPublic(dir, ID).status, 'completed');
  assert.ok(readPublic(dir, ID).completedPeer);
  assert.deepEqual(notices, []);
});

test('sweep expires open invites and removes a completed invite Welcome at expiry', async () => {
  invite(ID);
  await putHello(ID);
  await watcher().onHello(ID);
  assert.ok(welcomeOf(ID));
  await watcher({ now: () => new Date(NOW + TTL_MS + 1000) }).sweep();
  assert.equal(welcomeOf(ID), undefined);
  assert.ok(readRecord(ID).cleanedAt);

  invite(ID2);
  await watcher({ now: () => new Date(NOW + TTL_MS + 1000) }).sweep();
  assert.equal(readRecord(ID2).status, 'expired');
});

test('nothing is written outside COURIER_HOME across complete, approve, deny, and expiry', async () => {
  invite(ID);
  await putHello(ID);
  await watcher().onHello(ID);

  invite(ID2);
  await putHello(ID2, { credential: undefined, possession: undefined });
  const held = watcher();
  await held.onHello(ID2);
  await held.approveHeld(ID2, HUNTER_OWNER, requestedTier('trusted'));

  invite(ID3);
  await putHello(ID3, { credential: undefined, possession: undefined });
  await watcher().onHello(ID3);
  await watcher().deny(ID3);

  invite(ID4, { expiresAt: new Date(NOW - 1000).toISOString() });
  await watcher().sweep();

  assert.deepEqual(fs.readdirSync(sentinel), []);
});

test('requestedTier maps the flag to a requested tier and rejects anything else', () => {
  assert.equal(requestedTier('strict'), 'strict');
  assert.equal(requestedTier('trusted'), 'trusted-requested');
  assert.throws(() => requestedTier('admin'), { code: 'usage' });
});
