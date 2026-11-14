import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { CourierError } from './errors.js';

/** Only the SDK's verified restore can complete a late, already-admitted installation. */
export async function recoverAdmittedRenewal(node: Pick<TinyCloudNode, 'restoreSessionWithRenewal'>,
  session: Parameters<TinyCloudNode['restoreSession']>[0], leaseAuthorization: string): Promise<void> {
  try {
    await node.restoreSessionWithRenewal(session, leaseAuthorization);
  } catch (error) {
    // These are explicit negative lifecycle results from the exact saved grant/lease restore.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'RENEWAL_AUTHORITY_INACTIVE' || code === 'RENEWAL_LEASE_EXPIRED' || code === 'RENEWAL_LEASE_ORIGINAL_EXPIRED') {
      throw new CourierError('renewal-approval-required', 'No live admitted renewal remains for this grant. Fresh owner approval is required.');
    }
    throw new CourierError('renewal-unavailable', 'The saved renewal could not be verified. Retry later; the saved approval is unchanged.');
  }
}

/** Three production scheduler intervals; never admit a new lease too close to original expiry. */
export const RENEWAL_ADMISSION_LEAD_MS = 15 * 60_000;
export function assertRenewalAdmissionLeadTime(expiresAt: Date, now = Date.now()): void {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() - now < RENEWAL_ADMISSION_LEAD_MS) {
    throw new CourierError('renewal-approval-required', 'The original grant is too close to expiry for renewal admission. Fresh owner approval is required.');
  }
}
