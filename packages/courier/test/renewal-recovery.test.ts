import { expect, test } from 'bun:test';
import { assertRenewalAdmissionLeadTime, recoverAdmittedRenewal } from '../src/renewal-recovery';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
const session = { delegationCid: 'exact-saved-original' } as Parameters<TinyCloudNode['restoreSession']>[0];
test('completes only through successful verified restore of the exact saved pair', async () => {
  let seen: unknown[] = [];
  await recoverAdmittedRenewal({ restoreSessionWithRenewal: async (...args) => { seen = args; } }, session, 'exact-saved-lease');
  expect(seen).toEqual([session, 'exact-saved-lease']);
});
test('explicit absent/revoked/expired authority requires fresh approval', async () => {
  for (const code of ['RENEWAL_AUTHORITY_INACTIVE', 'RENEWAL_LEASE_EXPIRED', 'RENEWAL_LEASE_ORIGINAL_EXPIRED']) {
    await expect(recoverAdmittedRenewal({ restoreSessionWithRenewal: async () => { throw Object.assign(new Error('wording may change'), { code }); } }, session, 'lease')).rejects.toMatchObject({ code: 'renewal-approval-required' });
  }
});
test('unknown and unavailable never count as live or request another approval', async () => {
  await expect(recoverAdmittedRenewal({ restoreSessionWithRenewal: async () => { throw new Error('network unavailable'); } }, session, 'lease')).rejects.toMatchObject({ code: 'renewal-unavailable' });
});

test('fresh admission requires the full fifteen-minute scheduler margin', () => {
  const now = 1_800_000_000_000;
  expect(() => assertRenewalAdmissionLeadTime(new Date(now + 900_000), now)).not.toThrow();
  expect(() => assertRenewalAdmissionLeadTime(new Date(now + 899_999), now)).toThrow();
  expect(() => assertRenewalAdmissionLeadTime(new Date(now - 1), now)).toThrow();
});
