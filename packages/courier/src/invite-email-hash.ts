import { createHash } from 'node:crypto';

/**
 * What an invitation carries in place of the invitee's address: a hash a link holder cannot read the address from, and the invitee (who knows the
 * address) can check. Domain-separated SHA-256, salted with the invite id so the same address hashes differently in every invite:
 *
 *   base64url( SHA-256( "tinycloud.courier.invite-email/v1" 0x00 inviteId 0x00 address ) )
 *
 * `address` is the lowercase, trimmed address as `courier invite --email` normalises it; the compare is exact, as the email proof's is (no dot or
 * plus-alias folding). The result is 43 base64url characters. This is not a secret: anyone with the link can test a guessed address against it.
 */
export const EMAIL_HASH_DOMAIN = 'tinycloud.courier.invite-email/v1';

export function inviteEmailHash(inviteId: string, address: string): string {
  return createHash('sha256').update(EMAIL_HASH_DOMAIN).update('\0').update(inviteId).update('\0').update(address).digest('base64url');
}

