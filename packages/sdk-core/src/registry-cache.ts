import type { WebStorageLike } from "./location";
import { classifyRegistryLookup, registryOwnerKeyV2 } from "./registry-verdict";
import type { RegisteredRegistryVerdict } from "./registry-verdict";

/** Storage metadata is outside the untouched signed HTTP response text. */
export interface RegistryCacheEntry {
  readonly ownerKey: string;
  readonly responseBody: string;
  readonly fetchedAt: number;
  readonly sequence: number;
  /** Local invalidation generation, not a signed sequence. Legacy entries omit it. */
  readonly revision?: number;
}

/** Durable negative state. No signed response bytes survive an invalidation. */
export interface RegistryCacheTombstone {
  readonly ownerKey: string;
  readonly revision: number;
  readonly invalidated: true;
}

export type RegistryCacheRecord = RegistryCacheEntry | RegistryCacheTombstone;

/** Entry, revision, update and invalidation guards share one serialized authority. */
export interface RegistryCacheStore {
  get(ownerKey: string): Promise<RegistryCacheEntry | undefined>;
  /** Legacy/absent state is zero; positive tombstone revisions retain known-owner evidence. */
  getRevision(ownerKey: string): Promise<number>;
  /** Pass the locked revision and preserve it regardless of callback-provided metadata. */
  update(ownerKey: string, update: (current: RegistryCacheEntry | undefined, revision: number) => Promise<RegistryCacheEntry>): Promise<RegistryCacheEntry>;
  /** Advance even when empty. Guard mismatches refuse without a write or counter advance. */
  delete(ownerKey: string, expectedRevision?: number, maximumSequence?: number): Promise<void>;
}

export function createInMemoryRegistryCacheStore(): RegistryCacheStore {
  const entries = new Map<string, RegistryCacheRecord>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async get(key) {
      await tail;
      const record = validateRegistryCacheRecord(entries.get(key), key);
      return record && "invalidated" in record ? undefined : record;
    },
    async getRevision(key) {
      await tail;
      return validateRegistryCacheRecord(entries.get(key), key)?.revision ?? 0;
    },
    update(key, update) {
      const next = tail.then(async () => {
        const record = validateRegistryCacheRecord(entries.get(key), key);
        const revision = record?.revision ?? 0;
        const entry = { ...await update(record && "invalidated" in record ? undefined : record, revision), revision };
        entries.set(key, entry);
        return entry;
      });
      tail = next.catch(() => undefined);
      return next;
    },
    delete(key, expectedRevision, maximumSequence) {
      const next = tail.then(() => {
        const record = validateRegistryCacheRecord(entries.get(key), key);
        const revision = record?.revision ?? 0;
        if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== revision)) {
          throw new Error("Registry cache revision changed before invalidation");
        }
        if (maximumSequence !== undefined && (!Number.isSafeInteger(maximumSequence) || maximumSequence < 0 ||
            (record !== undefined && !("invalidated" in record) && record.sequence > maximumSequence))) {
          throw new Error("Registry cache sequence advanced before invalidation");
        }
        if (revision === Number.MAX_SAFE_INTEGER) throw new Error("Registry cache revision overflow");
        entries.set(key, { ownerKey: key, revision: revision + 1, invalidated: true });
      });
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

function validateRegistryCacheRecord(value: unknown, key: string): RegistryCacheRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || !("ownerKey" in value) || value.ownerKey !== key) {
    throw new Error("Invalid registry cache metadata");
  }
  const revision = "revision" in value ? value.revision : 0;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Invalid registry cache revision");
  }
  if ("invalidated" in value) {
    if (value.invalidated !== true || !("revision" in value) ||
        Object.keys(value).some((field) => field !== "ownerKey" && field !== "revision" && field !== "invalidated")) {
      throw new Error("Invalid registry cache tombstone");
    }
    return { ownerKey: key, revision, invalidated: true };
  }
  if (!("responseBody" in value) || typeof value.responseBody !== "string" ||
      !("fetchedAt" in value) || typeof value.fetchedAt !== "number" || !Number.isSafeInteger(value.fetchedAt) || value.fetchedAt < 0 ||
      !("sequence" in value) || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new Error("Invalid registry cache metadata");
  }
  // Structural metadata is checked here; the resolver verifies the signed text.
  return value as RegistryCacheEntry;
}

