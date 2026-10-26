// A held invite is approved only by naming the owner of the hello that is actually held; the gate sees the same facts in the public record.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import { InviteWatcher, describeHeld, heldFactsText, ownerConfirms, readRecord, recordPath } from '../dist/invite-watch.js';
import { writePublicInvite, publicHeldReason, HELD_REASONS } from '../dist/invite-public.js';
import { inviteFolder } from '../dist/invite-schema.js';
import { newInviteId } from '../dist/invite-blob.js';
import { writeSecure } from '../dist/profile.js';
import { noticeText } from '../dist/notify.js';
import { ed25519DidKey } from '../dist/did-key.js';
import { memoryKv } from './memory-kv.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const NOW = Date.now();
const ISSUED = new Date(NOW).toISOString();
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = `0x${'a'.repeat(40)}`;
const MALLORY_ADDR = `0x${'B'.repeat(40)}`;
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const MALLORY_OWNER = `did:pkh:eip155:1:${MALLORY_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';
const MALLORY_COURIER = ed25519DidKey('M'.repeat(43)); // a real ed25519 did:key: owner-facing texts print only those
const EMAIL = 'hunter@example.test';
const C_ARTIFACT = { type: 'courier-pair', v: 0, step: 'C', from: { owner: SAM_OWNER, courier: SAM_COURIER }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'hunter', callMe: 'sam', delegation: 'DELEGATION-C', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED };

let home;
let sentinel;
let saved;
let kv;
let accepted;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-approve-owner-home-'));
  sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-approve-owner-sentinel-'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  delete process.env.COURIER_PEERS_FILE;
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  kv = memoryKv();
  accepted = [];
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
    now: () => new Date(NOW),
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

test('a squatter hello is held with the real owner recorded and shown, not the expected one', async () => {
  const id = await squatted({ withPublic: true });
  const record = readRecord(id);
  assert.equal(record.status, 'held');
  assert.equal(record.held.reason, 'owner-mismatch');
  assert.equal(record.held.owner, MALLORY_OWNER);
  assert.equal(record.held.courierDid, MALLORY_COURIER);
  const facts = describeHeld(id);
  assert.equal(facts.owner, MALLORY_OWNER);
  assert.equal(facts.courierDid, MALLORY_COURIER);
  assert.equal(facts.expectOwner, HUNTER_OWNER);
  assert.equal(facts.reason, 'owner-mismatch');
  const text = heldFactsText(facts);
  for (const part of [id, MALLORY_OWNER, MALLORY_COURIER, HUNTER_OWNER, 'owner-mismatch']) assert.ok(text.includes(part), part);
});

test('public record: a held invite carries heldReason and the bare owner DID of the hello that arrived; nothing else is added', async () => {
  const id = await squatted({ withPublic: true });
  const pub = publicOf(id);
  assert.equal(pub.status, 'held');
  assert.equal(pub.heldReason, 'owner-mismatch');
  assert.equal(pub.helloOwner, MALLORY_OWNER);
  assert.equal(pub.expectOwner, HUNTER_OWNER);
  assert.deepEqual(Object.keys(pub), ['v', 'inviteId', 'handle', 'expectEmail', 'expectOwner', 'tier', 'createdAt', 'expiresAt', 'status', 'completedPeer', 'heldReason', 'helloOwner']);
  assert.doesNotMatch(JSON.stringify(pub), /did:key|DELETE-TOKEN|store-1/);
});

test('public record: the held facts are removed once the invite leaves held', async () => {
  const id = await squatted({ withPublic: true });
  await watcher().approveHeld(id, MALLORY_OWNER);
  const pub = publicOf(id);
  assert.equal(pub.status, 'completed');
  assert.equal('heldReason' in pub, false);
  assert.equal('helloOwner' in pub, false);
});

test('public record: a sweep restores held facts that are missing from the public copy', async () => {
  const id = await squatted({ withPublic: true });
  const pub = publicOf(id);
  delete pub.heldReason;
  delete pub.helloOwner;
  writePublicInvite(publicDir(), pub);
  assert.equal('heldReason' in publicOf(id), false);
  await watcher().sweep();
  assert.equal(publicOf(id).heldReason, 'owner-mismatch');
  assert.equal(publicOf(id).helloOwner, MALLORY_OWNER);
});

test('public record schema: held facts only as a pair, only while held, reason from the closed set, owner a did:pkh DID', () => {
  const id = invite({ withPublic: true });
  const base = publicOf(id);
  const held = { ...base, status: 'held' };
  const ok = { ...held, heldReason: 'owner-mismatch', helloOwner: MALLORY_OWNER };
  writePublicInvite(publicDir(), ok);
  const bad = (record, pattern) => assert.throws(() => writePublicInvite(publicDir(), record), pattern);
  bad({ ...held, heldReason: 'owner-mismatch' }, /given together/);
  bad({ ...held, helloOwner: MALLORY_OWNER }, /given together/);
  bad({ ...ok, status: 'open' }, /held invite only/);
  bad({ ...ok, heldReason: 'because I said so' }, /heldReason must be one of/);
  bad({ ...ok, heldReason: 'x\n<script>' }, /heldReason must be one of/);
  bad({ ...ok, helloOwner: 'mallory' }, /helloOwner must be a did:pkh:eip155 DID/);
  bad({ ...ok, helloOwner: `${MALLORY_OWNER}#key-1` }, /helloOwner must be a did:pkh:eip155 DID/);
  bad({ ...ok, extra: 1 }, /unexpected fields extra/);
  assert.equal(publicHeldReason('something free-form'), 'internal-error');
  for (const reason of HELD_REASONS) assert.equal(publicHeldReason(reason), reason);
});

