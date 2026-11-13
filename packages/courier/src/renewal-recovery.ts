import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { CourierError } from './errors.js';

/** Only the SDK's verified restore can complete a late, already-admitted installation. */
export async function recoverAdmittedRenewal(node: Pick<TinyCloudNode, 'restoreSessionWithRenewal'>,
  session: Parameters<TinyCloudNode['restoreSession']>[0], leaseAuthorization: string): Promise<void> {
  try {
    await node.restoreSessionWithRenewal(session, leaseAuthorization);
  } catch (error) {
    // These are explicit negative lifecycle results from the exact saved grant/lease restore.
    const message = error instanceof Error ? error.message : '';
    if (message === 'Node reports no active renewal authority' || message === 'Node reports no live admitted renewal authority.' || message === 'Renewal lease has expired') {
      throw new CourierError('renewal-approval-required', 'No live admitted renewal remains for this grant. Fresh owner approval is required.');
    }
    throw new CourierError('renewal-unavailable', 'The saved renewal could not be verified. Retry later; the saved approval is unchanged.');
  }
}
