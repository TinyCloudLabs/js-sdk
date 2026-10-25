import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptB } from '../dist/commands.js';
import { memoryKv } from './memory-kv.mjs';

const ISSUED = '2026-10-21T00:00:00.000Z';
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const HUNTER_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const HUNTER_OWNER = `did:pkh:eip155:1:${HUNTER_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const HUNTER_COURIER = 'did:key:z6MkHunterCourier';
const SPACE = `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`;
const HANDLE = 'hunter';

let home;
let saved;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-accept-b-'));
  fs.chmodSync(home, 0o700);
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME };
  process.env.COURIER_HOME = home;
  process.env.HOME = home;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const profileFixture = () => ({
  version: 1,
  ownerDid: SAM_OWNER,
  courierDid: SAM_COURIER,
  spaceId: SPACE,
  label: 'sam',
  peers: { [HANDLE]: { handle: HANDLE, status: 'pending-A', outbound: [] } },
});

const artB = () => ({
  type: 'courier-pair',
  v: 0,
  step: 'B',
  from: { owner: HUNTER_OWNER, courier: HUNTER_COURIER, label: 'hunter' },
  spaceId: SPACE,
  peer: 'hunter-b',
  callMe: 'sam',
  delegation: 'stub-serialized-delegation',
  issuedAt: ISSUED,
});

const inboundDelegation = () => ({ cid: 'in-cid', expiry: new Date('2026-10-28T00:00:00.000Z'), spaceId: SPACE });
const stubValidate = async () => ({ delegation: inboundDelegation(), cid: 'in-cid', expiresAt: '2026-10-28T00:00:00.000Z' });

function nodeWith(calls) {
  return {
    kv: memoryKv(),
    async delegateTo(did, _perms, opts) {
      calls.push({ did, opts });
      return { delegation: { cid: `out-${calls.length}`, expiry: new Date(Date.now() + 7 * 864e5), spaceId: SPACE } };
    },
  };
}

test('a failed profile save after delegateTo CAN orphan the first outgoing delegation (it expires in 7 days); the retry creates no second pending peer', async () => {
  const profile = profileFixture();
  const calls = [];
  const node = nodeWith(calls);
  // profile.json as a directory makes the commit-point saveProfile fail after delegateTo has run.
  const blocker = path.join(home, 'profile.json');
  fs.mkdirSync(blocker);

  await assert.rejects(acceptB(profile, node, artB(), HANDLE, { validatePeerDelegation: stubValidate }));
  assert.equal(profile.peers[HANDLE].status, 'pending-A');
  assert.deepEqual(profile.peers[HANDLE].outbound, []);
  assert.equal(calls.length, 1);

  fs.rmdirSync(blocker);
  const out = await acceptB(profile, node, artB(), HANDLE, { validatePeerDelegation: stubValidate });

  assert.equal(out.step, 'C');
  assert.equal(JSON.parse(out.delegation).cid, 'out-2');
  assert.deepEqual(Object.keys(profile.peers), [HANDLE]);
  assert.equal(profile.peers[HANDLE].status, 'paired');
  // out-1 was never recorded on the peer, so it is orphaned; it expires in 7 days like the retry's.
  assert.deepEqual(profile.peers[HANDLE].outbound.map((o) => o.cid), ['out-2']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.opts.expiry), ['7d', '7d']);
  assert.ok(fs.existsSync(path.join(home, 'profile.json')));
});

test('a failed inbound validation mints no outgoing delegation and leaves the peer pending-A', async () => {
  const profile = profileFixture();
  const calls = [];
  const node = nodeWith(calls);
  const rejectValidate = async () => {
    throw new Error('validation rejected');
  };

  await assert.rejects(acceptB(profile, node, artB(), HANDLE, { validatePeerDelegation: rejectValidate }), /validation rejected/);
  assert.equal(profile.peers[HANDLE].status, 'pending-A');
  assert.deepEqual(profile.peers[HANDLE].outbound, []);
  assert.equal(calls.length, 0);
});
