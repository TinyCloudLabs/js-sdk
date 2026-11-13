import { expect, test } from 'bun:test';
import { recoverAdmittedRenewal } from '../src/renewal-recovery';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
const session = { delegationCid: 'exact-saved-original' } as Parameters<TinyCloudNode['restoreSession']>[0];
test('completes only through successful verified restore of the exact saved pair', async () => {
  let seen: unknown[] = [];
  await recoverAdmittedRenewal({ restoreSessionWithRenewal: async (...args) => { seen = args; } }, session, 'exact-saved-lease');
  expect(seen).toEqual([session, 'exact-saved-lease']);
});
test('explicit absent/revoked/expired authority requires fresh approval', async () => {
  for (const message of ['Node reports no active renewal authority', 'Node reports no live admitted renewal authority.', 'Renewal lease has expired']) {
    await expect(recoverAdmittedRenewal({ restoreSessionWithRenewal: async () => { throw new Error(message); } }, session, 'lease')).rejects.toMatchObject({ code: 'renewal-approval-required' });
  }
});
test('unknown and unavailable never count as live or request another approval', async () => {
  await expect(recoverAdmittedRenewal({ restoreSessionWithRenewal: async () => { throw new Error('network unavailable'); } }, session, 'lease')).rejects.toMatchObject({ code: 'renewal-unavailable' });
});
