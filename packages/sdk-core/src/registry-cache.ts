import type { WebStorageLike } from "./location";
import { classifyRegistryLookup, registryOwnerKeyV2 } from "./registry-verdict";
import type { RegisteredRegistryVerdict } from "./registry-verdict";

/** Storage metadata is outside the untouched signed HTTP response text. */
export interface RegistryCacheEntry {
  readonly ownerKey: string;
  readonly responseBody: string;
  readonly fetchedAt: number;
  readonly sequence: number;
}

/** update MUST serialize read/compare/write across all users of the backing store. */
export interface RegistryCacheStore {
  get(ownerKey: string): Promise<RegistryCacheEntry | undefined>;
  update(ownerKey: string, update: (current: RegistryCacheEntry | undefined) => Promise<RegistryCacheEntry>): Promise<RegistryCacheEntry>;
}

export function createInMemoryRegistryCacheStore(): RegistryCacheStore {
  const entries = new Map<string, RegistryCacheEntry>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async get(key) { await tail; return entries.get(key); },
    update(key, update) {
      const next = tail.then(async () => {
        const entry = await update(entries.get(key));
        entries.set(key, entry);
        return entry;
      });
      tail = next.catch(() => undefined);
      return next;
    },
  };
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
  const read = (key: string): RegistryCacheEntry | undefined => {
    const raw = backing.getItem(`${storageKey}:${key}`);
    return raw === null ? undefined : JSON.parse(raw);
  };
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async get(key) { await tail; return read(key); },
    update(key, update) {
      const commit = async () => {
        const entry = await update(read(key));
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
      !Number.isSafeInteger(entry.sequence) || entry.sequence < 0) {
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
