import { cmd } from './program.js';
import { CourierError } from './errors.js';

/** Where an owner can revoke a delegation; the agent cannot revoke one itself. */
export const REVOKE_URL = 'https://account.tinycloud.xyz/delegations';

/** Error codes that mean "this grant was refused", as opposed to a network, space or usage problem. */
const REFUSAL_CODES: Record<string, true> = {
  'approval-result-invalid': true, 'bad-grant': true, 'grant-too-broad': true, 'grant-incomplete': true, 'grant-too-long': true, 'grant-expired': true,
};

/**
 * The refusal with what the owner needs appended: the refused delegation's CID (not a secret), that nothing was installed or
 * used, that the agent cannot revoke it, and where the owner can. What was too broad or different is already in `error`'s own
 * message (the tuples or fields it names). Anything that is not a refusal comes back unchanged. The delegation header, the
 * SIWE signature and keys are never part of it. `delegationCid` is absent when no delegation could be read from the result.
 */
export function withRefusalNotice(error: unknown, delegationCid: string | undefined): unknown {
  if (!(error instanceof CourierError) || !REFUSAL_CODES[error.code]) return error;
  const next = `Then run \`${cmd('init --request')}\` for a new link.`;
  const notice = delegationCid
    ? `Refused delegation: ${delegationCid}. Nothing was installed or used, and this agent cannot revoke it. If the owner approved it, they can revoke it at ${REVOKE_URL}. ${next}`
    : `Nothing was installed or used. ${next}`;
  return new CourierError(error.code, `${error.message}\n${notice}`);
}
