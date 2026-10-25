// The identity a held invite shows cannot be replaced afterwards: recovery prefers the held copy, approve checks and pairs the held file, and two
// concurrent approvals pair once. Isolated: HOME and COURIER_HOME point at fresh /var/tmp dirs for every test.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import { InviteWatcher, describeHeld, readHeld, readRecord, writeRecord, recordPath } from '../dist/invite-watch.js';
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-held-owner-home-'));
  sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-held-owner-sentinel-'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  delete process.env.COURIER_PEERS_FILE;
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  kv = memoryKv();
  accepted = [];
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
    store: { id: 'store-1', cid: 'bafkrei' + 'a'.repeat(52), deleteToken: 'DELETE-TOKEN-FIXTURE' },
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

function watcher() {
  return new InviteWatcher({
    node: { kv },
    profile: () => ({ version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: () => undefined,
    notify: async () => undefined,
    now: () => new Date(clock),
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'cred-1', issuedAt: ISSUED }),
    accept: async (_profile, _node, artifact) => { accepted.push(artifact.from.courier); return C_ARTIFACT; },
    deleteSealed: async () => undefined,
    peersFiles: [],
  });
}

/** A squatter: the invite expects Hunter's owner, but a different owner's hello arrived first. */
async function squatted(opts = {}) {
  const id = invite({ expectOwner: HUNTER_OWNER, ...opts });
  await helloFrom(id, { owner: MALLORY_OWNER, courier: MALLORY_COURIER });
  await watcher().onHello(id);
  return id;
}

const heldFile = (id) => path.join(secureSubdir('invites'), `${id}.held.json`);
const helloKey = (id) => `${inviteFolder(id)}in/hello.json`;
const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;
const RECOVER_MS = 11 * 60 * 1000;

/** An invite held for Mallory's hello, then left `consumed` as a crashed approve leaves it, with the clock past the recovery wait. */
async function heldThenCrashed(opts = {}) {
  const id = invite({ expectOwner: HUNTER_OWNER, ...opts });
  await helloFrom(id, { owner: MALLORY_OWNER, courier: MALLORY_COURIER });
  await watcher().onHello(id);
  assert.equal(readRecord(id).status, 'held');
  assert.equal(kv.rows.has(helloKey(id)), false, 'hold() removed the remote hello');
  const record = readRecord(id);
  record.status = 'consumed';
  record.consumedAt = new Date(NOW).toISOString();
  writeRecord(record);
  clock = NOW + RECOVER_MS;
  return id;
}

test('(a) recovery re-holds the ORIGINAL held hello; a later writer cannot replace the identity the owner saw', async () => {
  const id = await heldThenCrashed({ withPublic: true });
  // The leaked-link writer: create-only put works again because hold() deleted the first hello.
  await helloFrom(id, { owner: EVE_OWNER, courier: EVE_COURIER });
  await watcher().sweep();
  const record = readRecord(id);
  assert.equal(record.status, 'held');
  assert.equal(record.held.reason, 'internal-error');
  assert.equal(record.held.owner, MALLORY_OWNER);
  assert.equal(record.held.courierDid, MALLORY_COURIER);
  assert.equal(readHeld(id).artifactB.from.owner, MALLORY_OWNER);
  assert.equal(describeHeld(id).owner, MALLORY_OWNER);
  assert.equal(publicOf(id).helloOwner, MALLORY_OWNER);
  assert.equal(publicOf(id).status, 'held');
  // The attacker's hello is removed by hold() (it deletes in/hello.json after the held copy is written), and never paired.
  assert.equal(kv.rows.has(helloKey(id)), false);
  assert.deepEqual(accepted, []);
  assert.equal(welcomeOf(id), undefined);
  // Approval: the owner the human saw works, the attacker's does not.
  const before = fs.readFileSync(recordPath(id), 'utf8');
  const publicBefore = fs.readFileSync(path.join(publicDir(), `${id}.json`), 'utf8');
  await assert.rejects(watcher().approveHeld(id, EVE_OWNER), (e) => e.code === 'owner-mismatch');
  assert.deepEqual(accepted, []);
  assert.equal(fs.readFileSync(recordPath(id), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(publicDir(), `${id}.json`), 'utf8'), publicBefore);
  assert.equal(await watcher().approveHeld(id, MALLORY_OWNER), 'strict');
  assert.deepEqual(accepted, [MALLORY_COURIER]);
});

