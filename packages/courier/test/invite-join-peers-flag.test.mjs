// `join --peers-file <f>` reaches the peers guard that runs on the handle the INVITER picked. The path under test is the real joinStart: the invite
// is fetched from a local stand-in for the links API, opened and parsed; only the profile/node (ctx) is injected, because no node is available.
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
import { StandInHost, honestPermissions } from './support/invite-proof-fixture.mjs';

const HOST = 'https://node.example.test';
const INVITER_OWNER = `did:pkh:eip155:1:0x${'1'.repeat(40)}`;
const INVITER_COURIER = 'did:key:z6MkInviterCourier';
const SPACE = `tinycloud:pkh:eip155:1:0x${'1'.repeat(40)}:agents`;
const INVITE_ID = 'a'.repeat(25) + 'b';
// A fixed clock for the service, the link and the join.
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

let standin;
let inviteString;
let home;
let saved;
let host;

before(async () => {
  host = new StandInHost();
  standin = await startLinksApi({ now: () => NOW });
  const key = newInviteLinkKey();
  const blobText = buildInviteBlob({
    inviteId: INVITE_ID, host: HOST, spaceId: SPACE,
    oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) },
    permissions: honestPermissions(host, { inviteId: INVITE_ID, space: SPACE, courier: INVITER_COURIER, ownerAddress: `0x${'1'.repeat(40)}` }),
    artifactA: { type: 'courier-pair', v: 0, step: 'A', from: { owner: INVITER_OWNER, courier: INVITER_COURIER, label: 'Sam' }, spaceId: SPACE, peer: 'me', callMe: 'hunter', issuedAt: new Date(NOW).toISOString() },
    expiresAt: new Date(NOW + 3600e3), issuer: key.signer.did, expectEmail: 'hunter@example.test', expectOwner: null, tier: 'strict', now: NOW,
  });
  inviteString = (await createInviteLink(standin.config, { blobText, expiresAt: new Date(NOW + 3600e3), key, now: NOW })).link;
});

after(() => standin.stop());

/** Reads of the invitation the join made. */
const fetches = () => standin.requests.filter((r) => r.method === 'GET').length;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712.join-flag.'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  process.env.COURIER_HOME = home;
  process.env.HOME = home;
  delete process.env.COURIER_PEERS_FILE;
  standin.requests.length = 0;
  assert.ok([process.env.COURIER_HOME, process.env.HOME].every((p) => path.resolve(p).startsWith(path.resolve(process.env.COURIER_TEST_HOME) + path.sep)));
});

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const profile = () => ({ version: 3, host: HOST, openkeyHost: 'https://o.example.test', label: 'me', courierDid: 'did:key:z6MkMe', ownerDid: `did:pkh:eip155:1:0x${'2'.repeat(40)}`, spaceId: `tinycloud:pkh:eip155:1:0x${'2'.repeat(40)}:agents`, status: 'ready', peers: {} });
const run = (flags, p) => joinStart(parseArgs(['--stdin', '--expect-inviter', INVITER_OWNER, ...flags]), inviteString, { ctx: async () => ({ profile: p, node: {} }), links: standin.config, now: NOW, proof: { activator: () => host.activator() } });

test('join: a handle listed in a peers file given ONLY by --peers-file is refused after the invite is fetched, before any peer is created', async () => {
  const file = path.join(home, 'gate', 'peers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hunter: { tier: 'trusted' } }), { mode: 0o600 });
  const p = profile();
  await assert.rejects(run(['--peers-file', file], p), (e) => e.code === 'peers-entry-exists');
  assert.equal(fetches(), 1, 'the invite was fetched and parsed: the handle is only known from it');
  assert.deepEqual(p.peers, {});
  assert.deepEqual(fs.readdirSync(path.join(home, 'joins')), []);
});

test('join: the same invite without the flag does not stop at the peers guard (the control for the row above)', async () => {
  const file = path.join(home, 'gate', 'peers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hunter: { tier: 'trusted' } }), { mode: 0o600 });
  const p = profile();
  await assert.rejects(run([], p), (e) => e.code !== 'peers-entry-exists' && e.code !== 'peers-unreadable');
  assert.equal(fetches(), 1);
});

test('join: an unreadable file given only by --peers-file is refused as peers-unreadable', async () => {
  const file = path.join(home, 'gate', 'peers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json', { mode: 0o600 });
  await assert.rejects(run(['--peers-file', file], profile()), (e) => e.code === 'peers-unreadable');
});
