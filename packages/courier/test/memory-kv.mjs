/** In-memory stand-in for the SDK KV service: just enough of get/put/list for the watcher's store helpers. */
export function memoryKv() {
  const rows = new Map();
  let sequence = 0;
  return {
    rows,
    async list({ prefix }) {
      return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async get(key) {
      const row = rows.get(key);
      return row
        ? { ok: true, data: { data: row.value, headers: { etag: row.etag } } }
        : { ok: false, error: { code: 'KV_NOT_FOUND', message: `Key not found: ${key}`, service: 'kv' } };
    },
    async put(key, value, options = {}) {
      const prior = rows.get(key);
      const conflict = (options.ifNoneMatch === '*' && prior) || (options.ifMatch && options.ifMatch !== prior?.etag);
      if (conflict) {
        return { ok: false, error: { code: 'KV_PRECONDITION_FAILED', message: `KV precondition failed for key ${JSON.stringify(key)}`, service: 'kv', meta: { status: 412 } } };
      }
      const etag = `e${++sequence}`;
      rows.set(key, { value: structuredClone(value), etag });
      return { ok: true, data: { data: undefined, headers: { etag } } };
    },
    async delete(key) {
      rows.delete(key);
      return { ok: true, data: undefined };
    },
  };
}
