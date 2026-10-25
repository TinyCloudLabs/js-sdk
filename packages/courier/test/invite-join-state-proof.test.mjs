import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { joinResume } from '../dist/invite-commands.js';
import { buildInviteBlob } from '../dist/invite-blob.js';
import { newInviteLinkKey } from '../dist/invite-links.js';
import { parseArgs } from '../dist/args.js';

assert.equal(process.env.COURIER_TEST, '1');
assert.match(process.env.COURIER_TEST_HOME, /^\/var\/tmp\/tc1920\.[A-Za-z0-9]{6}$/);
assert.equal(process.env.HOME, process.env.COURIER_TEST_HOME);

const ROOT = process.env.COURIER_TEST_HOME;
const ID = 'a'.repeat(25) + 'b';
const OWNER = `did:pkh:eip155:1:0x${'a'.repeat(40)}`;
const OTHER = `did:pkh:eip155:1:0x${'b'.repeat(40)}`;
const SPACE = `tinycloud:pkh:eip155:1:0x${'a'.repeat(40)}:agents`;
const HOST = 'https://node.example.test';
const AT = '2026-10-24T12:00:00.000Z';
const blob = buildInviteBlob({
  inviteId: ID, host: HOST, spaceId: SPACE,
  oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) },
  permissions: { put: 'put-grant', read: 'read-grant', hooks: 'hooks-grant' },
  artifactA: { type: 'courier-pair', v: 0, step: 'A', from: { owner: OWNER, courier: 'did:key:z6MkInviter' }, spaceId: SPACE, peer: 'me', callMe: 'inviter', issuedAt: AT },
  expiresAt: new Date('2099-01-01T00:00:00.000Z'), issuer: newInviteLinkKey().signer.did,
  expectEmail: 'me@example.test', expectOwner: null, tier: 'strict', now: Date.parse(AT),
});
const marked = () => ({ v: 1, inviteId: ID, ownerDid: OWNER, proof: { v: 1, inviter: OWNER, at: AT }, blob, helloText: '{"planted":"hello"}', stage: 'hello-ready' });

let home;
let previous;
let serial = 0;
beforeEach(() => {
  home = path.join(ROOT, `join-state-proof-${++serial}`);
  fs.mkdirSync(path.join(home, 'joins'), { recursive: true, mode: 0o700 });
  previous = { HOME: process.env.HOME, COURIER_HOME: process.env.COURIER_HOME };
  process.env.HOME = home;
  process.env.COURIER_HOME = home;
  assert.ok(home.startsWith(ROOT + path.sep));
});
afterEach(() => {
  process.env.HOME = previous.HOME;
  process.env.COURIER_HOME = previous.COURIER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function snapshot(dir) {
  const files = {};
  const visit = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[path.relative(dir, file)] = fs.readFileSync(file).toString('hex');
    }
  };
  visit(dir);
  return files;
}

function fixture(state) {
  const file = path.join(home, 'joins', `${ID}.json`);
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  return file;
}

function run(touched, peers, explicitId = true) {
  const node = new Proxy({}, { get: (_, name) => { touched.push(`node.${String(name)}`); throw new Error('node touched'); } });
  const io = {
    kv: () => { touched.push('kv'); throw new Error('kv touched'); },
    acceptC: async () => { touched.push('acceptC'); throw new Error('acceptC touched'); },
    pollMs: 1, waitMs: 0,
  };
  return joinResume(parseArgs(explicitId ? ['--resume', ID] : ['--resume']), {
    ctx: async () => ({ profile: { host: HOST, ownerDid: OTHER, courierDid: 'did:key:z6MkMe', peers }, node }), io,
  });
}

async function refused(state, explicitId = true) {
  const file = fixture(state);
  const before = snapshot(home);
  const joinBytes = fs.readFileSync(file);
  const touched = [];
  const peers = {};
  await assert.rejects(run(touched, peers, explicitId), (e) => {
    assert.equal(e.code, 'join-state-unproven');
    assert.equal(e.message, 'This join state cannot be verified. Remove the pending join state, then run the join again from the invitation link with --expect-inviter.');
    assert.equal(e.message.includes('planted'), false);
    return true;
  });
  assert.deepEqual(touched, [], 'no node, KV, or acceptC access');
  assert.deepEqual(peers, {}, 'no peer was changed');
  assert.deepEqual(fs.readFileSync(file), joinBytes, 'join file bytes unchanged');
  assert.deepEqual(snapshot(home), before, 'home bytes unchanged');
}

test('legacy join state without proof marker is refused before side effects', () => refused((({ ownerDid, proof, ...legacy }) => legacy)(marked())));
test('join state with unknown proof version is refused before side effects', () => refused({ ...marked(), proof: { ...marked().proof, v: 2 } }));
test('join state whose proof inviter differs from owner is refused before side effects', () => refused({ ...marked(), proof: { ...marked().proof, inviter: OTHER } }));
test('join state with an extra proof key is refused before side effects', () => refused({ ...marked(), proof: { ...marked().proof, extra: 'planted' } }));
test('join state with an extra top-level key is refused before side effects', () => refused({ ...marked(), extra: 'planted' }));
test('planted join file with no proof is refused before side effects, including implicit resume', () => refused({ ...marked(), proof: undefined, helloText: '{"planted":"hello"}' }, false));

test('honest marked join state resumes and sends its hello', async () => {
  const file = fixture(marked());
  const writes = [];
  const node = new Proxy({}, { get: () => { throw new Error('node touched'); } });
  const io = {
    kv: () => ({
      put: async (key, value) => { writes.push([key, value]); return { ok: true, data: { headers: { get: () => null } } }; },
      get: async () => ({ ok: false, error: { code: 'KV_NOT_FOUND', message: 'not found', service: 'kv', meta: { status: 404 } } }),
    }),
    acceptC: async () => { throw new Error('acceptC touched'); },
    pollMs: 1, waitMs: 0,
  };
  await joinResume(parseArgs(['--resume', ID]), { ctx: async () => ({ profile: { host: HOST, ownerDid: OTHER, courierDid: 'did:key:z6MkMe', peers: {} }, node }), io });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], JSON.parse(blob).helloKey);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stage, 'hello-sent');
});
