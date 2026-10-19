import { beforeEach, expect, spyOn, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { didKeyFromEd25519PublicKey, ed25519PublicKeyFromDidKey, toBase64Url } from "@tinycloud/share-envelope";
import { SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY } from "../src/share/receiver-credentials";
import {
  createOrRestoreShareReceiverSession,
  forgetShareReceiverSession,
  SHARE_RECEIVER_KEY_DATABASE,
  SHARE_RECEIVER_KEY_LIFETIME_MS,
  SHARE_RECEIVER_SESSION_STORAGE_KEY,
  ShareReceiverKeyUnavailableError,
  ShareReceiverSessionEndedError,
  type ShareReceiverSession,
} from "../src/share/receiver-session";

/** Rewrites values on their way into IndexedDB, as a browser that cannot clone a CryptoKey back would. */
async function withStoredValue<T>(rewrite: (value: Record<string, unknown>) => Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    return add.call(this, rewrite(value as Record<string, unknown>), key);
  } as typeof add;
  try { return await run(); } finally { IDBObjectStore.prototype.add = add; }
}

async function didOf(publicKey: CryptoKey): Promise<string> {
  return didKeyFromEd25519PublicKey(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
}

const ORIGIN = "https://share.example";
const message = new TextEncoder().encode("tc-1424");

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

async function storedRecord(factory: IDBFactory, origin = ORIGIN): Promise<Record<string, unknown> | undefined> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(SHARE_RECEIVER_KEY_DATABASE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    if (!database.objectStoreNames.contains("keys")) return undefined;
    return await new Promise((resolve, reject) => {
      const read = database.transaction("keys").objectStore("keys").get(origin);
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
  } finally {
    database.close();
  }
}

async function writeRecord(factory: IDBFactory, value: unknown, origin = ORIGIN): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(SHARE_RECEIVER_KEY_DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("keys", "readwrite");
    transaction.objectStore("keys").put(value, origin);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

/** IndexedDB that exists but refuses every open, as in some private modes. */
const brokenIndexedDB = {
  open: () => { throw new DOMException("The operation is insecure.", "SecurityError"); },
} as unknown as IDBFactory;

/** WebCrypto without Ed25519, as in Chrome < 137, Firefox < 129 and Safari < 17. */
const subtleWithoutEd25519 = new Proxy(crypto.subtle, {
  get(target, property) {
    if (property === "generateKey") return async () => { throw new DOMException("Unrecognized name.", "NotSupportedError"); };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

async function verifies(session: ShareReceiverSession): Promise<boolean> {
  return ed25519.verify(await session.sign(message), message, ed25519PublicKeyFromDidKey(session.holderDid));
}

function simulateReload(): void {
  globalThis.dispatchEvent(new Event("pagehide"));
}

// Each test starts as a freshly loaded page; other files may leave memory keys behind.
beforeEach(() => simulateReload());

test("the receiver key is a non-extractable handle in IndexedDB and is reused after a reload", async () => {
  const factory = new IDBFactory();
  const storage = memoryStorage();
  const first = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory });
  expect(first.custody).toBe("persistent");
  expect(Object.keys(first).sort()).toEqual(["createdAt", "credentialStorage", "custody", "expiresAt", "holderDid", "origin", "sign"]);
  expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(SHARE_RECEIVER_KEY_LIFETIME_MS);
  expect(await verifies(first)).toBe(true);

  const record = await storedRecord(factory);
  const privateKey = record?.privateKey as CryptoKey;
  expect(privateKey).toBeInstanceOf(CryptoKey);
  expect(privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("jwk", privateKey)).rejects.toThrow();
  await expect(crypto.subtle.exportKey("pkcs8", privateKey)).rejects.toThrow();
  await expect(crypto.subtle.exportKey("raw", privateKey)).rejects.toThrow();

  simulateReload();
  const restored = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory });
  expect(restored.holderDid).toBe(first.holderDid);
  expect(restored.custody).toBe("persistent");
  expect(await verifies(restored)).toBe(true);
  expect(storage.values.size).toBe(0);
});

test("credentials stay in page memory exactly when the key does", async () => {
  for (const [options, custody] of [[{ indexedDB: new IDBFactory() }, "persistent"], [{ indexedDB: null }, "memory"], [{ indexedDB: null, subtle: subtleWithoutEd25519 }, "memory"]] as const) {
    const storage = memoryStorage();
    const session = await createOrRestoreShareReceiverSession(ORIGIN, storage, options);
    expect(session.custody).toBe(custody);
    // Every consumer signs through the handle: holder binding, presentation, invocation.
    expect(await verifies(session)).toBe(true);
    session.credentialStorage.setItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY, JSON.stringify({ type: "TinyCloudShareReceiverCredentials", version: 1, entries: [] }));
    expect([...storage.values.keys()]).toEqual(custody === "persistent" ? [SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY] : []);
    for (const value of storage.values.values()) expect(value).not.toMatch(/"d"|jwk|privateKey|pkcs8/i);
    simulateReload();
  }
});

test("blocked site storage falls back to page memory instead of stopping", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  try {
    const session = await createOrRestoreShareReceiverSession(ORIGIN, undefined, { indexedDB: brokenIndexedDB });
    expect(session.custody).toBe("memory");
    expect(await verifies(session)).toBe(true);
    session.credentialStorage.setItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY, "{}");
    expect(session.credentialStorage.getItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY)).toBe("{}");
    await forgetShareReceiverSession(ORIGIN, undefined, { indexedDB: null });
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "sessionStorage");
    else Object.defineProperty(globalThis, "sessionStorage", descriptor);
  }
});

