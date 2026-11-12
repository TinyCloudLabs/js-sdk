import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { canonicalize } from '@tinycloud/share-envelope';
import { AddressedContentSourceError, assertPathBoundContentSource, pathBoundStoredBytes, wrappedKeyDigestHex } from '@tinycloud/share-sdk';
import { sealInvitationContent } from '../dist/email-invitation.js';

const OWNER = 'did:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF';
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const SPACE = 'tinycloud:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF:agents';
const SHARE_ID = randomBytes(16).toString('hex');
const id = ulid();
const body = {
  type: 'courier-invitation', v: 1, id, issuer: 'did:key:z6MkIssuer', host: 'https://node.example', mode: 'email', recipient: 'reader@example.com',
  session: { sessionId: ulid(), subject: 'plan', createdAt: new Date().toISOString() }, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const path = `xyz.tinycloud.courier/to/invite-${id}/envelope/${SHARE_ID}.json`;

/** What the node-sdk's `keys.encrypt` returns for a named key: a v2 envelope wrapped to that key (a stub for the wrapping only). */
function v2Envelope(keyPath) {
  const encryptedSymmetricKey = randomBytes(48).toString('base64');
  return {
    v: 2, networkId: NETWORK, keyPath, alg: 'x25519-aes256gcm/v1', keyVersion: 1, encryptedSymmetricKey,
    encryptedSymmetricKeyHash: createHash('sha256').update(canonicalize(encryptedSymmetricKey)).digest('hex'),
    ciphertext: randomBytes(64).toString('base64'), metadata: { contentType: 'application/json' },
  };
}

const nodeWith = (encrypt) => ({ getDefaultEncryptionNetworkId: () => NETWORK, keys: { encrypt } });

test('the invitation is sealed with keys.encrypt under its own share key and bound as a path-bound source the publisher accepts', async () => {
  const calls = [];
  const node = nodeWith(async (keyPath, bytes, options) => { calls.push({ keyPath, options, text: new TextDecoder().decode(bytes) }); return v2Envelope(keyPath); });
  const sealed = await sealInvitationContent(node, SPACE, body, SHARE_ID, path);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].keyPath, `share/${SHARE_ID}`);
  assert.deepEqual(calls[0].options, { networkId: NETWORK, metadata: { contentType: 'application/json' } });
  assert.equal(JSON.parse(calls[0].text).id, id, 'the invitation body is what is encrypted');
  // The publisher's own gate (the one every addressed publish passes): bound to this share's key with the raw wrapped-key digest.
  assert.doesNotThrow(() => assertPathBoundContentSource(sealed.contentSource, SHARE_ID));
  assert.equal(sealed.contentSource.encryptionKeyPath, `share/${SHARE_ID}`);
  assert.equal(sealed.contentSource.kvResource, `${SPACE}/kv/${path}`);
  assert.equal(sealed.contentSource.encryptedSymmetricKeyDigestHex, wrappedKeyDigestHex(JSON.parse(Buffer.from(sealed.storedBytes).toString()).encryptedSymmetricKey));
  assert.deepEqual(sealed.storedBytes, pathBoundStoredBytes(JSON.parse(Buffer.from(sealed.storedBytes).toString())), 'the stored bytes are exactly the canonical v2 envelope');
});

test('an envelope that is not a v2 named-key envelope (a network-key envelope with a key path) is refused before anything is stored', async () => {
  // The shape the old sender produced with encryptToNetwork(..., { keyPath }): a version-1 envelope wrapped to the network key.
  const node = nodeWith(async (keyPath) => ({ ...v2Envelope(keyPath), v: 1 }));
  await assert.rejects(sealInvitationContent(node, SPACE, body, SHARE_ID, path), (error) => error instanceof AddressedContentSourceError && error.code === 'envelope-invalid');
});

test('an envelope for another key is refused', async () => {
  const node = nodeWith(async () => v2Envelope(`share/${randomBytes(16).toString('hex')}`));
  await assert.rejects(sealInvitationContent(node, SPACE, body, SHARE_ID, path), (error) => error instanceof AddressedContentSourceError && error.code === 'key-path-mismatch');
});
