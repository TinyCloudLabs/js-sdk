import { expect, test } from 'bun:test';
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeDagCbor } from '../../sdk-core/src/delegations/cacao';
import { parseSignedSiweCacao } from '@tinycloud/sdk-core';
import fixture from '../../sdk-core/test-fixtures/siwe-cacao/owner-share.json';
import { verifyOwnerRenewal } from '../src/owner-renewal';
import type { GrantPayload } from '../src/grant';
import type { ApprovalRenewal } from '@tinycloud/share-envelope/links';

const owner = privateKeyToAccount(`0x${fixture.ownerPrivateKey}`);
const payload = { delegationHeader: { Authorization: fixture.delegation.authorization }, delegationCid: fixture.delegation.cid,
  verificationMethod: fixture.delegation.audience } as GrantPayload;
const renewer = 'did:key:z6MkhMmQGm6uMGggZWsMwcXkXFxQFVB4xafKFaQ3eLUPgDLD';
async function receipt(target = fixture.delegation.cid, action = 'renew', audience = renewer, caveat = {}, proofs: string[] = []) {
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const resource = `urn:cid:${target}`;
  const statement = `I further authorize the stated URI to perform the following actions on my behalf: (1) 'tinycloud.delegation': '${action}' for '${resource}'.`;
  const issuedAt = new Date().toISOString();
  const resources = [`urn:recap:${Buffer.from(JSON.stringify({ att: { [resource]: { [`tinycloud.delegation/${action}`]: [caveat] } }, prf: proofs })).toString('base64url')}`];
  const message = new SiweMessage({ domain: 'localhost', address: owner.address, uri: audience, version: '1', chainId: 1,
    nonce: '12345678', issuedAt, expirationTime: expiresAt, statement, resources }).prepareMessage();
  const signature = await owner.signMessage({ message });
  const authorization = Buffer.from(encodeDagCbor({ h: { t: 'eip4361' }, p: { domain: 'localhost', iss: fixture.ownerDid,
    aud: audience, version: 1, nonce: '12345678', iat: issuedAt, exp: expiresAt, statement, resources },
    s: { t: 'eip191', s: new Uint8Array(Buffer.from(signature.slice(2), 'hex')) } })).toString('base64url');
  const lease = await parseSignedSiweCacao(authorization);
  return { version: 1, approvedAt: issuedAt, approvedLeaseLifetimeSeconds: 86400, receipt: {
    originalCid: fixture.delegation.cid, leaseCid: lease.cid, leaseAuthorization: authorization,
    leaseExpiresAt: expiresAt, leaseGeneration: 1,
    nodeIdentity: { nodeDid: renewer, renewerDid: renewer, renewerPublicKey: 'test', renewerEpoch: 0 },
  } } as ApprovalRenewal;
}

test('accepts an owner-signed lease bound to the computed original grant CID', async () => {
  await expect(verifyOwnerRenewal(payload, fixture.ownerDid, await receipt())).resolves.toBeUndefined();
});
test('rejects wrong signed target, action, audience or added caveat', async () => {
  for (const bad of [await receipt('different'), await receipt(undefined, 'list'), await receipt(undefined, undefined, 'did:key:zOther'), await receipt(undefined, undefined, undefined, { limit: 1 })]) {
    await expect(verifyOwnerRenewal(payload, fixture.ownerDid, bad)).rejects.toThrow();
  }
});
test('rejects mismatched receipt CID, signed expiry and original signed bytes CID', async () => {
  const good = await receipt();
  for (const bad of [ { ...good, receipt: { ...good.receipt, originalCid: 'request-body-cid' } },
    { ...good, receipt: { ...good.receipt, leaseExpiresAt: new Date(Date.now() + 1000).toISOString() } },
    { ...good, receipt: { ...good.receipt, leaseCid: fixture.delegation.cid } } ]) {
    await expect(verifyOwnerRenewal(payload, fixture.ownerDid, bad)).rejects.toThrow();
  }
  await expect(verifyOwnerRenewal({ ...payload, delegationCid: 'request-body-cid' }, fixture.ownerDid, good)).rejects.toThrow();
});

test('rejects a correctly signed lease carrying a proof chain', async () => {
  await expect(verifyOwnerRenewal(payload, fixture.ownerDid, await receipt(undefined, undefined, undefined, undefined, [fixture.delegation.cid]))).rejects.toThrow();
});