test("a legacy exportable session and its credentials are purged and never reused", async () => {
  const factory = new IDBFactory();
  const storage = memoryStorage();
  const legacySecret = ed25519.utils.randomPrivateKey();
  const legacyPublic = ed25519.getPublicKey(legacySecret);
  const legacyHolder = didKeyFromEd25519PublicKey(legacyPublic);
  storage.setItem(SHARE_RECEIVER_SESSION_STORAGE_KEY, JSON.stringify({
    type: "TinyCloudShareReceiverSession", version: 1, origin: ORIGIN, holderDid: legacyHolder,
    jwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(legacyPublic), d: toBase64Url(legacySecret) },
    createdAt: new Date().toISOString(),
  }));
  storage.setItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY, JSON.stringify({ type: "TinyCloudShareReceiverCredentials", version: 1, entries: [{ holderDid: legacyHolder }] }));

  const session = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory });
  expect(session.holderDid).not.toBe(legacyHolder);
  expect(storage.values.size).toBe(0);
});

test("an expired, over-long, foreign or tampered stored key is replaced", async () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const factory = new IDBFactory();
  const storage = memoryStorage();
  const original = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory, now: () => now });
  const record = (await storedRecord(factory))!;

  const afterExpiry = new Date(now.getTime() + SHARE_RECEIVER_KEY_LIFETIME_MS);
  const renewed = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory, now: () => afterExpiry });
  expect(renewed.holderDid).not.toBe(original.holderDid);

  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const extractable = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const mutations: Record<string, unknown>[] = [
    { ...record, expiresAt: new Date(now.getTime() + SHARE_RECEIVER_KEY_LIFETIME_MS + 1).toISOString() },
    { ...record, privateKey: other.privateKey },
    { ...record, privateKey: extractable.privateKey, publicKey: extractable.publicKey },
    // Coherent and with its own DID, so only the extractability check can refuse it.
    { ...record, privateKey: extractable.privateKey, publicKey: extractable.publicKey, holderDid: await didOf(extractable.publicKey) },
    // A coherent pair under another key's DID, so only the DID check can refuse it.
    { ...record, holderDid: await didOf(other.publicKey) },
    { ...record, origin: "https://elsewhere.example" },
    { ...record, createdAt: (record.createdAt as string).replace(/\.\d{3}Z$/, "Z") },
    { ...record, jwk: { kty: "OKP" } },
  ];
  for (const mutated of mutations) {
    await writeRecord(factory, mutated);
    const replaced = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory, now: () => new Date(now.getTime() + 1) });
    expect(replaced.holderDid).not.toBe(original.holderDid);
    expect(replaced.holderDid).not.toBe(mutated.holderDid);
    expect(replaced.custody).toBe("persistent");
    expect(await verifies(replaced)).toBe(true);
    const stored = (await storedRecord(factory))!;
    expect(stored.holderDid).toBe(replaced.holderDid);
    expect((stored.privateKey as CryptoKey).extractable).toBe(false);
  }
});

