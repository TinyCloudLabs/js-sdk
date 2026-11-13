// Courier turns only the shared verifier's lease mismatches into its owner-facing errors; anything else passes through.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { bases } from 'multiformats/basics';
import { assertOwnerRenewalIdentity, verifyOwnerRenewal } from '../dist/owner-renewal.js';
import { CourierError } from '../dist/errors.js';

const fixture = JSON.parse(readFileSync(new URL('../../sdk-core/test-fixtures/siwe-cacao/owner-share.json', import.meta.url), 'utf8'));
const payload = { delegationHeader: { Authorization: fixture.delegation.authorization }, delegationCid: fixture.delegation.cid, verificationMethod: fixture.delegation.audience };
function identity(epoch = 0) {
  const publicKey = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  const did = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...publicKey]))}`;
  return { nodeDid: did, renewerDid: did, renewerPublicKey: Buffer.from(publicKey).toString('base64url'), renewerEpoch: epoch };
}
const approvedAt = new Date(Date.now() - 1000).toISOString();
// A real signed CACAO that is not a renew lease: the verifier parses it, then finds it does not match.
const notALease = { version: 1, approvedAt, approvedLeaseLifetimeSeconds: 86400, receipt: {
  originalCid: fixture.delegation.cid, leaseCid: fixture.delegation.cid, leaseAuthorization: fixture.delegation.authorization,
  leaseExpiresAt: new Date(Date.parse(approvedAt) + 3_600_000).toISOString(), leaseGeneration: 1, nodeIdentity: identity() } };

test('a lease that does not match the approved grant names the owner\'s next step', async () => {
  await assert.rejects(verifyOwnerRenewal(payload, fixture.ownerDid, notALease), (error) => error instanceof CourierError && error.code === 'bad-grant'
    && error.message === "This renewal doesn't match the permission you approved, so it wasn't turned on. Run `courier init` and approve again in OpenKey.");
});

test('a renewal that is not even well-formed is passed on, not reworded as a mismatch', async () => {
  await assert.rejects(verifyOwnerRenewal(payload, fixture.ownerDid, { version: 1 }), (error) => !(error instanceof CourierError));
});

test('a different renewer epoch on the live node names the owner\'s next step', () => {
  const saved = identity(0);
  assert.throws(() => assertOwnerRenewalIdentity({ ...notALease, receipt: { ...notALease.receipt, nodeIdentity: saved } }, { ...saved, renewerEpoch: 1 }),
    (error) => error instanceof CourierError && error.code === 'bad-grant'
      && error.message === "This renewal names a different TinyCloud node than the one you approved, so it wasn't turned on. Run `courier init` and approve again in OpenKey.");
});

test('a malformed live identity is passed on, not reworded as a mismatch', () => {
  const saved = identity(0);
  assert.throws(() => assertOwnerRenewalIdentity({ ...notALease, receipt: { ...notALease.receipt, nodeIdentity: saved } }, { ...saved, nodeDid: 'did:key:zbad' }),
    (error) => !(error instanceof CourierError));
});
