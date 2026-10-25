// `join` through the real joinStart against the stand-in links API: the inviter named by the invitation is shown and must be confirmed with
// --expect-inviter before anything is created, and the invitee's address is checked against the hash the invitation carries (never the address).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { joinStart } from '../dist/invite-commands.js';
import { parseArgs } from '../dist/args.js';
import { buildInviteBlob } from '../dist/invite-blob.js';
import { createInviteLink, newInviteLinkKey } from '../dist/invite-links.js';
import { startLinksApi } from './support/links-standin.mjs';

assert.ok(process.env.COURIER_TEST === '1' && process.env.COURIER_TEST_HOME, 'the test home fence is armed');

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const HOST = 'https://node.example.test';
const INVITER_ADDR = `0x${'ab'.repeat(20)}`;
const INVITER_OWNER = `did:pkh:eip155:1:${INVITER_ADDR}`;
const INVITER_COURIER = 'did:key:z6MkInviterCourier';
const SPACE = `tinycloud:pkh:eip155:1:${INVITER_ADDR}:agents`;
const INVITE_ID = 'a'.repeat(25) + 'b';
const EMAIL = 'hunter@example.test';

let standin;
let link;
let home;
let saved;

before(async () => {
  standin = await startLinksApi({ now: () => NOW });
  const key = newInviteLinkKey();
  const blobText = buildInviteBlob({
    inviteId: INVITE_ID, host: HOST, spaceId: SPACE,
    oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) },
    permissions: { put: 'P', read: 'R', hooks: 'H' },
    artifactA: { type: 'courier-pair', v: 0, step: 'A', from: { owner: INVITER_OWNER, courier: INVITER_COURIER, label: 'Sam' }, spaceId: SPACE, peer: 'me', callMe: 'hunter', issuedAt: new Date(NOW).toISOString() },
    expiresAt: new Date(NOW + 3600e3), issuer: key.signer.did, expectEmail: EMAIL, expectOwner: null, tier: 'strict', now: NOW,
  });
  link = (await createInviteLink(standin.config, { blobText, expiresAt: new Date(NOW + 3600e3), key, now: NOW })).link;
});
after(() => standin.stop());

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712.join-inviter.'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  process.env.COURIER_HOME = home;
  process.env.HOME = home;
  delete process.env.COURIER_PEERS_FILE;
  assert.ok([process.env.COURIER_HOME, process.env.HOME].every((p) => path.resolve(p).startsWith(path.resolve(process.env.COURIER_TEST_HOME) + path.sep)));
  standin.requests.length = 0;
});
afterEach(() => {
  for (const name of Object.keys(saved)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const profile = () => ({ version: 3, host: HOST, openkeyHost: 'https://o.example.test', label: 'me', courierDid: 'did:key:z6MkMe', ownerDid: `did:pkh:eip155:1:0x${'2'.repeat(40)}`, spaceId: `tinycloud:pkh:eip155:1:0x${'2'.repeat(40)}:agents`, status: 'ready', peers: {} });
const run = (flags, p = profile()) => joinStart(parseArgs(['--stdin', ...flags]), link, { ctx: async () => ({ profile: p, node: {} }), links: standin.config, now: NOW });
/** A peers file that lists the handle the invitation picks: a join that gets past the inviter and address checks stops here, before it creates anything. */
function gate() {
  const file = path.join(home, 'gate', 'peers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hunter: { tier: 'trusted' } }), { mode: 0o600 });
  return ['--peers-file', file];
}
const passes = (flags, p) => assert.rejects(run([...gate(), ...flags], p), (e) => e.code === 'peers-entry-exists');
const nothingCreated = (p) => {
  assert.deepEqual(p.peers, {});
  assert.equal(fs.existsSync(path.join(home, 'joins')) ? fs.readdirSync(path.join(home, 'joins')).length : 0, 0);
  assert.equal(standin.requests.every((r) => r.method === 'GET'), true, 'only the invitation was read');
};
const refusedWith = (code) => (e) => e.name === 'CourierError' && e.code === code;

// --- --expect-inviter ---------------------------------------------------------------------------------------------------------------------------

test('join without --expect-inviter prints the inviter (owner, handle, space) and the exact command, and creates nothing', async () => {
  const p = profile();
  await assert.rejects(run([], p), (e) => {
    assert.ok(refusedWith('inviter-unconfirmed')(e));
    for (const fact of [INVITER_OWNER, 'handle "hunter"', SPACE, `join --stdin --expect-inviter ${INVITER_OWNER}`, 'Nothing was sent']) assert.ok(e.message.includes(fact), fact);
    assert.equal(/#v=4|k=[A-Za-z0-9_-]{43}/.test(e.message), false, 'the link is not echoed');
    return true;
  });
  nothingCreated(p);
});

test('join with --expect-inviter given no value is the same as none', async () => {
  const p = profile();
  await assert.rejects(run(['--expect-inviter'], p), refusedWith('inviter-unconfirmed'));
  nothingCreated(p);
});

test('join with another inviter than the invitation names is refused with both shown, and creates nothing', async () => {
  for (const other of [`did:pkh:eip155:1:0x${'cd'.repeat(20)}`, `did:pkh:eip155:5:${INVITER_ADDR}`]) {
    const p = profile();
    standin.requests.length = 0;
    await assert.rejects(run(['--expect-inviter', other], p), (e) => {
      assert.ok(refusedWith('inviter-mismatch')(e));
      assert.ok(e.message.includes(other) && e.message.includes(INVITER_OWNER));
      return true;
    });
    nothingCreated(p);
  }
});

test('a malformed --expect-inviter is a usage error', async () => {
  for (const bad of ['sam', 'did:key:z6MkInviterCourier', INVITER_ADDR, 'did:pkh:eip155:1:0x12']) {
    const p = profile();
    await assert.rejects(run(['--expect-inviter', bad], p), refusedWith('usage'));
    nothingCreated(p);
  }
});

test('the right inviter lets the join proceed (the address in any case)', async () => {
  await passes(['--expect-inviter', INVITER_OWNER]);
  await passes(['--expect-inviter', `did:pkh:eip155:1:0x${INVITER_ADDR.slice(2).toUpperCase()}`]);
});

// --- the invitee's address -------------------------------------------------------------------------------------------------------------------

test('--email is checked against the hash in the invitation: another address is refused before anything is created, without echoing either address', async () => {
  const p = profile();
  await assert.rejects(run(['--expect-inviter', INVITER_OWNER, '--email', 'mallory@example.test'], p), (e) => {
    assert.ok(refusedWith('invite-email-mismatch')(e));
    assert.equal(/mallory|hunter/.test(e.message), false);
    return true;
  });
  nothingCreated(p);
});

test('--email with the invited address (any case, padded) is accepted', async () => {
  await passes(['--expect-inviter', INVITER_OWNER, '--email', EMAIL]);
  await passes(['--expect-inviter', INVITER_OWNER, '--email', '  Hunter@Example.TEST ']);
});

test('the address is not in the invitation the service holds: the stand-in\'s record carries no part of it', () => {
  for (const stored of standin.records.values()) {
    assert.equal(Buffer.from(stored.body).toString('latin1').includes('hunter'), false);
  }
});

test('a credential without --email is a usage error (the address cannot be taken from the invitation, which holds only its hash); a malformed --email is too', async () => {
  const proof = path.join(home, 'proof.txt');
  fs.writeFileSync(proof, 'proof-text');
  const p = profile();
  await assert.rejects(run(['--expect-inviter', INVITER_OWNER, '--credential-file', proof], p), (e) => e.code === 'usage' && /--email/.test(e.message));
  await assert.rejects(run(['--expect-inviter', INVITER_OWNER, '--email', 'not-an-address'], p), refusedWith('usage'));
  nothingCreated(p);
});

test('the inviter is checked before the address: an unconfirmed inviter never reaches the address check', async () => {
  const p = profile();
  await assert.rejects(run(['--email', 'mallory@example.test'], p), refusedWith('inviter-unconfirmed'));
  nothingCreated(p);
});
