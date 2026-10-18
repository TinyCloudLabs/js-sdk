import { beforeEach, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { IDBFactory } from "fake-indexeddb";
import { didKeyFromEd25519PublicKey, ed25519PublicKeyFromDidKey, toBase64Url } from "@tinycloud/share-envelope";
import { SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY } from "../src/share/receiver-credentials";
import {
  createOrRestoreShareReceiverSession,
  forgetShareReceiverSession,
  SHARE_RECEIVER_KEY_DATABASE,
  SHARE_RECEIVER_KEY_LIFETIME_MS,
  SHARE_RECEIVER_SESSION_STORAGE_KEY,
  ShareReceiverKeyUnavailableError,
  type ShareReceiverSession,
} from "../src/share/receiver-session";

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
  expect(Object.keys(first).sort()).toEqual(["createdAt", "custody", "expiresAt", "holderDid", "origin", "sign"]);
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

test("session storage holds no private key material after a credential is stored", async () => {
  for (const options of [{ indexedDB: new IDBFactory() }, { indexedDB: null }, { indexedDB: null, subtle: subtleWithoutEd25519 }]) {
    const storage = memoryStorage();
    const session = await createOrRestoreShareReceiverSession(ORIGIN, storage, options);
    // Every consumer signs through the handle: holder binding, presentation, invocation.
    expect(await verifies(session)).toBe(true);
    storage.setItem(SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY, JSON.stringify({ type: "TinyCloudShareReceiverCredentials", version: 1, entries: [] }));
    expect([...storage.values.keys()]).toEqual([SHARE_RECEIVER_CREDENTIALS_STORAGE_KEY]);
    for (const value of storage.values.values()) expect(value).not.toMatch(/"d"|jwk|privateKey|pkcs8/i);
    simulateReload();
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
    { ...record, origin: "https://elsewhere.example" },
    { ...record, createdAt: (record.createdAt as string).replace(/\.\d{3}Z$/, "Z") },
    { ...record, jwk: { kty: "OKP" } },
  ];
  for (const mutated of mutations) {
    await writeRecord(factory, mutated);
    const replaced = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory, now: () => new Date(now.getTime() + 1) });
    expect(replaced.holderDid).not.toBe(original.holderDid);
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
  await expect(session.sign(message)).rejects.toBeInstanceOf(ShareReceiverKeyUnavailableError);
  const next = await createOrRestoreShareReceiverSession(ORIGIN, storage, { indexedDB: factory, subtle: subtleWithoutEd25519 });
  expect(next.holderDid).not.toBe(session.holderDid);
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
  await expect(memory.sign(message)).rejects.toBeInstanceOf(ShareReceiverKeyUnavailableError);
});

test("receiver keys are bound to a canonical HTTPS or loopback origin", async () => {
  await expect(createOrRestoreShareReceiverSession("http://share.example", memoryStorage(), { indexedDB: null })).rejects.toThrow("loopback");
  await expect(createOrRestoreShareReceiverSession("https://share.example/", memoryStorage(), { indexedDB: null })).rejects.toThrow("canonical");
  expect((await createOrRestoreShareReceiverSession("http://localhost:5173", memoryStorage(), { indexedDB: null })).origin).toBe("http://localhost:5173");
  expect((await createOrRestoreShareReceiverSession("http://127.0.0.1:5173", memoryStorage(), { indexedDB: null })).origin).toBe("http://127.0.0.1:5173");
});