test("tabs opening at once share one stored key", async () => {
  const factory = new IDBFactory();
  const sessions = await Promise.all([1, 2, 3].map(() => createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory })));
  expect(new Set(sessions.map((session) => session.holderDid)).size).toBe(1);
  expect(sessions.every((session) => session.custody === "persistent")).toBe(true);
});

test("a tab keeps the key a peer stored after the tab read its clock", async () => {
  const factory = new IDBFactory();
  const opened = new Date("2030-01-01T00:00:00.000Z");
  const peer = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory, now: () => new Date(opened.getTime() + 1) });
  const reads = [opened, new Date(opened.getTime() + 2)];
  const late = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory, now: () => reads.shift() ?? new Date(opened.getTime() + 2) });
  expect(late.holderDid).toBe(peer.holderDid);
  expect(late.custody).toBe("persistent");
});

test("without usable IndexedDB the non-extractable key stays in memory and a reload forces a new key", async () => {
  for (const indexedDB of [null, brokenIndexedDB]) {
    const storage = memoryStorage();
    const first = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB });
    expect(first.custody).toBe("memory");
    expect(await verifies(first)).toBe(true);
    expect((await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB })).holderDid).toBe(first.holderDid);
    simulateReload();
    const afterReload = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB });
    expect(afterReload.holderDid).not.toBe(first.holderDid);
    expect(storage.values.size).toBe(0);
  }
});

test("without WebCrypto Ed25519 the key lives only in memory and is zeroed when the page goes away", async () => {
  const factory = new IDBFactory();
  const storage = memoryStorage();
  const session = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory, subtle: subtleWithoutEd25519 });
  expect(session.custody).toBe("memory");
  expect(await verifies(session)).toBe(true);
  expect(await storedRecord(factory)).toBeUndefined();
  expect(storage.values.size).toBe(0);

  simulateReload();
  await expect(session.sign(message)).rejects.toBeInstanceOf(ShareReceiverSessionEndedError);
  const next = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory, subtle: subtleWithoutEd25519 });
  expect(next.holderDid).not.toBe(session.holderDid);
});

test("the fallback's seed buffer is overwritten with zeros on page hide and on forget", async () => {
  for (const end of [() => simulateReload(), () => forgetShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: null })]) {
    const seeds: Uint8Array[] = [];
    const original = ed25519.utils.randomPrivateKey;
    const spy = spyOn(ed25519.utils, "randomPrivateKey").mockImplementation((...args) => {
      const seed = original(...args);
      seeds.push(seed);
      return seed;
    });
    try {
      const session = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: null, subtle: subtleWithoutEd25519 });
      expect(seeds).toHaveLength(1);
      expect(await verifies(session)).toBe(true);
      expect(seeds[0]!.some((byte) => byte !== 0)).toBe(true);
      await end();
      expect(seeds[0]!.every((byte) => byte === 0)).toBe(true);
      await expect(session.sign(message)).rejects.toBeInstanceOf(ShareReceiverSessionEndedError);
    } finally {
      spy.mockRestore();
    }
  }
});

test("a stored copy that cannot be read back, or does not sign, is never used", async () => {
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const rewrites: Array<(value: Record<string, unknown>) => Record<string, unknown>> = [
    (value) => ({ ...value, privateKey: {} }),
    // Well shaped and non-extractable, but not the stored public key's pair.
    (value) => ({ ...value, privateKey: other.privateKey }),
  ];
  for (const rewrite of rewrites) {
    const factory = new IDBFactory();
    const session = await withStoredValue(rewrite, () => createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory }));
    expect(session.custody).toBe("memory");
    expect(await verifies(session)).toBe(true);
    expect(await storedRecord(factory)).toBeUndefined();
    simulateReload();
  }
});

