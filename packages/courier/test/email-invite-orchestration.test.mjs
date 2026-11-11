import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { CourierError } from '../dist/errors.js';
import { parseArgs } from '../dist/args.js';
import { ownerEncryptionNetwork } from '../dist/authority.js';
import { AGENT_GRANT, PREFIX } from '../dist/keys.js';
import { sessionKey } from '../dist/guided.js';
import { runInvite as cmdInvite } from '../dist/invitation.js';
import { saveKey, saveProfile } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

const OWNER = 'did:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF';
const SPACE = 'tinycloud:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF:agents';
const manager = new NodeWasmBindings().createSessionManager();
const issuerKeyId = manager.createSessionKey('issuer');
const courierDid = manager.getDID(issuerKeyId).split('#')[0];
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
  saveKey({ v: 1, did: courierDid, jwk: JSON.parse(manager.jwk(issuerKeyId)), createdAt: new Date().toISOString() });
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

// Every email send asks the owner for its own approval: no session authority, injected key id or earlier grant stands in for it.
const approvalThat = (behaviour) => ({
  asked: [],
  async create(input) { this.asked.push(input.context); if (behaviour === 'unavailable') throw new CourierError('approval-unavailable', 'unreachable'); return { approvalUrl: 'https://openkey.example/a/x', transport: { requestId: 'r'.repeat(26), bodyCid: 'bafy' } }; },
  async poll() { return behaviour === 'denied' ? { status: 'denied' } : { status: 'pending' }; },
});

for (const [name, capabilities, behaviour, code] of [
  ['an approver that cannot be reached', split, 'unavailable', 'invite-authority-missing'],
  ['a refused approval', split, 'denied', 'invite-authority-missing'],
  ['an approval still pending', split, 'pending', 'invite-approval-pending'],
  ['an approval still pending although the session already names an exact key', [...split, ...exactKey(SHARE_X)], 'pending', 'invite-approval-pending'],
  ['an approval still pending although the session names a different exact key', [...split, ...exactKey(SHARE_Y)], 'pending', 'invite-approval-pending'],
]) {
  test(`cmdInvite --mode email with ${name}: nothing is created or sent`, async () => {
    const { kv, node, calls, argv } = setup(capabilities);
    const approval = approvalThat(behaviour);
    const failure = await run(() => cmdInvite(argv(['--wait', '1']), { node: async () => node, approval, send: async () => { calls.push('send'); } }).then(() => undefined, (error) => error));
    assert.equal(failure?.code, code);
    assert.equal(approval.asked.length, 1, 'the owner is asked for this invitation');
    // No relay delegation, no invitation state, nothing of the Share path.
    assert.deepEqual(calls, []);
    assert.deepEqual(inviteState(kv), []);
    assert.match(failure.message, /nothing was created|nothing has been created or sent/);
  });
}
