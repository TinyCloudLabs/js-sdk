import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { parseArgs } from '../dist/args.js';
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

/** A profile on disk, one stored session and a node that records every call that could create a Share artifact. */
function setup() {
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
    getVerifiedSessionCapabilities: () => split,
    async delegateTo(audience, permissions) {
      calls.push('delegateTo');
      return { delegation: { cid: 'bafyrelay', delegateDID: audience, expiry: new Date(Date.now() + 3_600_000), spaceId: SPACE, delegationHeader: { Authorization: 'Bearer relay' }, permissions } };
    },
    activeNodeIdentity: trap('activeNodeIdentity'), publishActiveNodeLocation: trap('publishActiveNodeLocation'),
    keys: { createKey: trap('createKey') }, encryption: { encryptToNetwork: trap('encryptToNetwork') },
    registerPolicy: trap('registerPolicy'), authorizeShareDeliveryV3: trap('authorizeShareDeliveryV3'),
  };
  return { kv, node, sessionId, calls };
}

const inviteState = (kv) => [...kv.rows.keys()].filter((key) => key.startsWith(`${PREFIX}/me/state/invitations/`));
const fetchTrap = globalThis.fetch;

test('cmdInvite --mode email without invitation-key authority: precise error, and exactly the side effects it names', async () => {
  const { kv, node, sessionId, calls } = setup();
  globalThis.fetch = () => { throw new Error('no network before the authority check'); };
  try {
    const failure = await cmdInvite(parseArgs(['--session', sessionId, '--mode', 'email', '--recipient', 'Reader@Example.com', '--consent']), { node: async () => node }).then(() => undefined, (error) => error);
    assert.equal(failure?.code, 'invite-authority-missing');
    // What WAS created before the check: the pairing relay delegation and the persisted invitation state.
    assert.deepEqual(calls, ['delegateTo']);
    const [stateKey] = inviteState(kv);
    assert.equal(inviteState(kv).length, 1);
    const state = kv.rows.get(stateKey).value;
    assert.equal(state.body.mode, 'email');
    assert.equal(state.body.recipient, 'reader@example.com');
    assert.equal(state.link, undefined, 'no link is stored');
    assert.ok(stateKey.endsWith(`${state.body.id}.json`));
    // What was NOT created: no Share key, envelope, policy, link or email (every one of those calls is a trap).
    assert.deepEqual([...kv.rows.keys()].filter((key) => key.includes('/envelope/')), []);
    // The message says exactly that, and does not claim that nothing was created.
    assert.match(failure.message, /pairing relay delegation/);
    assert.match(failure.message, new RegExp(`invitation state ${state.body.id}`));
    assert.match(failure.message, /no Share key, link or email was created or sent/);
    assert.doesNotMatch(failure.message, /nothing was (created|changed)/i);
  } finally {
    globalThis.fetch = fetchTrap;
  }
});