test("a session refuses to sign once it expired or was forgotten", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * SHARE_RECEIVER_KEY_LIFETIME_MS);
  for (const options of [{ indexedDB: new IDBFactory() }, { indexedDB: null }, { indexedDB: null, subtle: subtleWithoutEd25519 }]) {
    const expired = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { ...options, now: () => twoHoursAgo });
    await expect(expired.sign(message)).rejects.toBeInstanceOf(ShareReceiverSessionEndedError);
    simulateReload();

    const factory = options.indexedDB;
    const live = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), options);
    expect(await verifies(live)).toBe(true);
    await forgetShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory });
    await expect(live.sign(message)).rejects.toBeInstanceOf(ShareReceiverSessionEndedError);
    simulateReload();
  }
});

test("a tab never deletes a key another tab stored after it last looked", async () => {
  const factory = new IDBFactory();
  const now = new Date();
  const first = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory, now: () => now });
  const fresh = (await storedRecord(factory))!;
  // This tab's read sees an expired copy, as if another tab replaced the key in between.
  await writeRecord(factory, { ...fresh, createdAt: new Date(now.getTime() - SHARE_RECEIVER_KEY_LIFETIME_MS).toISOString(), expiresAt: now.toISOString() }, "stale");
  const get = IDBObjectStore.prototype.get;
  let redirected = false;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
    if (!redirected && query === ORIGIN) { redirected = true; return get.call(this, "stale"); }
    return get.call(this, query);
  } as typeof get;
  try {
    simulateReload();
    const next = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory });
    expect(next.holderDid).toBe(first.holderDid);
    expect(next.custody).toBe("persistent");
  } finally {
    IDBObjectStore.prototype.get = get;
  }
  expect((await storedRecord(factory))?.holderDid).toBe(first.holderDid);
});

test("a browser that hands out an extractable private key is never trusted with persistence", async () => {
  const factory = new IDBFactory();
  const leaky = new Proxy(crypto.subtle, {
    get(target, property) {
      if (property === "generateKey") return (algorithm: AlgorithmIdentifier, _extractable: boolean, usages: KeyUsage[]) => target.generateKey(algorithm, true, usages);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const session = await createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: factory, subtle: leaky });
  expect(session.custody).toBe("memory");
  expect(await storedRecord(factory)).toBeUndefined();
});

test("with no secure randomness at all the receiver fails closed", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  try {
    await expect(createOrRestoreShareReceiverSession(ORIGIN, memoryStorage(), { indexedDB: null, subtle: null })).rejects.toBeInstanceOf(ShareReceiverKeyUnavailableError);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

test("forgetting this browser removes the stored key, the memory key and receiver credentials", async () => {
  const factory = new IDBFactory();
  const storage = memoryStorage();
  const first = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory });
  storage.setItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY, "{}");
  await forgetShareReceiverSession(ORIGIN, storage, { indexedDB: factory });
  expect(await storedRecord(factory)).toBeUndefined();
  expect(storage.values.size).toBe(0);
  expect((await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory })).holderDid).not.toBe(first.holderDid);

  const memory = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: null, subtle: subtleWithoutEd25519 });
  await forgetShareReceiverSession(ORIGIN, storage, { indexedDB: null });
  await expect(memory.sign(message)).rejects.toBeInstanceOf(ShareReceiverSessionEndedError);
});

test("receiver keys are bound to a canonical HTTPS or loopback origin", async () => {
  await expect(createOrRestoreShareReceiverSession("http://share.example", memoryStorage(), { indexedDB: null })).rejects.toThrow("loopback");
  await expect(createOrRestoreShareReceiverSession("https://share.example/", memoryStorage(), { indexedDB: null })).rejects.toThrow("canonical");
  expect((await createOrRestoreShareReceiverSession("http://localhost:5173", memoryStorage(), { indexedDB: null })).origin).toBe("http://localhost:5173");
  expect((await createOrRestoreShareReceiverSession("http://127.0.0.1:5173", memoryStorage(), { indexedDB: null })).origin).toBe("http://127.0.0.1:5173");
});
