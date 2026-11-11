import { createHash } from 'node:crypto';

/**
 * The node's KV as Courier sees it: bodies stored as JSON text, a content-hash etag (the node's is BLAKE3 of the
 * bytes), if-match/if-none-match answered 412. `fault(key, kind)` makes the next put of `key`:
 * - 'unsent': fail before reaching the node;
 * - 'lost-reply': apply, then lose the reply;
 * - 'retried-after-applied': apply, then answer 412, as the SDK's retry of a 503 does when the first attempt had
 *   been applied.
 */
export function nodeKv() {
  const rows = new Map();
  const faults = [];
  const etagOf = (text) => `"sha256-${createHash('sha256').update(text).digest('hex')}"`;
  const lost = { ok: false, error: { code: 'NODE_NOT_RESPONDING', message: 'The place your data is stored isn\'t responding right now.', service: 'kv' } };
  const refused = (key) => ({ ok: false, error: { code: 'KV_PRECONDITION_FAILED', message: `KV precondition failed for key ${JSON.stringify(key)}`, service: 'kv', meta: { status: 412 } } });
  return {
    rows,
    fault(key, kind) { faults.push({ key, kind }); },
    value(key) { return rows.has(key) ? JSON.parse(rows.get(key).text) : undefined; },
    async list({ prefix }) {
      return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async get(key) {
      const row = rows.get(key);
      return row
        ? { ok: true, data: { data: row.text, headers: { etag: row.etag } } }
        : { ok: false, error: { code: 'KV_NOT_FOUND', message: `Key not found: ${key}`, service: 'kv' } };
    },
    async put(key, value, options = {}) {
      const at = faults.findIndex((f) => f.key === key);
      const fault = at >= 0 ? faults.splice(at, 1)[0].kind : undefined;
      if (fault === 'unsent') return lost;
      const prior = rows.get(key);
      if ((options.ifNoneMatch === '*' && prior) || (options.ifMatch && options.ifMatch !== prior?.etag)) return refused(key);
      const text = JSON.stringify(value);
      const etag = etagOf(text);
      rows.set(key, { text, etag });
      if (fault === 'lost-reply') return lost;
      if (fault === 'retried-after-applied') return refused(key);
      return { ok: true, data: { data: undefined, headers: { etag } } };
    },
    async delete(key) {
      rows.delete(key);
      return { ok: true, data: undefined };
    },
  };
}
