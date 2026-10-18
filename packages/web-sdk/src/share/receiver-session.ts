import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromEd25519PublicKey } from "@tinycloud/share-envelope";
import { SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY } from "./receiver-credentials";

/**
 * Former (v1) location of the receiver key. That record held private key
 * material, so it is only ever removed, never read.
 */
export const SHARE_RECEIVER_SESSION_STORAGE_KEY = "tinycloud.share.receiver-session.v1";

/** IndexedDB database holding non-extractable receiver key handles, one per origin. */
export const SHARE_RECEIVER_KEY_DATABASE = "tinycloud.share.receiver-keys";
const KEY_STORE = "keys";
const KEY_DATABASE_VERSION = 1;
const KEY_RECORD_VERSION = 2;

/**
 * Upper bound on how long a persisted receiver key is reused. An emailed
 * credential lives for minutes, and the key alone authorizes nothing, so an
 * hour keeps reloads working without keeping a signer around for days.
 */
export const SHARE_RECEIVER_KEY_LIFETIME_MS = 60 * 60 * 1000;

const STORAGE_TIMEOUT_MS = 5_000;
const KEY_COHERENCE_PROBE = new TextEncoder().encode("tinycloud.share.receiver-session/v2");

/**
 * Where the receiver signing key lives:
 * - `persistent`: a non-extractable WebCrypto key whose handle is kept in
 *   IndexedDB, so the page survives a reload.
 * - `memory`: a key held only by this page. A reload loses it, and the
 *   recipient verifies their email again.
 */
export type ShareReceiverKeyCustody = "persistent" | "memory";

export interface ReceiverSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ShareReceiverSession {
  readonly holderDid: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly custody: ShareReceiverKeyCustody;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface ShareReceiverSessionOptions {
  /** IndexedDB used to keep the key handle; `null` keeps the key in memory only. */
  readonly indexedDB?: IDBFactory | null;
  /** @internal WebCrypto implementation; `null` simulates a browser without it. */
  readonly subtle?: SubtleCrypto | null;
  /** @internal */
  readonly now?: () => Date;
}

/** This browser can create no signing key for the share page, so nothing can be opened. */
export class ShareReceiverKeyUnavailableError extends Error {
  readonly code = "receiver_key_unavailable";
  constructor() {
    super("This browser cannot create a signing key for this page");
    this.name = "ShareReceiverKeyUnavailableError";
  }
}

interface PersistedReceiverKey {
  readonly type: "TinyCloudShareReceiverKey";
  readonly version: typeof KEY_RECORD_VERSION;
  readonly origin: string;
  readonly holderDid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface MemorySession {
  readonly session: ShareReceiverSession;
  dispose(): void;
}

// Memory-custody keys for this page, by origin. Nothing here is ever written
// anywhere; the entries die with the page.
const memorySessions = new Map<string, MemorySession>();
let pageHideRegistered = false;

function disposeMemorySessions(): void {
  for (const entry of memorySessions.values()) entry.dispose();
  memorySessions.clear();
}

function rememberMemorySession(origin: string, entry: MemorySession): ShareReceiverSession {
  memorySessions.get(origin)?.dispose();
  memorySessions.set(origin, entry);
  if (!pageHideRegistered && typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", disposeMemorySessions);
    pageHideRegistered = true;
  }
  return entry.session;
}

function canonicalReceiverOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("receiver origin is invalid"); }
  const loopbackHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !loopbackHttp) || url.origin !== value) throw new Error("receiver origin must be canonical HTTPS or explicit loopback HTTP");
  return value;
}

function defaultIndexedDB(): IDBFactory | null {
  try { return typeof indexedDB === "undefined" ? null : indexedDB; } catch { return null; }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}

function openKeyDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    // A blocked or stalled open must not hold the page; a late connection is closed.
    const open = factory.open(SHARE_RECEIVER_KEY_DATABASE, KEY_DATABASE_VERSION);
    const timer = setTimeout(() => { settled = true; reject(new Error("receiver key storage timed out")); }, STORAGE_TIMEOUT_MS);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(KEY_STORE)) open.result.createObjectStore(KEY_STORE);
    };
    open.onsuccess = () => {
      if (settled) { open.result.close(); return; }
      settled = true; clearTimeout(timer); resolve(open.result);
    };
    open.onerror = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(open.error ?? new Error("receiver key storage is unavailable"));
    };
  });
}

async function withKeyStore<T>(factory: IDBFactory, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openKeyDatabase(factory);
  try {
    const transaction = database.transaction(KEY_STORE, mode);
    const pending = run(transaction.objectStore(KEY_STORE));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(pending.error ?? transaction.error ?? new Error("receiver key storage failed"));
    });
    return pending.result;
  } finally {
    database.close();
  }
}

