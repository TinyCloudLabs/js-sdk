import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { parseArgs } from '../dist/args.js';
import { ownerEncryptionNetwork } from '../dist/authority.js';
import { AGENT_GRANT, PREFIX } from '../dist/keys.js';
import { sessionKey } from '../dist/guided.js';
import { cmdInvite } from '../dist/invitation.js';
import { saveProfile } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

const OWNER = 'did:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF';
const SPACE = 'tinycloud:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF:agents';
const manager = new NodeWasmBindings().createSessionManager();
const courierDid = manager.getDID(manager.createSessionKey('issuer')).split('#')[0];
const split = AGENT_GRANT.flatMap((permission) => permission.actions.map((action) => ({ ...permission, actions: [action], caveats: [] })));
const exactKey = (shareId) => ['key.create', 'decrypt'].map((action) => ({
  service: 'tinycloud.encryption', path: `${ownerEncryptionNetwork(OWNER)}/share/${shareId}`, actions: [`tinycloud.encryption/${action}`], caveats: [],
}));
const SHARE_X = 'a'.repeat(32);
const SHARE_Y = 'b'.repeat(32);

/** A profile on disk, one stored session and a node that records every call that could create a relay or Share artifact. */
function setup(capabilities = split) {
  saveProfile({
    version: 3, host: 'https://node.example', openkeyHost: 'https://openkey.so', label: 'issuer', courierDid, ownerDid: OWNER, spaceId: SPACE,
    grantExpiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), status: 'ready', peers: {},
  });
  const kv = memoryKv();
  const sessionId = ulid();
  kv.rows.set(sessionKey(sessionId), { value: { sessionId, subject: 'plan', createdAt: new Date().toISOString() }, etag: 'e0' });
  const calls = [];
  const trap = (name) => async () => { calls.push(name); throw new Error(`${name} must not run`); };
  const node = {
    kv,
    getVerifiedSessionCapabilities: () => capabilities,
    async delegateTo(audience, permissions) {
      calls.push('delegateTo');
      return { delegation: { cid: 'bafyrelay', delegateDID: audience, expiry: new Date(Date.now() + 3_600_000), spaceId: SPACE, delegationHeader: { Authorization: 'Bearer relay' }, permissions } };
    },
    activeNodeIdentity: trap('activeNodeIdentity'), publishActiveNodeLocation: trap('publishActiveNodeLocation'),
    keys: { createKey: trap('createKey') }, encryption: { encryptToNetwork: trap('encryptToNetwork') },
    registerPolicy: trap('registerPolicy'), authorizeShareDeliveryV3: trap('authorizeShareDeliveryV3'),
  };
  const argv = (extra = []) => parseArgs(['--session', sessionId, '--mode', 'email', '--recipient', 'Reader@Example.com', '--consent', ...extra]);
  return { kv, node, calls, argv };
}

const inviteState = (kv) => [...kv.rows.keys()].filter((key) => key.startsWith(`${PREFIX}/me/state/invitations/`));
const fetchTrap = globalThis.fetch;

async function run(fn) {
  globalThis.fetch = () => { throw new Error('no network in this test'); };
  try { return await fn(); } finally { globalThis.fetch = fetchTrap; }
}

for (const [name, capabilities] of [
  ['no invitation-key authority', split],
  ['authority for a different exact key', [...split, ...exactKey(SHARE_Y)]],
  ['key.create alone on the generated key', [...split, exactKey(SHARE_X)[0]]],
]) {
  test(`cmdInvite --mode email with ${name}: refused before anything is created`, async () => {
    const { kv, node, calls, argv } = setup(capabilities);
    let generated = 0;
    const failure = await run(() => cmdInvite(argv(), { node: async () => node, shareId: () => { generated += 1; return SHARE_X; } }).then(() => undefined, (error) => error));
    assert.equal(failure?.code, 'invite-authority-missing');
    assert.equal(generated, 1, 'the share id is generated once, before the check');
    // The check comes first: no relay delegation, no invitation state, nothing of the Share path.
    assert.deepEqual(calls, []);
    assert.deepEqual(inviteState(kv), []);
    assert.match(failure.message, /nothing was created/);
    assert.match(failure.message, /pairing relay delegation, invitation state, Share key, link or email/);
  });
}

test('cmdInvite --mode email with authority for the generated key: relay and state are created after the check, and the same id reaches the Share step', async () => {
  const { kv, node, calls, argv } = setup([...split, ...exactKey(SHARE_X)]);
  const seen = [];
  let generated = 0;
  const deps = {
    node: async () => node,
    shareId: () => { generated += 1; return SHARE_X; },
    send: async (sentNode, _profile, body, sendDeps) => { calls.push('send'); seen.push({ node: sentNode, id: sendDeps.shareId(), invitation: body.id, mode: body.mode, recipient: body.recipient }); },
  };
  const failure = await run(() => cmdInvite(argv(['--wait', '1']), deps).then(() => undefined, (error) => error));
  // After sending, the command serves the invitation; with no claimant it ends pending, which proves it got that far.
  assert.equal(failure?.code, 'invite-pending');
  assert.equal(generated, 1, 'one share id for the whole invitation');
  assert.deepEqual(calls, ['delegateTo', 'send'], 'the relay is issued after the authority check and before the Share step');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].node, node);
  assert.equal(seen[0].id, SHARE_X, 'the Share step uses the id the authority was checked for');
  assert.equal(seen[0].mode, 'email');
  assert.equal(seen[0].recipient, 'reader@example.com');
  const [stateKey] = inviteState(kv);
  assert.equal(inviteState(kv).length, 1);
  assert.ok(stateKey.endsWith(`${seen[0].invitation}.json`));
  assert.equal(kv.rows.get(stateKey).value.link, undefined, 'no link is stored');
});