test('(b) no held copy and a valid remote hello: recovery holds the remote one (crash between the put and the hold)', async () => {
  const id = invite({ expectOwner: HUNTER_OWNER, withPublic: true });
  await helloFrom(id, { owner: MALLORY_OWNER, courier: MALLORY_COURIER });
  const record = readRecord(id);
  record.status = 'consumed';
  record.consumedAt = new Date(NOW).toISOString();
  writeRecord(record);
  assert.equal(fs.existsSync(heldFile(id)), false);
  clock = NOW + RECOVER_MS;
  await watcher().sweep();
  assert.equal(readRecord(id).status, 'held');
  assert.equal(readRecord(id).held.reason, 'internal-error');
  assert.equal(describeHeld(id).owner, MALLORY_OWNER);
  assert.equal(publicOf(id).helloOwner, MALLORY_OWNER);
  assert.deepEqual(accepted, []);
});

test('(c) neither a held copy nor a remote hello: the invite fails with hello-lost', async () => {
  const id = invite({ expectOwner: HUNTER_OWNER });
  const record = readRecord(id);
  record.status = 'consumed';
  record.consumedAt = new Date(NOW).toISOString();
  writeRecord(record);
  clock = NOW + RECOVER_MS;
  await watcher().sweep();
  assert.equal(readRecord(id).status, 'failed');
  assert.deepEqual(accepted, []);
});

test('recovery inside the wait window does nothing', async () => {
  const id = await heldThenCrashed();
  clock = NOW + 60_000;
  await helloFrom(id, { owner: EVE_OWNER, courier: EVE_COURIER });
  await watcher().sweep();
  assert.equal(readRecord(id).status, 'consumed');
  assert.equal(readHeld(id).artifactB.from.owner, MALLORY_OWNER);
});

test('T1: with a recovery that swapped nothing, the OLD owner pairs and the NEW (attacker) owner never does', async () => {
  const id = await heldThenCrashed();
  await helloFrom(id, { owner: EVE_OWNER, courier: EVE_COURIER });
  await watcher().sweep();
  await assert.rejects(watcher().approveHeld(id, EVE_OWNER), (e) => e.code === 'owner-mismatch');
  assert.deepEqual(accepted, []);
  assert.equal(await watcher().approveHeld(id, MALLORY_ADDR), 'strict');
  assert.deepEqual(accepted, [MALLORY_COURIER]);
});

test('T2: approve and describe use the held FILE, not record.held.owner; a record that disagrees with the file does not decide', async () => {
  const id = await squatted();
  // The record says Mallory; the held file is made to say Eve.
  const held = readHeld(id);
  held.artifactB.from.owner = EVE_OWNER;
  held.artifactB.from.courier = EVE_COURIER;
  writeSecure(heldFile(id), held);
  assert.equal(readRecord(id).held.owner, MALLORY_OWNER);
  assert.equal(describeHeld(id).owner, EVE_OWNER);
  await assert.rejects(watcher().approveHeld(id, MALLORY_OWNER), (e) => e.code === 'owner-mismatch');
  assert.deepEqual(accepted, []);
  assert.equal(await watcher().approveHeld(id, EVE_OWNER), 'strict');
  assert.deepEqual(accepted, [EVE_COURIER], 'the hello that is paired is the one in the held file');
});

test('T3: two concurrent approveHeld calls on one held invite pair exactly once; the other fails with a stable code', async () => {
  const id = await squatted();
  const results = await Promise.allSettled([watcher().approveHeld(id, MALLORY_OWNER), watcher().approveHeld(id, MALLORY_OWNER)]);
  assert.equal(accepted.length, 1, `accept was called ${accepted.length} times`);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.ok(failed && typeof failed.reason.code === 'string' && failed.reason.code.length > 0);
  assert.equal(readRecord(id).status, 'completed');
});

// The per-invite lock.
const lockFile = (id) => path.join(secureSubdir('invites'), `${id}.lock`);

