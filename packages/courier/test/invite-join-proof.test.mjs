// `join` proves the invitation's grants come from the inviter the person joining named, BEFORE it grants, claims or writes anything. The path under test
// is the real joinStart against the stand-in links API and a stand-in host that accepts only delegations the owner's chain really issued. The node is a
// recorder that fails any use: a refused invitation must leave it untouched, the join directory empty and the home unchanged.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { joinStart } from '../dist/invite-commands.js';
import { parseArgs } from '../dist/args.js';
import { buildInviteBlob } from '../dist/invite-blob.js';
import { createInviteLink, newInviteLinkKey } from '../dist/invite-links.js';
import { proveInviter, oneTimeKeyActivator } from '../dist/invite-proof.js';
import { startLinksApi } from './support/links-standin.mjs';
import { ONE_TIME_DID, ONE_TIME_X, StandInHost, delegationText, honestPermissions } from './support/invite-proof-fixture.mjs';

assert.ok(process.env.COURIER_TEST === '1' && process.env.COURIER_TEST_HOME, 'the test home fence is armed');

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const HOST = 'https://node.example.test';
const ADDR = `0x${'ab'.repeat(20)}`;
const OWNER = `did:pkh:eip155:1:${ADDR}`;
const SPACE = `tinycloud:pkh:eip155:1:${ADDR}:agents`;
const OTHER_SPACE = `tinycloud:pkh:eip155:1:0x${'cd'.repeat(20)}:agents`;
const COURIER = 'did:key:z6MkInviterCourier';
const OTHER_COURIER = 'did:key:z6MkSomeOtherCourier';
const ATTACKER = 'did:key:z6MkAttackerKey';
const INVITE_ID = 'a'.repeat(25) + 'b';
const EMAIL = 'hunter@example.test';

let standin;
let host;
let home;
let saved;

