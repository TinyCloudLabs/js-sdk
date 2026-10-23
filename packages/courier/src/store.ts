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
  const r = (await readRetry(() => kv.get(key, FULL))) as ResultLike<KVResponse<unknown>>;
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

/** Delete that treats a missing key as already deleted (idempotent revoke). */
export async function delIfPresent(kv: KV, key: string): Promise<void> {
  const r = (await kv.delete(key, FULL)) as ResultLike<unknown>;
  if (!r.ok && isNotFoundError(r.error)) return;
  unwrap(r, `del ${key}`);
}

/** Unconditional put, for single-writer copies such as `me/mirror/` tasks. */
export async function putOverwrite(kv: KV, key: string, value: unknown): Promise<void> {
  const r = (await kv.put(key, value, FULL)) as ResultLike<KVResponse<void>>;
  unwrap(r, `put ${key}`);
}
