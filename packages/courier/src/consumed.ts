import { CourierError, type ResultLike } from './errors.js';
import { k } from './keys.js';
import { putCreate } from './store.js';
import type { KV } from './inbox.js';

/**
 * Delete-proof "this approval was used" record (spec §7, one request = one approval).
 *
 * The courier key holds only get/list/put on `me/consumed/` (`AGENT_GRANT`), never del. A put can overwrite a
 * marker's value but cannot remove the key, so the key's PRESENCE is the signal, whatever it contains. Only a
 * key-level 404 means "unused"; every other outcome (transport error, 5xx, 401/403, space 404, odd body) is an
 * error and callers must fail closed.
 */

/** A 404 for the key itself. A missing space also answers 404 and must NOT read as "unused". */
function isKeyMissing(error: NonNullable<ResultLike<unknown>['error']>): boolean {
  const status = String(error.status ?? error.meta?.status ?? '');
  const code = String(error.code ?? '');
  const message = String(error.message ?? '');
  if (/space/i.test(message)) return false;
  return code === 'KV_NOT_FOUND' || status === '404' || code === '404';
}

/**
 * True if the marker for approval `id` exists. Reads from the network every time (`source: 'network'` bypasses the
 * replica read-through; the raw body is never parsed, so unparsable or overwritten content still counts) and keeps no
 * cache or ETag of its own. Throws CourierError('approval-state-unknown') unless the answer is a clean hit or a clean
 * key-level 404.
 */
export async function isConsumed(kv: KV, id: string): Promise<boolean> {
  let result: ResultLike<unknown>;
  try {
    result = (await kv.get(k.approvalUsed(id), { prefix: '', source: 'network', raw: true })) as ResultLike<unknown>;
  } catch (error) {
    throw new CourierError('approval-state-unknown', `Could not read the used-marker for approval ${id}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
  }
  if (result && typeof result === 'object' && result.ok === true) return true;
  if (result && typeof result === 'object' && result.ok === false && result.error && isKeyMissing(result.error)) return false;
  const why = result?.error ? `${String(result.error.code ?? result.error.status ?? '')} ${String(result.error.message ?? '')}`.trim() : 'unexpected response';
  throw new CourierError('approval-state-unknown', `Could not tell whether approval ${id} was used (${why.slice(0, 200)}); treating it as unusable.`);
}

/** Records approval `id` as used. Create-only: of two racing callers exactly one wins; the loser gets 'approval-used'. */
export async function markConsumed(kv: KV, id: string, at = new Date()): Promise<void> {
  try {
    await putCreate(kv, k.approvalUsed(id), { requestId: id, usedAt: at.toISOString() });
  } catch (error) {
    if (error instanceof CourierError && error.code === 'conflict') {
      throw new CourierError('approval-used', `Approval ${id} was already used; an approval covers one action.`);
    }
    throw error;
  }
}
