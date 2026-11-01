import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { AGENT_GRANT } from '../dist/keys.js';
import { INVITATION_MODES } from '../dist/guided.js';
import { parseInvitation } from '../dist/invitation.js';
import { canonicalInviteEmail, invitationFromShareContent, isShareLink, sendEmailInvitation } from '../dist/email-invitation.js';
import { ownerEncryptionNetwork } from '../dist/authority.js';

const OWNER = 'did:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF';
const SPACE = 'tinycloud:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF:agents';
const manager = new NodeWasmBindings().createSessionManager();
const identity = (label) => {
  const keyId = manager.createSessionKey(label);
  return { did: manager.getDID(keyId).split('#')[0], jwk: JSON.parse(manager.jwk(keyId)) };
};
const issuer = identity('issuer');
const relay = identity('relay');

function body(over = {}) {
  const id = ulid();
  return {
    type: 'courier-invitation', v: 1, id, issuer: issuer.did, host: 'https://node.example', mode: 'email', recipient: 'reader@example.com',
    session: { sessionId: ulid(), subject: 'plan', createdAt: new Date().toISOString() },
    expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toISOString(),
    artifact: { type: 'courier-pair', v: 0, step: 'A', from: { owner: OWNER, courier: issuer.did }, spaceId: SPACE, peer: `chat-${id}-recipient`, callMe: `chat-${id}-issuer`, issuedAt: new Date().toISOString() },
    relay: { key: { v: 1, did: relay.did, jwk: relay.jwk }, delegation: 'x' },
    ...over,
  };
}

test('email mode is a hidden invitation mode: the public list of modes does not change', () => {
  assert.deepEqual([...INVITATION_MODES], ['same-owner', 'anyone', 'named']);
  for (const mode of INVITATION_MODES) {
    const named = { recipient: mode === 'named' ? issuer.did : undefined };
    assert.equal(parseInvitation(body({ mode, ...named })).mode, mode);
  }
});

test('an email invitation names exactly one canonical address', () => {
  assert.equal(parseInvitation(body()).recipient, 'reader@example.com');
  for (const recipient of ['Reader@Example.com', ' reader@example.com', 'a@example.com, b@example.com', 'reader', '', issuer.did]) {
    assert.throws(() => parseInvitation(body({ recipient })), (error) => ['bad-invitation', 'unsupported-recipient'].includes(error.code), JSON.stringify(recipient));
  }
  assert.throws(() => parseInvitation(body({ recipient: undefined })), { code: 'bad-invitation' });
  assert.throws(() => parseInvitation(body({ mode: 'anyone', recipient: 'reader@example.com' })), { code: 'bad-invitation' });
  assert.throws(() => parseInvitation(body({ mode: 'named', recipient: 'reader@example.com' })), { code: 'bad-invitation' });
});

test('canonicalInviteEmail lowercases and refuses anything that is not one plain address', () => {
  assert.equal(canonicalInviteEmail('Reader@Example.com'), 'reader@example.com');
  for (const bad of ['', 'nobody', 'a@b@c.d', 'a@example.com,b@example.com', 'a b@example.com']) {
    assert.throws(() => canonicalInviteEmail(bad), { code: 'unsupported-recipient' }, bad);
  }
});

test('the opened Share content must be an email invitation for the verified mailbox', () => {
  const good = JSON.stringify(body());
  assert.equal(invitationFromShareContent(good, 'reader@example.com').recipient, 'reader@example.com');
  assert.throws(() => invitationFromShareContent(good, 'other@example.com'), { code: 'bad-invitation' });
  assert.throws(() => invitationFromShareContent(JSON.stringify(body({ mode: 'anyone', recipient: undefined })), 'reader@example.com'), { code: 'bad-invitation' });
  assert.throws(() => invitationFromShareContent('not json', 'reader@example.com'), { code: 'bad-invitation' });
  assert.throws(() => invitationFromShareContent(undefined, 'reader@example.com'), { code: 'bad-invitation' });
});

test('join takes a Share link only for /s/ links; Courier links keep their own path', () => {
  assert.equal(isShareLink('https://share.tinycloud.xyz/s/abcdefghijklmnopqrstuvwxyz#v=4&k=x&c=y'), true);
  assert.equal(isShareLink('https://courier.tinycloud.xyz/c/abcdefghijklmnopqrstuvwxyz#v=4&k=x&c=y'), false);
  assert.equal(isShareLink('not a url'), false);
});

function fakeNode(capabilities) {
  const calls = [];
  const trap = (name) => async () => { calls.push(name); throw new Error(`${name} must not run`); };
  return {
    calls,
    node: {
      getVerifiedSessionCapabilities: () => capabilities,
      activeNodeIdentity: trap('activeNodeIdentity'), publishActiveNodeLocation: trap('publishActiveNodeLocation'),
      keys: { createKey: trap('createKey') }, kv: { put: trap('put') },
    },
  };
}
const profile = { ownerDid: OWNER, spaceId: SPACE, courierDid: issuer.did };
const fetchTrap = () => { throw new Error('no network before the authority check'); };

test('no invitation key authority: refused before any key, store, publish or network call', async () => {
  const split = AGENT_GRANT.flatMap((permission) => permission.actions.map((action) => ({ ...permission, actions: [action], caveats: [] })));
  const { node, calls } = fakeNode(split);
  const sent = body();
  const failure = await sendEmailInvitation(node, profile, sent, { fetch: fetchTrap }).then(() => undefined, (error) => error);
  assert.equal(failure?.code, 'invite-authority-missing');
  assert.deepEqual(calls, []);
  // The message itself (not only a caller's wrapper) names what already exists and what was not created.
  assert.match(failure.message, /pairing relay delegation/);
  assert.match(failure.message, new RegExp(`invitation state ${sent.id}`));
  assert.match(failure.message, /no Share key, link or email was created or sent/);
  assert.doesNotMatch(failure.message, /nothing was (created|changed)/i);
});

test('key.create alone, or authority for another share key, is not enough', async () => {
  const network = ownerEncryptionNetwork(OWNER);
  const entry = (path, action) => ({ service: 'tinycloud.encryption', path, actions: [`tinycloud.encryption/${action}`], caveats: [] });
  const shareId = 'c'.repeat(32);
  for (const capabilities of [
    [entry(`${network}/share/`, 'key.create')],
    [entry(`${network}/share/`, 'decrypt')],
    [entry(`${network}/share/${'d'.repeat(32)}`, 'key.create'), entry(`${network}/share/${'d'.repeat(32)}`, 'decrypt')],
  ]) {
    const { node, calls } = fakeNode(capabilities);
    await assert.rejects(sendEmailInvitation(node, profile, body(), { fetch: fetchTrap, shareId: () => shareId }), { code: 'invite-authority-missing' });
    assert.deepEqual(calls, []);
  }
});

test('only an email invitation is sent by email', async () => {
  const { node } = fakeNode([]);
  await assert.rejects(sendEmailInvitation(node, profile, body({ mode: 'anyone', recipient: undefined }), { fetch: fetchTrap }), { code: 'bad-invitation' });
});
