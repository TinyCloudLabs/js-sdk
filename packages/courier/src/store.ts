import { defer } from './defer.js';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { CourierError, unwrap, isNotFoundError, isPreconditionError, isTransientError, type ResultLike } from './errors.js';

/** `DelegatedAccess.path` reflects only the first grant entry — always pass full keys (TC-708). */
const FULL = { prefix: '' };

type KV = ReturnType<TinyCloudNode['kvForSpace']>;

interface KVListResponse {
  keys: string[];
  truncated?: boolean;
  nextCursor?: string;
}

interface KVResponse<T> {
  data: T;
  headers: { get(name: string): string | null } & Record<string, unknown>;
}

async function nap(ms: number) {
  const { promise, resolve } = defer<void>();
  setTimeout(resolve, ms);
  await promise;
}

/** Bounded retry for idempotent KV reads — node blips are real (fetch failed, 5xx). */
async function readRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fn();
      const res = r as { ok?: boolean; error?: unknown };
      if (res && typeof res === 'object' && res.ok === false) {
        if (isTransientError(res.error) && i < 2) {
          await nap(1500);
          continue;
        }
      }
      return r;
    } catch (e) {
      last = e;
      const undiciFetchFailure = e instanceof Error && e.message === 'fetch failed';
      if (!(isTransientError(e) || undiciFetchFailure) || i === 2) throw e;
      await nap(1500);
    }
  }
  throw last;
}

/** The new etag from a put response, when the node returns one. */
function putEtag(res: KVResponse<void> | undefined): string | null {
  const etag = res?.headers?.etag;
  return typeof etag === 'string' ? etag : null;
}

/** Create-only put; throws CourierError('conflict') on 412. */
export async function putCreate(kv: KV, key: string, value: unknown): Promise<string | null> {
  const r = (await kv.put(key, value, { ...FULL, ifNoneMatch: '*' })) as ResultLike<KVResponse<void>>;
  try {
    return putEtag(unwrap(r, `put ${key}`));
  } catch (e) {
    if (e instanceof CourierError && r.ok === false && isPreconditionError(r.error)) {
      throw new CourierError('conflict', `${key} already exists (create-only write)`);
    }
    throw e;
  }
}

/** Conditional put for updates. Throws CourierError('conflict') on 412. */
export async function putMatch(kv: KV, key: string, value: unknown, etag: string): Promise<string | null> {
  const r = (await kv.put(key, value, { ...FULL, ifMatch: etag })) as ResultLike<KVResponse<void>>;
  try {
    return putEtag(unwrap(r, `put ${key}`));
  } catch (e) {
    if (e instanceof CourierError && r.ok === false && isPreconditionError(r.error)) {
      throw new CourierError('conflict', `${key} changed under us; re-read and retry`);
    }
    throw e;
  }
}

export async function getJson<T>(kv: KV, key: string): Promise<{ value: T; etag: string | null } | undefined> {
  return jsonResult<T>((await readRetry(() => kv.get(key, FULL))) as ResultLike<KVResponse<unknown>>, key);
}

/** The node's batch read limit: one invocation reads at most this many keys. */
const BATCH_READ_KEYS = 100;

/** A key read as `getJson` reads it: the value and its etag, or undefined if the key is missing. */
export type JsonRead<T> = { value: T; etag: string | null } | undefined;
/** One key of a batch read: what `getJson` would have returned, or the error it would have thrown. */
export type JsonReadOutcome<T> = { got: JsonRead<T> } | { error: unknown };

/**
 * Each key read as `getJson` reads it, in one invocation per 100 keys (`tinycloud.kv/get` on each key, as one batch).
 * A failed batch call throws; one key's failure is only that key's outcome.
 */
export async function readJsonMany<T>(kv: KV, keys: readonly string[]): Promise<Map<string, JsonReadOutcome<T>>> {
  const outcomes = new Map<string, JsonReadOutcome<T>>();
  const unique = [...new Set(keys)];
  for (let start = 0; start < unique.length; start += BATCH_READ_KEYS) {
    const chunk = unique.slice(start, start + BATCH_READ_KEYS);
    const r = (await readRetry(() => kv.batchGet(chunk, FULL))) as ResultLike<{ results: Array<{ key: string; result: ResultLike<KVResponse<unknown>> }> }>;
    const batch = unwrap(r, `batch get ${chunk.length} key(s)`);
    if (batch.results.length !== chunk.length) throw new CourierError('kv', `batch get returned ${batch.results.length} of ${chunk.length} keys`);
    for (const [index, item] of batch.results.entries()) {
      if (item.key !== chunk[index]) throw new CourierError('kv', 'batch get answered a different key');
      try { outcomes.set(item.key, { got: jsonResult<T>(item.result, item.key) }); } catch (error) { outcomes.set(item.key, { error }); }
    }
  }
  return outcomes;
}

/** `readJsonMany` where any key's failure fails the whole read, as a series of `getJson` calls would. */
export async function getJsonMany<T>(kv: KV, keys: readonly string[]): Promise<Map<string, JsonRead<T>>> {
  const found = new Map<string, JsonRead<T>>();
  for (const [key, outcome] of await readJsonMany<T>(kv, keys)) {
    if ('error' in outcome) throw outcome.error;
    found.set(key, outcome.got);
  }
  return found;
}

function jsonResult<T>(r: ResultLike<KVResponse<unknown>>, key: string): { value: T; etag: string | null } | undefined {
  if (r && typeof r === 'object' && 'ok' in r && !r.ok) {
    if (/space not found/i.test(String(r.error?.message))) {
      throw new CourierError('no-space', String(r.error?.message));
    }
    if (isNotFoundError(r.error)) return undefined;
    unwrap(r, `get ${key}`);
  }
  const res = (r as ResultLike<KVResponse<unknown>>).data as KVResponse<unknown>;
  if (!res) return undefined;
  // The node stores payloads verbatim; objects we put come back as JSON text.
  let value = res.data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch { /* plain-text value (e.g. orders/*.md) — keep the string */ }
  }
  const headers = res.headers as Record<string, unknown> | undefined;
  const etag = typeof headers?.etag === 'string' ? headers.etag : null;
  return { value: value as T, etag };
}

/** Full listing under a prefix. TC-719: cursors don't advance on production — never rely on them. */
export async function listAll(kv: KV, prefix: string): Promise<string[]> {
  const r = (await readRetry(() => kv.list({ prefix }))) as ResultLike<KVListResponse>;
  const data = unwrap(r, `list ${prefix}`);
  return data?.keys ?? [];
}

export async function del(kv: KV, key: string): Promise<void> {
  const r = (await kv.delete(key, FULL)) as ResultLike<unknown>;
  unwrap(r, `del ${key}`);
}

/** Unconditional put, for single-writer copies such as `me/mirror/` tasks. */
export async function putOverwrite(kv: KV, key: string, value: unknown): Promise<void> {
  const r = (await kv.put(key, value, FULL)) as ResultLike<KVResponse<void>>;
  unwrap(r, `put ${key}`);
}