test('approveHeld refuses an owner that is not the held hello\'s owner (owner-mismatch) and changes nothing', async () => {
  const id = await squatted({ withPublic: true });
  const before = fs.readFileSync(recordPath(id), 'utf8');
  const publicBefore = fs.readFileSync(path.join(publicDir(), `${id}.json`), 'utf8');
  // The owner the invite EXPECTED is exactly what a mistaken tap would type.
  for (const wrong of [HUNTER_OWNER, HUNTER_ADDR, 'did:pkh:eip155:1:0x' + '0'.repeat(40), '', 'mallory', `${MALLORY_OWNER}x`]) {
    await assert.rejects(watcher().approveHeld(id, wrong), (e) => e.code === 'owner-mismatch', wrong);
  }
  assert.deepEqual(accepted, []);
  assert.equal(fs.readFileSync(recordPath(id), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(publicDir(), `${id}.json`), 'utf8'), publicBefore);
  assert.equal(readRecord(id).status, 'held');
  assert.equal(kv.rows.get(`${inviteFolder(id)}out/welcome.json`), undefined);
});

test('approveHeld with the held hello\'s owner pairs it at strict; the owner may be given as the DID or the 0x address in any case', async () => {
  const id = await squatted();
  assert.equal(await watcher().approveHeld(id, MALLORY_OWNER), 'strict');
  assert.equal(readRecord(id).status, 'completed');
  assert.deepEqual(accepted, [MALLORY_COURIER]);
  assert.equal(kv.rows.get(`${inviteFolder(id)}out/welcome.json`).value.tier, 'strict');

  const second = await squatted();
  assert.equal(await watcher().approveHeld(second, MALLORY_ADDR.toLowerCase()), 'strict');
  assert.deepEqual(accepted, [MALLORY_COURIER, MALLORY_COURIER]);
});

