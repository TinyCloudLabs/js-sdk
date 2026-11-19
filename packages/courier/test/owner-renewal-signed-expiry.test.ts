import { expect, test } from 'bun:test';
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeDagCbor } from '../../sdk-core/src/delegations/cacao';
import { parseSignedSiweCacao } from '@tinycloud/sdk-core';
import fixture from '../../sdk-core/test-fixtures/siwe-cacao/owner-share.json';
import { signedLeaseExpiry, verifyOwnerRenewal } from '../src/owner-renewal';
import type { GrantPayload } from '../src/grant';
import type { ApprovalRenewal } from '@tinycloud/share-envelope/links';

// A lease whose expiry is signed in whole seconds ("…:05Z") while its receipt carries the ISO form ("…:05.000Z").
const owner = privateKeyToAccount(`0x${fixture.ownerPrivateKey}`);
const payload = { delegationHeader: { Authorization: fixture.delegation.authorization }, delegationCid: fixture.delegation.cid,
  verificationMethod: fixture.delegation.audience } as GrantPayload;
const renewer = 'did:key:z6MkhMmQGm6uMGggZWsMwcXkXFxQFVB4xafKFaQ3eLUPgDLD';

async function wholeSecondLease() {
  const end = new Date(Date.now() + 86_400_000);
  end.setUTCMilliseconds(0);
  const receiptEnd = end.toISOString();
  const signedEnd = receiptEnd.replace('.000Z', 'Z');
  const resource = `urn:cid:${fixture.delegation.cid}`;
  const statement = `I further authorize the stated URI to perform the following actions on my behalf: (1) 'tinycloud.delegation': 'renew' for '${resource}'.`;
  const issuedAt = new Date().toISOString();
  const resources = [`urn:recap:${Buffer.from(JSON.stringify({ att: { [resource]: { 'tinycloud.delegation/renew': [{}] } }, prf: [] })).toString('base64url')}`];
  const message = new SiweMessage({ domain: 'localhost', address: owner.address, uri: renewer, version: '1', chainId: 1,
    nonce: '12345678', issuedAt, expirationTime: signedEnd, statement, resources }).prepareMessage();
  const signature = await owner.signMessage({ message });
  const authorization = Buffer.from(encodeDagCbor({ h: { t: 'eip4361' }, p: { domain: 'localhost', iss: fixture.ownerDid,
    aud: renewer, version: 1, nonce: '12345678', iat: issuedAt, exp: signedEnd, statement, resources },
    s: { t: 'eip191', s: new Uint8Array(Buffer.from(signature.slice(2), 'hex')) } })).toString('base64url');
  const lease = await parseSignedSiweCacao(authorization);
  const renewal = { version: 1, approvedAt: issuedAt, approvedLeaseLifetimeSeconds: 86400, receipt: {
    originalCid: fixture.delegation.cid, leaseCid: lease.cid, leaseAuthorization: authorization, leaseExpiresAt: receiptEnd, leaseGeneration: 1,
    nodeIdentity: { nodeDid: renewer, renewerDid: renewer, renewerPublicKey: 'test', renewerEpoch: 0 },
  } } as ApprovalRenewal;
  return { renewal, signedEnd, receiptEnd };
}

test('a lease signed with a whole-second expiry verifies, and is admitted with the value exactly as signed', async () => {
  const { renewal, signedEnd, receiptEnd } = await wholeSecondLease();
  expect(signedEnd).not.toBe(receiptEnd);
  await expect(verifyOwnerRenewal(payload, fixture.ownerDid, renewal)).resolves.toBeUndefined();
  expect(await signedLeaseExpiry(renewal)).toBe(signedEnd);
});
