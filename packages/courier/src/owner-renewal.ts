import { parseSignedSiweCacao, principalDidEquals, assertRenewalNodeIdentity, type RenewalNodeIdentity } from '@tinycloud/sdk-core';
import { parseApprovalRenewal, type ApprovalRenewal } from '@tinycloud/share-envelope/links';
import { CourierError } from './errors.js';
import type { GrantPayload } from './grant.js';

/** Verify signed material before saving a receipt; live node admission is checked separately by renewal restore. */
export async function verifyOwnerRenewal(payload: GrantPayload, ownerDid: string, renewal: ApprovalRenewal): Promise<void> {
  renewal = parseApprovalRenewal(renewal);
  const original = await parseSignedSiweCacao(payload.delegationHeader.Authorization.replace(/^Bearer\s+/i, ''), payload.delegationCid);
  const { receipt } = renewal;
  const lease = await parseSignedSiweCacao(receipt.leaseAuthorization.replace(/^Bearer\s+/i, ''), receipt.leaseCid);
  const now = Date.now();
  const approved = Date.parse(renewal.approvedAt);
  const originalStart = Date.parse(original.notBefore ?? original.issuedAt);
  const leaseStart = Date.parse(lease.notBefore ?? lease.issuedAt);
  const resource = lease.attenuation[`urn:cid:${original.cid}`];
  const caveats = resource?.['tinycloud.delegation/renew'];
  if (original.proofs.length !== 0 || lease.proofs.length !== 0
    || !Number.isFinite(originalStart) || !Number.isFinite(leaseStart)
    || originalStart > approved + 60_000 || leaseStart > now + 60_000
    || receipt.originalCid !== original.cid || !principalDidEquals(original.issuer, ownerDid)
    || !principalDidEquals(lease.issuer, ownerDid) || !principalDidEquals(original.audience, payload.verificationMethod)
    || lease.audience !== receipt.nodeIdentity.renewerDid
    || Object.keys(lease.attenuation).length !== 1 || !resource || Object.keys(resource).length !== 1
    || !Array.isArray(caveats) || caveats.length !== 1 || !caveats[0] || typeof caveats[0] !== 'object'
    || Array.isArray(caveats[0]) || Object.keys(caveats[0]).length !== 0
    || !lease.expiresAt || new Date(lease.expiresAt).toISOString() !== receipt.leaseExpiresAt
    || !original.expiresAt || Date.parse(renewal.approvedAt) >= Date.parse(original.expiresAt)
    || Date.parse(receipt.leaseExpiresAt) <= Date.now()) {
    throw new CourierError('bad-grant', 'The renewal lease does not match the signed owner grant.');
  }
}

/**
 * The lease's expiry exactly as the owner signed it. Node admission compares it with the signed bytes, which may
 * spell it without the receipt's milliseconds; the receipt's ISO value is checked equal by {@link verifyOwnerRenewal}.
 */
export async function signedLeaseExpiry(renewal: ApprovalRenewal): Promise<string> {
  const { receipt } = parseApprovalRenewal(renewal);
  const lease = await parseSignedSiweCacao(receipt.leaseAuthorization.replace(/^Bearer\s+/i, ''), receipt.leaseCid);
  if (!lease.expiresAt) throw new CourierError('bad-grant', 'The renewal lease does not match the signed owner grant.');
  return lease.expiresAt;
}

export function assertOwnerRenewalIdentity(renewal: ApprovalRenewal, live: RenewalNodeIdentity): void {
  assertRenewalNodeIdentity(live);
  assertRenewalNodeIdentity(renewal.receipt.nodeIdentity);
  const expected = renewal.receipt.nodeIdentity;
  if (live.nodeDid !== expected.nodeDid || live.renewerDid !== expected.renewerDid
    || live.renewerPublicKey !== expected.renewerPublicKey || live.renewerEpoch !== expected.renewerEpoch) {
    throw new CourierError('bad-grant', 'The renewal node identity does not match the verified host.');
  }
}
