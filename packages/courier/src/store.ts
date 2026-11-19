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

/**
 * Batch reads are bounded per value and in total. The node is asked for a per-value cap (`x-tinycloud-max-response-bytes`;
 * a larger value fails the batch with KV_RESPONSE_TOO_LARGE, "A KV batch value exceeds the requested response limit"),
 * and chunks are sized so that keys × cap stays within 32 MiB per response:
 * - messages, meta and every other entry: at most 2 MiB each (a 256 K-character message is at most 1 MiB of UTF-8),
 *   16 keys per invocation;
 * - tasks, which may carry artifacts: at most 8 MiB each, 4 keys per invocation.
 */
const BATCH_TOTAL_BYTES = 32 * 1024 * 1024;
const ENTRY_VALUE_BYTES = 2 * 1024 * 1024;
const TASK_VALUE_BYTES = 8 * 1024 * 1024;
const isTaskKey = (key: string) => /\/task\/[^/]+\.json$/.test(key);

/** A key read as `getJson` reads it: the value and its etag, or undefined if the key is missing. */
export type JsonRead<T> = { value: T; etag: string | null } | undefined;
/** One key of a batch read: what `getJson` would have returned, or the error it would have thrown. */
export type JsonReadOutcome<T> = { got: JsonRead<T> } | { error: unknown };

/**
 * Each key read as `getJson` reads it, in bounded batches (`tinycloud.kv/get` on each key of a batch, one invocation).
 * A failed batch call throws; one key's failure is only that key's outcome. A batch the node refuses because one value
 * is over the cap is read again key by key, with the same cap: the oversized key gets a KV_RESPONSE_TOO_LARGE outcome
 * and every other key its value, so one oversized value written by a peer never hides the rest.
 */
export async function readJsonMany<T>(kv: KV, keys: readonly string[]): Promise<Map<string, JsonReadOutcome<T>>> {
  const outcomes = new Map<string, JsonReadOutcome<T>>();
  const unique = [...new Set(keys)];
  const settle = (key: string, result: ResultLike<KVResponse<unknown>>) => {
    try { outcomes.set(key, { got: jsonResult<T>(result, key) }); } catch (error) { outcomes.set(key, { error }); }
  };
  for (const [group, valueBytes] of [[unique.filter(key => !isTaskKey(key)), ENTRY_VALUE_BYTES], [unique.filter(isTaskKey), TASK_VALUE_BYTES]] as const) {
    const size = Math.floor(BATCH_TOTAL_BYTES / valueBytes);
    for (let start = 0; start < group.length; start += size) {
      const chunk = group.slice(start, start + size);
      const r = (await readRetry(() => kv.batchGet(chunk, { ...FULL, maxResponseBytes: valueBytes }))) as ResultLike<{ results: Array<{ key: string; result: ResultLike<KVResponse<unknown>> }> }>;
      if (r && r.ok === false && (r.error as { code?: unknown } | undefined)?.code === 'KV_RESPONSE_TOO_LARGE') {
        for (const key of chunk) settle(key, (await readRetry(() => kv.get(key, { ...FULL, maxResponseBytes: valueBytes }))) as ResultLike<KVResponse<unknown>>);
        continue;
      }
      const batch = unwrap(r, `batch get ${chunk.length} key(s)`);
      if (batch.results.length !== chunk.length) throw new CourierError('kv', `batch get returned ${batch.results.length} of ${chunk.length} keys`);
      for (const [index, item] of batch.results.entries()) {
        if (item.key !== chunk[index]) throw new CourierError('kv', 'batch get answered a different key');
        settle(item.key, item.result);
      }
    }
  }
  return outcomes;
}

/** True for a key whose value is over the batch cap: report it and carry on; reading it again gives the same answer. */
export function isTooLarge(error: unknown): boolean {
  return error instanceof CourierError && error.code === 'KV_RESPONSE_TOO_LARGE';
}

/** What `getJsonMany` read: each key's value (undefined if missing), and the keys whose value was over the cap. */
export interface JsonReads<T> { values: Map<string, JsonRead<T>>; tooLarge: string[] }

/**
 * `readJsonMany` where any key's failure fails the whole read, as a series of `getJson` calls would, except a value over
 * the cap: that key is reported in `tooLarge` and the rest are read.
 */
export async function getJsonMany<T>(kv: KV, keys: readonly string[]): Promise<JsonReads<T>> {
  const reads: JsonReads<T> = { values: new Map(), tooLarge: [] };
  for (const [key, outcome] of await readJsonMany<T>(kv, keys)) {
    if ('got' in outcome) reads.values.set(key, outcome.got);
    else if (isTooLarge(outcome.error)) reads.tooLarge.push(key);
    else throw outcome.error;
  }
  return reads;
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
