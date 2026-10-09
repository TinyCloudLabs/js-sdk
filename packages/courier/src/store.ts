import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { CourierError, unwrap, type ResultLike } from './errors.js';

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

const TRANSIENT = /fetch failed|NETWORK_ERROR|ECONNRESET|ETIMEDOUT|5\d\d/i;

async function nap(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

/** Bounded retry for idempotent KV reads — node blips are real (fetch failed, 5xx). */
async function readRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fn();
      const res = r as { ok?: boolean; error?: { code?: unknown; message?: string } };
      if (res && typeof res === 'object' && res.ok === false) {
        const m = `${res.error?.code ?? ''} ${res.error?.message ?? ''}`;
        if (TRANSIENT.test(m) && i < 2) {
          await nap(1500);
          continue;
        }
      }
      return r;
    } catch (e) {
      last = e;
      if (!TRANSIENT.test(String((e as Error).message ?? e)) || i === 2) throw e;
      await nap(1500);
    }
  }
  throw last;
}

/** Create-only put; throws CourierError('conflict') on 412. */
export async function putCreate(kv: KV, key: string, value: unknown): Promise<void> {
  const r = (await kv.put(key, value, { ...FULL, ifNoneMatch: '*' })) as ResultLike<KVResponse<void>>;
  try {
    unwrap(r, `put ${key}`);
  } catch (e) {
    if (e instanceof CourierError && (e.code === '412' || /412|conflict|precondition/i.test(e.message))) {
      throw new CourierError('conflict', `${key} already exists (create-only write)`);
    }
    throw e;
  }
}

/** Conditional put for updates. Throws CourierError('conflict') on 412. */
export async function putMatch(kv: KV, key: string, value: unknown, etag: string): Promise<void> {
  const r = (await kv.put(key, value, { ...FULL, ifMatch: etag })) as ResultLike<KVResponse<void>>;
  try {
    unwrap(r, `put ${key}`);
  } catch (e) {
    if (e instanceof CourierError && (e.code === '412' || /412|conflict|precondition/i.test(e.message))) {
      throw new CourierError('conflict', `${key} changed under us; re-read and retry`);
    }
    throw e;
  }
}

export async function getJson<T>(kv: KV, key: string): Promise<{ value: T; etag: string | null } | undefined> {
  const r = (await readRetry(() => kv.get(key, FULL))) as ResultLike<KVResponse<unknown>>;
  if (r && typeof r === 'object' && 'ok' in r && !r.ok) {
    const status = r.error?.status ?? r.error?.meta?.status ?? r.error?.code;
    if (/space not found/i.test(String(r.error?.message))) {
      throw new CourierError('no-space', String(r.error?.message));
    }
    if (status === 404 || String(status) === '404' || /not.found/i.test(String(r.error?.message))) return undefined;
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
