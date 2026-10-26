import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { base58btc, ed25519DidKey, ed25519PublicKeyOfDidKey } from '../dist/did-key.js';

test('base58btc matches the reference vector and keeps leading zeros as 1s', () => {
  assert.equal(base58btc(Buffer.from('Hello World')), 'JxF12TrwUP45BMd');
  assert.equal(base58btc(Uint8Array.of(0, 0, 1)), '112');
});

test('ed25519DidKey agrees with the SDK-derived DID for a freshly generated key', () => {
  const manager = new NodeWasmBindings().createSessionManager();
  const id = manager.createSessionKey('courier');
  const jwk = JSON.parse(manager.jwk(id));
  const sdkDid = manager.getDID(id);
  // The SDK appends a `#<key-id>` fragment; the bare DID must match it and decode to the same key.
  assert.equal(ed25519DidKey(jwk.x), sdkDid.split('#')[0]);
  assert.deepEqual(ed25519PublicKeyOfDidKey(sdkDid), Buffer.from(jwk.x, 'base64url'));
});

test('ed25519DidKey rejects a public key that is not 32 bytes', () => {
  assert.throws(() => ed25519DidKey(Buffer.alloc(31).toString('base64url')), /32 bytes/);
});
