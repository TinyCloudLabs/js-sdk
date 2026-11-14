import { parseSignedSiweCacao, type RenewalNodeIdentity } from '@tinycloud/sdk-core';
import { assertOwnerRenewalNodeIdentity, RENEWAL_LEASE_MISMATCH, verifyOwnerRenewalLease } from '@tinycloud/sdk-core/delegations/renewal-receipt';
import { parseApprovalRenewal, type ApprovalRenewal } from '@tinycloud/share-envelope/links';
import { CourierError } from './errors.js';
import type { GrantPayload } from './grant.js';
import { cmd } from './program.js';

/** The shared verifier's messages are technical; the owner sees what happened and what to do next. */
function asCourierError(error: unknown, message: string): unknown {
  return error instanceof Error && 'code' in error && error.code === RENEWAL_LEASE_MISMATCH
    ? new CourierError('bad-grant', message)
    : error;
}

/** Verify signed material before saving a receipt; live node admission is checked separately by renewal restore. */
export async function verifyOwnerRenewal(payload: GrantPayload, ownerDid: string, renewal: ApprovalRenewal): Promise<void> {
  try { await verifyOwnerRenewalLease(payload, ownerDid, parseApprovalRenewal(renewal)); }
  catch (error) {
    throw asCourierError(error, `This renewal doesn't match the permission you approved, so it wasn't turned on. Run \`${cmd('init')}\` and approve again in OpenKey.`);
  }
}

/**
 * The lease's expiry exactly as the owner signed it. Node admission compares it with the signed bytes, which may
 * spell it without the receipt's milliseconds; the receipt's ISO value is checked equal by {@link verifyOwnerRenewal}.
 */
export async function signedLeaseExpiry(renewal: ApprovalRenewal): Promise<string> {
  const { receipt } = parseApprovalRenewal(renewal);
  const lease = await parseSignedSiweCacao(receipt.leaseAuthorization.replace(/^Bearer\s+/i, ''), receipt.leaseCid);
  if (!lease.expiresAt) throw new CourierError('bad-grant', `This renewal doesn't match the permission you approved, so it wasn't turned on. Run \`${cmd('init')}\` and approve again in OpenKey.`);
  return lease.expiresAt;
}

export function assertOwnerRenewalIdentity(renewal: ApprovalRenewal, live: RenewalNodeIdentity): void {
  try { assertOwnerRenewalNodeIdentity(renewal, live); }
  catch (error) {
    throw asCourierError(error, `This renewal names a different TinyCloud node than the one you approved, so it wasn't turned on. Run \`${cmd('init')}\` and approve again in OpenKey.`);
  }
}