test('lock: approve and deny racing on one held invite: one wins, the other is invite-busy, and the result is consistent', async () => {
  const id = await squatted();
  const results = await Promise.allSettled([watcher().approveHeld(id, MALLORY_OWNER), watcher().deny(id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'invite-busy');
  const status = readRecord(id).status;
  assert.equal(status, accepted.length === 1 ? 'completed' : 'denied');
  assert.equal(welcomeOf(id).tier, accepted.length === 1 ? 'strict' : 'rejected');
});

test('lock: a fresh lock makes approve and deny fail with invite-busy and change nothing; the lock file is 0600 and not an invite record', async () => {
  const id = await squatted();
  fs.writeFileSync(lockFile(id), '', { mode: 0o600 });
  const before = fs.readFileSync(recordPath(id), 'utf8');
  await assert.rejects(watcher().approveHeld(id, MALLORY_OWNER), (e) => e.code === 'invite-busy');
  await assert.rejects(watcher().deny(id), (e) => e.code === 'invite-busy');
  assert.deepEqual(accepted, []);
  assert.equal(fs.readFileSync(recordPath(id), 'utf8'), before);
  assert.equal(fs.existsSync(lockFile(id)), true, 'a lock that is not ours is not removed');
  const { listRecords } = await import('../dist/invite-watch.js');
  assert.deepEqual(listRecords().map((r) => r.inviteId), [id]);
});

test('lock: a stale lock (a crashed holder) is taken over and the approve goes through', async () => {
  const id = await squatted();
  fs.writeFileSync(lockFile(id), '', { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockFile(id), old, old);
  assert.equal(await watcher().approveHeld(id, MALLORY_OWNER), 'strict');
  assert.deepEqual(accepted, [MALLORY_COURIER]);
  assert.equal(fs.existsSync(lockFile(id)), false);
});

test('lock: released after a failure (owner-mismatch, failed pairing) so the next attempt is not busy', async () => {
  const id = await squatted();
  await assert.rejects(watcher().approveHeld(id, EVE_OWNER), (e) => e.code === 'owner-mismatch');
  assert.equal(fs.existsSync(lockFile(id)), false);
  const failing = new InviteWatcher({ node: { kv }, profile: () => ({ version: 3, host: 'h', openkeyHost: 'h', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }), log: () => undefined, now: () => new Date(clock), verify: async () => ({ ok: true, address: EMAIL, credentialId: 'c', issuedAt: ISSUED }), accept: async () => { throw new Error('boom'); }, deleteSealed: async () => undefined, peersFiles: [] });
  await assert.rejects(failing.approveHeld(id, MALLORY_OWNER));
  assert.equal(fs.existsSync(lockFile(id)), false);
  assert.equal(await watcher().approveHeld(id, MALLORY_OWNER), 'strict');
});

test('lock: recovery skips an invite whose lock is held (an approve is working on it) instead of failing the sweep', async () => {
  const id = await heldThenCrashed();
  fs.writeFileSync(lockFile(id), '', { mode: 0o600 });
  await watcher().sweep();
  assert.equal(readRecord(id).status, 'consumed');
});

test('lock: revoke takes the lock: with an approve or deny working on the invite it fails invite-busy ("try again in a few minutes") and changes nothing', async () => {
  const id = await squatted();
  fs.writeFileSync(lockFile(id), '', { mode: 0o600 });
  const before = fs.readFileSync(recordPath(id), 'utf8');
  await assert.rejects(watcher().revoke(readRecord(id)), (e) => e.code === 'invite-busy' && /A pairing for this invite is finishing\. Try again in a few minutes\./.test(e.message));
  assert.equal(fs.readFileSync(recordPath(id), 'utf8'), before);
  assert.equal(fs.existsSync(lockFile(id)), true, 'the other holder\'s lock is not removed');
});

test('lock: a revoke retried once the lock is free succeeds (after a failed approve), and one retried after a finished approve is refused as before', async () => {
  const failed = await squatted();
  fs.writeFileSync(lockFile(failed), '', { mode: 0o600 });
  await assert.rejects(watcher().revoke(readRecord(failed)), (e) => e.code === 'invite-busy');
  fs.rmSync(lockFile(failed));
  await watcher().revoke(readRecord(failed));
  assert.equal(readRecord(failed).status, 'revoked');
  assert.equal(fs.existsSync(lockFile(failed)), false);

  const done = await squatted();
  await watcher({ accept: async () => C_ARTIFACT }).approveHeld(done, MALLORY_OWNER);
  await assert.rejects(watcher().revoke(readRecord(done)), (e) => e.code === 'invite-not-open');
  assert.equal(readRecord(done).status, 'completed');
});

test('lock: while held the lock file exists with mode 0600, and it is gone afterwards', async () => {
  const id = await squatted();
  let mode;
  let existed;
  const spy = new InviteWatcher({
    node: { kv }, profile: () => ({ version: 3, host: 'h', openkeyHost: 'h', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: () => undefined, now: () => new Date(clock), verify: async () => ({ ok: true, address: EMAIL, credentialId: 'c', issuedAt: ISSUED }),
    accept: async () => { existed = fs.existsSync(lockFile(id)); mode = fs.statSync(lockFile(id)).mode & 0o777; return C_ARTIFACT; },
    deleteSealed: async () => undefined, peersFiles: [],
  });
  await spy.approveHeld(id, MALLORY_OWNER);
  assert.equal(existed, true);
  assert.equal(mode, 0o600);
  assert.equal(fs.existsSync(lockFile(id)), false);
});
