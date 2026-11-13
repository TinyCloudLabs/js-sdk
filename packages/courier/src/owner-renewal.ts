import type { RenewalNodeIdentity } from '@tinycloud/sdk-core';
import { assertOwnerRenewalNodeIdentity, RENEWAL_LEASE_MISMATCH, verifyOwnerRenewalLease } from '@tinycloud/sdk-core/delegations/renewal-receipt';
import { parseApprovalRenewal, type ApprovalRenewal } from '@tinycloud/share-envelope/links';
import { CourierError } from './errors.js';
import type { GrantPayload } from './grant.js';

function asCourierError(error: unknown): unknown {
  return error instanceof Error && 'code' in error && error.code === RENEWAL_LEASE_MISMATCH
    ? new CourierError('bad-grant', error.message)
    : error;
}

/** Verify signed material before saving a receipt; live node admission is checked separately by renewal restore. */
export async function verifyOwnerRenewal(payload: GrantPayload, ownerDid: string, renewal: ApprovalRenewal): Promise<void> {
  try { await verifyOwnerRenewalLease(payload, ownerDid, parseApprovalRenewal(renewal)); }
  catch (error) { throw asCourierError(error); }
}

export function assertOwnerRenewalIdentity(renewal: ApprovalRenewal, live: RenewalNodeIdentity): void {
  try { assertOwnerRenewalNodeIdentity(renewal, live); }
  catch (error) { throw asCourierError(error); }
}