before(async () => {
  standin = await startLinksApi({ now: () => NOW });
});
after(() => standin.stop());

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712.join-proof.'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE };
  process.env.COURIER_HOME = home;
  process.env.HOME = home;
  delete process.env.COURIER_PEERS_FILE;
  assert.ok([process.env.COURIER_HOME, process.env.HOME].every((p) => path.resolve(p).startsWith(path.resolve(process.env.COURIER_TEST_HOME) + path.sep)));
  standin.requests.length = 0;
  host = new StandInHost();
});
afterEach(() => {
  for (const name of Object.keys(saved)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** A permission as the owner's courier really issues it (the host knows it) or as someone else made it up. */
const permission = (which, over = {}, issued = true) => {
  const made = delegationText({ inviteId: INVITE_ID, which, space: SPACE, issuer: COURIER, ownerAddress: ADDR, ...over });
  return issued ? host.issue(made) : made.text;
};
const honest = () => honestPermissions(host, { inviteId: INVITE_ID, space: SPACE, courier: COURIER, ownerAddress: ADDR });

/** An invitation naming the real owner and space, carrying the given permissions. */
async function invitation(permissions) {
  const key = newInviteLinkKey();
  const blobText = buildInviteBlob({
    inviteId: INVITE_ID, host: HOST, spaceId: SPACE,
    oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: ONE_TIME_X, d: 'B'.repeat(43) },
    permissions,
    artifactA: { type: 'courier-pair', v: 0, step: 'A', from: { owner: OWNER, courier: COURIER, label: 'Sam' }, spaceId: SPACE, peer: 'me', callMe: 'hunter', issuedAt: new Date(NOW).toISOString() },
    expiresAt: new Date(NOW + 3600e3), issuer: key.signer.did, expectEmail: EMAIL, expectOwner: null, tier: 'strict', now: NOW,
  });
  return (await createInviteLink(standin.config, { blobText, expiresAt: new Date(NOW + 3600e3), key, now: NOW })).link;
}

/** A node that records every property read and fails every call: nothing may be asked of it before the grants are proven. */
function recorderNode() {
  const touched = [];
  const node = new Proxy({}, {
    get(_, name) {
      touched.push(String(name));
      return () => { throw Object.assign(new Error('node used'), { code: 'node-used' }); };
    },
  });
  return { node, touched };
}

/** Every file under `dir` with its bytes. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else out[path.relative(dir, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const profile = () => ({ version: 3, host: HOST, openkeyHost: 'https://o.example.test', label: 'me', courierDid: 'did:key:z6MkMe', ownerDid: `did:pkh:eip155:1:0x${'2'.repeat(40)}`, spaceId: `tinycloud:pkh:eip155:1:0x${'2'.repeat(40)}:agents`, status: 'ready', peers: {} });

function join(link, { node, p = profile(), activator } = {}) {
  return joinStart(parseArgs(['--stdin', '--expect-inviter', OWNER]), link, {
    ctx: async () => ({ profile: p, node }),
    links: standin.config,
    now: NOW,
    proof: { activator: () => activator ?? host.activator() },
  });
}

/** The invitation is refused as unproven with `reason`, and nothing was granted, claimed, created or sent. */
async function refusedUnproven(permissions, reason, { activator } = {}) {
  const link = await invitation(permissions);
  standin.requests.length = 0; // the creation of the invitation is the test's setup, not the join's
  const { node, touched } = recorderNode();
  const p = profile();
  const before = snapshot(home);
  await assert.rejects(join(link, { node, p, activator }), (e) => {
    assert.equal(e.name, 'CourierError');
    assert.equal(e.code, 'inviter-unproven', e.message);
    assert.ok(e.message.includes(`(${reason})`), `reason ${reason}: ${e.message}`);
    for (const text of ['hunter', 'Sam', EMAIL, 'k=', '#v=']) assert.equal(e.message.includes(text), false, `the message carries no invitation text (${text})`);
    return true;
  });
  assert.deepEqual(touched, [], 'the node was not touched: no read grant on to/<callMe>/, no peer record');
  assert.deepEqual(p.peers, {}, 'no call-me claim and no peer');
  assert.deepEqual(snapshot(home), before, 'no state file written or changed (profile, joins, holds)');
  assert.equal(fs.existsSync(path.join(home, 'joins')) ? fs.readdirSync(path.join(home, 'joins')).length : 0, 0, 'no join file');
  assert.equal(standin.requests.every((r) => r.method === 'GET'), true, 'nothing was sent to the links service but the read of the invitation');
}

// --- the honest invitation ---------------------------------------------------------------------------------------------------------------------

test('an invitation whose read and put grants verify as the named inviter\'s is activated at the host and then proceeds to the first grant', async () => {
  const link = await invitation(honest());
  const calls = [];
  const node = { delegateTo: async (...args) => { calls.push(args); throw Object.assign(new Error('stop here'), { code: 'stop-here' }); } };
  const p = profile();
  await assert.rejects(join(link, { node, p }), (e) => e.code === 'stop-here');
  assert.equal(host.attempts.length, 2, 'both delegations were activated at the host');
  assert.equal(calls.length, 1, 'only now is the read grant for the inviter requested');
  assert.equal(calls[0][0], COURIER);
});

// --- invitations naming the real inviter whose grants are not theirs -------------------------------------------------------------------------

for (const which of ['read', 'put']) {
  const other = which === 'read' ? 'put' : 'read';
  const with_ = (over, issued) => ({ ...honest(), [which]: permission(which, over, issued), [other]: permission(other) });

  test(`${which} grant signed by someone else (the host does not accept its chain): refused, nothing created`, async () => {
    await refusedUnproven(with_({ issuer: ATTACKER }, false), 'host');
  });

  test(`${which} grant a real chain of the host but issued by another courier than the invitation names: refused, nothing created`, async () => {
    await refusedUnproven(with_({ issuer: OTHER_COURIER }), 'issuer');
  });

  test(`${which} grant for another space than the invitation's: refused, nothing created`, async () => {
    await refusedUnproven(with_({ transportSpace: OTHER_SPACE }), 'space');
    // The signed space differs from what the delegation says about itself: the SDK refuses it.
    await refusedUnproven(with_({ space: OTHER_SPACE, transportSpace: SPACE }), 'malformed');
  });

  test(`${which} grant whose audience is not the invitation's one-time key: refused, nothing created`, async () => {
    await refusedUnproven(with_({ audience: ATTACKER }), 'audience');
    // Even when both grants name that other key and the activator acts as it (so the SDK has no objection), the audience is checked against the one-time key.
    const both = { ...honest(), read: permission('read', { audience: ATTACKER }), put: permission('put', { audience: ATTACKER }) };
    await refusedUnproven(both, 'audience', { activator: host.activator(ATTACKER) });
  });

  test(`${which} grant that says another owner address for itself: refused, nothing created`, async () => {
    await refusedUnproven(with_({ ownerAddress: `0x${'cd'.repeat(20)}` }), 'owner');
  });

  test(`${which} grant with more authority, or a different path, than the invitation needs: refused, nothing created`, async () => {
    await refusedUnproven(with_({ actions: [...(which === 'read' ? ['tinycloud.kv/get', 'tinycloud.kv/list'] : ['tinycloud.kv/put']), 'tinycloud.kv/del'] }), 'authority');
    await refusedUnproven(with_({ path: 'me/' }), 'authority');
  });

  test(`${which} grant that is not a delegation at all: refused, nothing created`, async () => {
    await refusedUnproven({ ...honest(), [which]: 'junk' }, 'malformed');
    await refusedUnproven({ ...honest(), [which]: '{}' }, 'space'); // parses, but names no space of its own
  });
}

test('the owner of the invitation\'s space must be the inviter that was named', async () => {
  const blob = {
    host: HOST, spaceId: SPACE, inviteId: INVITE_ID,
    outPrefix: `${JSON.parse(honest().read).path}`, helloKey: `${JSON.parse(honest().put).path}`,
    oneTimeKey: { x: ONE_TIME_X },
    permissions: honest(),
    artifactA: { from: { courier: COURIER } },
  };
  await proveInviter({}, blob, OWNER, { activator: () => host.activator() });
  await assert.rejects(proveInviter({}, blob, `did:pkh:eip155:1:0x${'cd'.repeat(20)}`, { activator: () => host.activator() }), (e) => e.code === 'inviter-unproven' && e.message.includes('(owner)'));
});

// --- the production activator ----------------------------------------------------------------------------------------------------------------

test('without the test seam the delegations are activated at the invitation\'s host as the one-time key: a host that accepts passes, one that refuses does not', async () => {
  const seen = [];
  let accept = true;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(accept ? 200 : 401, { 'content-type': 'application/json' }).end(accept ? '{"activated":[],"skipped":[]}' : 'no parent');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const blob = {
      host: url, spaceId: SPACE, inviteId: INVITE_ID,
      outPrefix: JSON.parse(honest().read).path, helloKey: JSON.parse(honest().put).path,
      oneTimeKey: { x: ONE_TIME_X }, permissions: honest(), artifactA: { from: { courier: COURIER } },
    };
    const node = { computeDelegationCid: (authorization) => `cid:${authorization}` };
    assert.equal(oneTimeKeyActivator(node, blob).sessionDid, ONE_TIME_DID);
    await proveInviter(node, blob, OWNER);
    assert.deepEqual(seen.map((s) => [s.method, s.url]), [['POST', '/delegate'], ['POST', '/delegate']]);
    assert.deepEqual(seen.map((s) => s.authorization), [blob.permissions.read, blob.permissions.put].map((t) => JSON.parse(t).delegationHeader.Authorization));
    accept = false;
    await assert.rejects(proveInviter(node, blob, OWNER), (e) => e.code === 'inviter-unproven' && e.message.includes('(host)') && !e.message.includes('no parent'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- the command a refusal prints ------------------------------------------------------------------------------------------------------------

test('the command printed with a refusal carries a placeholder, never the owner value the link supplied', async () => {
  const link = await invitation(honest());
  await assert.rejects(
    joinStart(parseArgs(['--stdin']), link, { ctx: async () => ({ profile: profile(), node: {} }), links: standin.config, now: NOW }),
    (e) => {
      assert.equal(e.code, 'inviter-unconfirmed');
      const [facts, command] = e.message.split('then run:');
      assert.ok(facts.includes(OWNER), 'the facts show the owner the link names');
      assert.ok(command.includes('--expect-inviter <did you expect>'));
      assert.equal(command.includes(ADDR) || command.includes('did:pkh'), false, 'the command does not repeat the link\'s own owner');
      return true;
    },
  );
});