test('ownerConfirms: an owner DID or bare address of the hello\'s owner, nothing looser', () => {
  assert.equal(ownerConfirms(MALLORY_OWNER, MALLORY_OWNER), true);
  assert.equal(ownerConfirms(MALLORY_ADDR, MALLORY_OWNER), true);
  assert.equal(ownerConfirms(MALLORY_ADDR.toLowerCase(), MALLORY_OWNER), true);
  assert.equal(ownerConfirms(HUNTER_ADDR, MALLORY_OWNER), false);
  assert.equal(ownerConfirms(`did:pkh:eip155:5:${MALLORY_ADDR}`, MALLORY_OWNER), false);
  assert.equal(ownerConfirms(MALLORY_ADDR.slice(0, 20), MALLORY_OWNER), false);
  assert.equal(ownerConfirms(MALLORY_ADDR, 'did:key:z6MkMallory'), false);
});

test('approveHeld on an invite that is not held is invite-not-held, before any owner check', async () => {
  const id = invite();
  await assert.rejects(watcher().approveHeld(id, MALLORY_OWNER), (e) => e.code === 'invite-not-held');
});

function runCli(args) {
  const env = { ...process.env, COURIER_HOME: home };
  delete env.COURIER_PEERS_FILE;
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
}

test('courier invite approve without --owner shows the facts and pairs nothing', async () => {
  const id = await squatted();
  const before = fs.readFileSync(recordPath(id), 'utf8');
  const result = runCli(['invite', 'approve', id]);
  assert.equal(result.status, 2);
  for (const part of [MALLORY_OWNER, MALLORY_COURIER, HUNTER_OWNER, 'owner-mismatch', id]) assert.ok(result.stdout.includes(part), part);
  assert.match(result.stderr, /Nothing was paired\. Check that the owner above is the one you mean to pair, then run: .*invite approve [a-z2-7]{26} --owner/);
  assert.equal(fs.readFileSync(recordPath(id), 'utf8'), before);
  const empty = runCli(['invite', 'approve', id, '--owner']);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /Nothing was paired/);
});

test('courier invite approve --owner <the expected owner> is refused with the facts: owner-mismatch, nothing paired', async () => {
  const id = await squatted();
  const before = fs.readFileSync(recordPath(id), 'utf8');
  const result = runCli(['invite', 'approve', id, '--owner', HUNTER_OWNER]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^courier: \[owner-mismatch\]/);
  assert.ok(result.stdout.includes(MALLORY_OWNER));
  assert.equal(fs.readFileSync(recordPath(id), 'utf8'), before);
});

test('courier invite approve --owner <the held hello\'s owner> gets past the owner check (it then needs a profile)', async () => {
  const id = await squatted();
  const result = runCli(['invite', 'approve', id, '--owner', MALLORY_OWNER]);
  assert.match(result.stderr, /^courier: \[no-profile\]/);
  assert.ok(result.stdout.includes(MALLORY_COURIER));
});

test('courier invite approve on an invite that is not held says so', () => {
  const id = invite();
  const result = runCli(['invite', 'approve', id, '--owner', MALLORY_OWNER]);
  assert.match(result.stderr, /^courier: \[invite-not-held\]/);
});

test('the invite-held notice tells the owner the command that works: approve WITH --owner <the held owner>, and deny', async () => {
  const id = invite({ expectOwner: HUNTER_OWNER });
  await helloFrom(id, { owner: MALLORY_OWNER, courier: MALLORY_COURIER });
  const notices = [];
  const w = new InviteWatcher({
    node: { kv },
    profile: () => ({ version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: () => undefined, notify: async (n) => { notices.push(n); }, now: () => new Date(NOW),
    verify: async () => ({ ok: true, address: EMAIL, credentialId: 'c', issuedAt: ISSUED }),
    accept: async () => C_ARTIFACT, deleteSealed: async () => undefined, peersFiles: [],
  });
  await w.onHello(id);
  const body = noticeText(notices[0], '').body;
  assert.ok(body.includes(`courier invite approve ${id} --owner ${MALLORY_OWNER}`), body);
  assert.ok(body.includes(`courier invite deny ${id}`));
  assert.doesNotMatch(body, new RegExp(`approve ${id} or`));
});