/** A usable key handle never exposes its private half, whatever the browser claims elsewhere. */
function isNonExtractableEd25519(key: unknown, type: KeyType, usage: KeyUsage): key is CryptoKey {
  if (typeof CryptoKey === "undefined" || !(key instanceof CryptoKey)) return false;
  return key.type === type && key.extractable === (type === "public") && key.algorithm.name === "Ed25519" && key.usages.length === 1 && key.usages[0] === usage;
}

async function holderDidFor(subtle: SubtleCrypto, publicKey: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await subtle.exportKey("raw", publicKey));
  if (raw.length !== 32) throw new Error("receiver Ed25519 public key is invalid");
  return didKeyFromEd25519PublicKey(raw);
}

async function assertCoherent(subtle: SubtleCrypto, privateKey: CryptoKey, publicKey: CryptoKey): Promise<void> {
  const signature = await subtle.sign("Ed25519", privateKey, KEY_COHERENCE_PROBE);
  if (!await subtle.verify("Ed25519", publicKey, signature, KEY_COHERENCE_PROBE)) throw new Error("receiver Ed25519 key handle is inconsistent");
}

function webCryptoSession(subtle: SubtleCrypto, privateKey: CryptoKey, fields: Omit<ShareReceiverSession, "sign">): ShareReceiverSession {
  return Object.freeze({
    ...fields,
    sign: async (bytes: Uint8Array) => new Uint8Array(await subtle.sign("Ed25519", privateKey, bytes)),
  });
}

/**
 * Removes the v1 record, whose exportable private key sat in session
 * storage. Credentials issued to that key go with it, so the recipient
 * verifies again with a key that cannot be read out.
 */
function purgeLegacySession(storage: ReceiverSessionStorage): void {
  try {
    if (storage.getItem(SHARE_RECEIVER_SESSION_STORAGE_KEY) === null) return;
    storage.removeItem(SHARE_RECEIVER_SESSION_STORAGE_KEY);
    storage.removeItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY);
  } catch { /* storage is disabled, so it holds nothing to purge */ }
}

async function restorePersisted(factory: IDBFactory, subtle: SubtleCrypto, origin: string, now: Date): Promise<ShareReceiverSession | undefined> {
  const stored: unknown = await withKeyStore(factory, "readonly", (store) => store.get(origin));
  if (stored === undefined) return undefined;
  const record = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored as Record<string, unknown> : undefined;
  const createdAt = canonicalTime(record?.createdAt);
  const expiresAt = canonicalTime(record?.expiresAt);
  const valid = record !== undefined
    && exactKeys(record, ["type", "version", "origin", "holderDid", "privateKey", "publicKey", "createdAt", "expiresAt"])
    && record.type === "TinyCloudShareReceiverKey" && record.version === KEY_RECORD_VERSION && record.origin === origin
    && typeof record.holderDid === "string" && createdAt !== undefined && expiresAt !== undefined
    && createdAt <= now.getTime() && expiresAt > now.getTime() && expiresAt - createdAt <= SHARE_RECEIVER_KEY_LIFETIME_MS
    && isNonExtractableEd25519(record.privateKey, "private", "sign") && isNonExtractableEd25519(record.publicKey, "public", "verify");
  if (valid) {
    try {
      const privateKey = record.privateKey as CryptoKey;
      const publicKey = record.publicKey as CryptoKey;
      if (await holderDidFor(subtle, publicKey) === record.holderDid) {
        await assertCoherent(subtle, privateKey, publicKey);
        return webCryptoSession(subtle, privateKey, { holderDid: record.holderDid as string, origin, createdAt: record.createdAt as string, expiresAt: record.expiresAt as string, custody: "persistent" });
      }
    } catch { /* replaced below */ }
  }
  await withKeyStore(factory, "readwrite", (store) => store.delete(origin));
  return undefined;
}

/**
 * Stores the handle and proves the stored copy signs, since some browsers
 * accept a CryptoKey into IndexedDB but cannot clone it back. `add` keeps a
 * key another tab stored first; the caller then restores that one.
 */
async function persist(factory: IDBFactory, subtle: SubtleCrypto, record: PersistedReceiverKey): Promise<boolean> {
  try {
    await withKeyStore(factory, "readwrite", (store) => store.add(record, record.origin));
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "ConstraintError") return false;
    throw error;
  }
  try {
    const stored = await withKeyStore(factory, "readonly", (store) => store.get(record.origin)) as Partial<PersistedReceiverKey> | undefined;
    if (stored?.holderDid !== record.holderDid || !isNonExtractableEd25519(stored.privateKey, "private", "sign") || !isNonExtractableEd25519(stored.publicKey, "public", "verify")) throw new Error("receiver key storage did not keep the key handle");
    await assertCoherent(subtle, stored.privateKey, stored.publicKey);
    return true;
  } catch (error) {
    // This tab wrote the record and cannot use it; drop it so no tab restores it.
    await withKeyStore(factory, "readwrite", (store) => store.delete(record.origin)).catch(() => undefined);
    throw error;
  }
}