export const DEFAULT_REGISTRY_CACHE_STORAGE_KEY = "tinycloud.registryCache.v2";

/** Web Locks make the signature-check/compare/write atomic across browser tabs. */
export function createLocalStorageRegistryCacheStore(
  storage?: WebStorageLike,
  storageKey = DEFAULT_REGISTRY_CACHE_STORAGE_KEY,
): RegistryCacheStore {
  // A storage getter that throws is unreadable state, not an empty cache.
  // Platform global; Node-only declaration builds do not include the DOM storage type.
  const browserGlobal = globalThis as unknown as { localStorage?: WebStorageLike };
  const backing = storage ?? browserGlobal.localStorage;
  if (!backing) return createInMemoryRegistryCacheStore();
  const read = (key: string): RegistryCacheRecord | undefined => {
    const raw = backing.getItem(`${storageKey}:${key}`);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return validateRegistryCacheRecord(parsed, key);
  };
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async get(key) {
      await tail;
      const record = read(key);
      return record && "invalidated" in record ? undefined : record;
    },
    async getRevision(key) { await tail; return read(key)?.revision ?? 0; },
    update(key, update) {
      const commit = async () => {
        const record = read(key);
        const revision = record?.revision ?? 0;
        const entry = { ...await update(record && "invalidated" in record ? undefined : record, revision), revision };
        backing.setItem(`${storageKey}:${key}`, JSON.stringify(entry));
        return entry;
      };
      const next = tail.then(() => {
        // Platform Web Locks API, absent from this package's Node-only declarations.
        const navigator = globalThis.navigator as unknown as {
          locks?: { request<T>(name: string, action: () => Promise<T>): Promise<T> };
        } | undefined;
        const locks = navigator?.locks;
        // Without cross-tab locking, do not weaken persistent rollback protection.
        if (!locks) throw new Error("Persistent registry cache requires Web Locks");
        return locks.request(`${storageKey}:${key}`, commit);
      });
      tail = next.catch(() => undefined);
      return next;
    },
    delete(key, expectedRevision, maximumSequence) {
      const next = tail.then(async () => {
        const navigator = globalThis.navigator as unknown as {
          locks?: { request<T>(name: string, action: () => Promise<T>): Promise<T> };
        } | undefined;
        if (!navigator?.locks) throw new Error("Persistent registry cache requires Web Locks");
        await navigator.locks.request(`${storageKey}:${key}`, async () => {
          const record = read(key);
          const revision = record?.revision ?? 0;
          if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== revision)) {
            throw new Error("Registry cache revision changed before invalidation");
          }
          if (maximumSequence !== undefined && (!Number.isSafeInteger(maximumSequence) || maximumSequence < 0 ||
              (record !== undefined && !("invalidated" in record) && record.sequence > maximumSequence))) {
            throw new Error("Registry cache sequence advanced before invalidation");
          }
          if (revision === Number.MAX_SAFE_INTEGER) throw new Error("Registry cache revision overflow");
          backing.setItem(`${storageKey}:${key}`, JSON.stringify({ ownerKey: key, revision: revision + 1, invalidated: true }));
        });
      });
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

/** Every read, including comparison under the storage lock, uses the canonical verifier. */
export async function verifyRegistryCacheEntry(
  subject: string,
  ownerKey: string,
  entry: RegistryCacheEntry,
  rememberedSequence?: number,
): Promise<RegisteredRegistryVerdict> {
  if (!entry || ownerKey !== registryOwnerKeyV2(subject) || entry.ownerKey !== ownerKey || typeof entry.responseBody !== "string" ||
      !Number.isSafeInteger(entry.fetchedAt) || entry.fetchedAt < 0 ||
      !Number.isSafeInteger(entry.sequence) || entry.sequence < 0 ||
      (entry.revision !== undefined && (!Number.isSafeInteger(entry.revision) || entry.revision < 0))) {
    throw new Error("Invalid registry cache metadata");
  }
  const verdict = await classifyRegistryLookup(subject, { kind: "http", status: 200, body: entry.responseBody }, {
    recordVersion: 2, rememberedSequence,
  });
  if (verdict.status !== "registered" || verdict.sequence !== entry.sequence || !verdict.record) {
    throw new Error("Registry cache verification failed");
  }
  return verdict;
}
