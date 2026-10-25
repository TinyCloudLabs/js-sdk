import { createHash } from 'node:crypto';

/**
 * The invitee address is stored as a salted hash: domain-separated SHA-256, salted with the invite id:
 *
 *   base64url( SHA-256( "tinycloud.courier.invite-email/v1" 0x00 inviteId 0x00 address ) )
 *
 * `address` is the lowercase, trimmed address as `courier invite --email` normalises it; the compare is exact, as the email proof's is (no dot or
 * plus-alias folding). The result is 43 base64url characters.
 */
export const EMAIL_HASH_DOMAIN = 'tinycloud.courier.invite-email/v1';

export function inviteEmailHash(inviteId: string, address: string): string {
  return createHash('sha256').update(EMAIL_HASH_DOMAIN).update('\0').update(inviteId).update('\0').update(address).digest('base64url');
}