async function generateWebCryptoKey(subtle: SubtleCrypto): Promise<{ readonly privateKey: CryptoKey; readonly publicKey: CryptoKey; readonly holderDid: string } | undefined> {
  try {
    // Generated public keys are always extractable; the private half must not be.
    const { privateKey, publicKey } = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
    if (!isNonExtractableEd25519(privateKey, "private", "sign") || !isNonExtractableEd25519(publicKey, "public", "verify")) return undefined;
    const holderDid = await holderDidFor(subtle, publicKey);
    await assertCoherent(subtle, privateKey, publicKey);
    return { privateKey, publicKey, holderDid };
  } catch {
    return undefined;
  }
}

/**
 * Last resort for browsers without WebCrypto Ed25519: the private key exists
 * only in this closure, is never serialized, and is zeroed when the page goes
 * away or the session is forgotten.
 */
function memoryScalarSession(origin: string, now: Date): MemorySession {
  if (typeof globalThis.crypto?.getRandomValues !== "function") throw new ShareReceiverKeyUnavailableError();
  let secret: Uint8Array | undefined = ed25519.utils.randomPrivateKey();
  const holderDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(secret));
  const session: ShareReceiverSession = Object.freeze({
    holderDid,
    origin,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHARE_RECEIVER_KEY_LIFETIME_MS).toISOString(),
    custody: "memory",
    sign: async (bytes: Uint8Array) => {
      if (secret === undefined) throw new ShareReceiverKeyUnavailableError();
      return ed25519.sign(bytes, secret);
    },
  });
  return { session, dispose: () => { secret?.fill(0); secret = undefined; } };
}

/**
 * Returns this origin's receiver signing key, creating it when needed.
 *
 * The preferred key is a non-extractable WebCrypto Ed25519 key whose handle
 * is kept in IndexedDB, so no script can read the private key out. When the
 * handle cannot be kept, the same key stays in this page's memory only. A
 * browser without WebCrypto Ed25519 gets a key held in memory only. Private
 * key material is never written to any storage, URL, log or error.
 */
export async function createOrRestoreShareReceiverSession(
  originValue: string,
  storage: ReceiverSessionStorage = window.sessionStorage,
  options: ShareReceiverSessionOptions = {},
): Promise<ShareReceiverSession> {
  const origin = canonicalReceiverOrigin(originValue);
  purgeLegacySession(storage);
  const now = options.now?.() ?? new Date();
  const remembered = memorySessions.get(origin);
  if (remembered !== undefined) {
    if (Date.parse(remembered.session.expiresAt) > now.getTime()) return remembered.session;
    remembered.dispose();
    memorySessions.delete(origin);
  }
  const subtle = options.subtle === undefined ? globalThis.crypto?.subtle ?? null : options.subtle;
  const factory = options.indexedDB === undefined ? defaultIndexedDB() : options.indexedDB;
  if (subtle !== null && factory !== null) {
    try {
      const restored = await restorePersisted(factory, subtle, origin, now);
      if (restored !== undefined) return restored;
    } catch { /* unusable storage: a new key follows */ }
  }
  const generated = subtle === null ? undefined : await generateWebCryptoKey(subtle);
  if (subtle === null || generated === undefined) return rememberMemorySession(origin, memoryScalarSession(origin, now));

  const fields = {
    holderDid: generated.holderDid,
    origin,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHARE_RECEIVER_KEY_LIFETIME_MS).toISOString(),
  };
  if (factory !== null) {
    try {
      const record: PersistedReceiverKey = { type: "TinyCloudShareReceiverKey", version: KEY_RECORD_VERSION, ...fields, privateKey: generated.privateKey, publicKey: generated.publicKey };
      if (await persist(factory, subtle, record)) return webCryptoSession(subtle, generated.privateKey, { ...fields, custody: "persistent" });
      // Another tab stored its key first; share it.
      const raced = await restorePersisted(factory, subtle, origin, now);
      if (raced !== undefined) return raced;
    } catch { /* the key stays in memory below */ }
  }
  return rememberMemorySession(origin, {
    session: webCryptoSession(subtle, generated.privateKey, { ...fields, custody: "memory" }),
    dispose: () => undefined,
  });
}

/**
 * "Forget this browser": drops this origin's receiver key from IndexedDB and
 * memory, and the credentials issued to it. The next open verifies again.
 */
export async function forgetShareReceiverSession(
  originValue: string,
  storage: ReceiverSessionStorage = window.sessionStorage,
  options: Pick<ShareReceiverSessionOptions, "indexedDB"> = {},
): Promise<void> {
  const origin = canonicalReceiverOrigin(originValue);
  memorySessions.get(origin)?.dispose();
  memorySessions.delete(origin);
  try {
    storage.removeItem(SHARE_RECEIVER_SESSION_STORAGE_KEY);
    storage.removeItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY);
  } catch { /* storage is disabled */ }
  const factory = options.indexedDB === undefined ? defaultIndexedDB() : options.indexedDB;
  if (factory !== null) await withKeyStore(factory, "readwrite", (store) => store.delete(origin));
}
