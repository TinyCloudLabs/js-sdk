import { describe, expect, mock, test } from "bun:test";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "../../node-sdk/src/test-support/signed-restorable-session";
import { TinyCloudNode as PackageNode, NodeWasmBindings as PackageWasm } from "@tinycloud/node-sdk";
import type { PersistedSessionData } from "@tinycloud/sdk-core";

const { TextEncoder: TE, TextDecoder: TD } = require("util");

global.TextEncoder = TE;
global.TextDecoder = TD;
(globalThis as any).HTMLElement = class {
  shadowRoot: any;
  attachShadow() {
    this.shadowRoot = { innerHTML: "", querySelector: () => null };
    return this.shadowRoot;
  }
  remove() {}
};
(globalThis as any).customElements = {
  define: () => undefined,
  get: () => undefined,
};
(globalThis as any).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  location: { hostname: "test.local" },
};
(globalThis as any).document = {
  createElement: () => ({
    setAttribute: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    style: {},
  }),
  body: {
    appendChild: () => undefined,
    style: {},
  },
};

mock.module("@tinycloud/web-sdk-wasm", () => ({
  initialized: Promise.resolve(),
  tinycloud: {
    computeCid: () => "bafk-test",
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, prefix: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
    createDelegation: () => ({}),
    parseRecapFromSiwe: () => [],
    generateHostSIWEMessage: () => "",
    siweToDelegationHeaders: () => ({}),
    protocolVersion: () => 1,
    prepareSession: (params: { jwk: object; spaceId: string; nonce?: string; issuedAt: string; expirationTime: string }) => ({
      siwe: [
        `Nonce: ${params.nonce ?? ""}`,
        `Issued At: ${params.issuedAt}`,
        `Expiration Time: ${params.expirationTime}`,
      ].join("\n"),
      jwk: params.jwk,
      spaceId: params.spaceId,
      verificationMethod: "did:key:default",
    }),
    completeSessionSetup: () => ({
      delegationHeader: { Authorization: "Bearer signed-in" },
      delegationCid: "bafy-signed-in-account",
    }),
    validatePersistedSession: () => ({
      verifiedRecap: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    vault_encrypt: () => new Uint8Array(),
    vault_decrypt: () => new Uint8Array(),
    vault_derive_key: () => new Uint8Array(),
    vault_x25519_from_seed: () => new Uint8Array(),
    vault_x25519_dh: () => new Uint8Array(),
    vault_random_bytes: (length: number) => new Uint8Array(length),
    vault_sha256: () => new Uint8Array(),
  },
  tcwSession: {
    TCWSessionManager: class {
      createSessionKey(id: string) { return id; }
      replaceSessionKey(_jwk: object, keyId: string) { return keyId; }
      listSessionKeys() { return ["default", "share-recipient"]; }
      renameSessionKeyId() {}
      getDID(keyId: string) { return `did:key:${keyId}`; }
      jwk() {
        return JSON.stringify({
          kty: "OKP",
          crv: "Ed25519",
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
    },
  },
}));

const { TinyCloudWeb } = require("../src/modules/tcw");
const { BrowserWasmBindings } = require("../src/adapters/BrowserWasmBindings");
const { BrowserSessionStorage } = require("../src/adapters/BrowserSessionStorage");
const { restoreDataFromPersisted } = require("../src/modules/browserSessionPersistence");
const { TinyCloudNode, NodeWasmBindings, PrivateKeySigner } = require("@tinycloud/node-sdk");
async function persistedRealSession(host: string, privateKey = PROOF_PRIVATE_KEY) {
  const proof = await signedRestorableSession({
    privateKey,
    abilities: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/sync"] } },
  });
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(privateKey);
  const node = new TinyCloudNode({ host, signer, wasmBindings: wasm, autoBootstrapAccount: false });
  const persisted = {
    address: proof.address,
    chainId: proof.chainId,
    sessionKey: JSON.stringify(proof.jwk),
    siwe: proof.siwe,
    signature: proof.signature,
    tinycloudSession: {
      delegationHeader: proof.delegationHeader,
      delegationCid: proof.delegationCid,
      spaceId: proof.spaceId,
      verificationMethod: proof.verificationMethod,
    },
    expiresAt: proof.expiresAt,
    createdAt: proof.siwe.match(/^Issued At: (.+)$/m)![1]!,
    version: "1.0",
    tinycloudHosts: [host],
  };
  return { node, wasm, persisted, address: proof.address, signer };
}
// Shared by the tests below: a localStorage-shaped backend whose removals can be made to fail.
function memoryBackend(failRemoval?: (key: string) => boolean) {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => {
      if (failRemoval?.(key)) throw new Error("storage clear failed");
      entries.delete(key);
    },
    clear: () => entries.clear(),
  } satisfies Storage;
}

async function signedInWeb(host: string, backend: Storage) {
  const { node, persisted, address } = await persistedRealSession(host);
  const storage = new BrowserSessionStorage({ storage: backend });
  await storage.save(address, persisted);
  await node.restoreSession({
    ...persisted.tinycloudSession,
    jwk: JSON.parse(persisted.sessionKey),
    address,
    chainId: persisted.chainId,
    siwe: persisted.siwe,
    signature: persisted.signature,
    expiresAt: persisted.expiresAt,
    tinycloudHosts: persisted.tinycloudHosts,
  });
  const tcw = new TinyCloudWeb({ sessionStorage: storage, includeAccountRegistryPermissions: false });
  await (tcw as any)._initPromise;
  (tcw as any)._node = node;
  return { tcw, node, storage, persisted, address };
}

async function reloadedWeb(backend: Storage) {
  const storage = new BrowserSessionStorage({ storage: backend });
  const tcw = new TinyCloudWeb({ sessionStorage: storage, includeAccountRegistryPermissions: false });
  await (tcw as any)._initPromise;
  return { tcw, storage };
}

describe("signOut ends the session locally first (TC-2379)", () => {
  test("a remote sign-out that never answers still signs out locally, and a reload cannot restore", async () => {
    const backend = memoryBackend();
    const { tcw, node, storage, address } = await signedInWeb("https://fence-hang.test", backend);
    // The node's remote cleanup waits on a queue that never drains, as with a revoked grant.
    (node as any).accountRegistryTail = new Promise<void>(() => undefined);
    const timing = tcw as unknown as { remoteSignOutTimeoutMs: number };
    timing.remoteSignOutTimeoutMs = 25;

    await tcw.signOut();

    expect(tcw.session()).toBeUndefined();
    expect(() => tcw.kv).toThrow("Not signed in");
    expect(storage.exists(address)).toBe(false);
    const reloaded = await reloadedWeb(backend);
    expect((await reloaded.tcw.restoreSession(address)).status).toBe("missing");
  }, 5000);

  test("a clear that throws still fences the session, so a reload cannot restore it", async () => {
    const address = (await persistedRealSession("https://fence-clear.test")).address;
    const backend = memoryBackend((key) => key === `tinycloud:session:${address.toLowerCase()}`);
    const { tcw } = await signedInWeb("https://fence-clear.test", backend);

    await expect(tcw.signOut()).rejects.toThrow("storage clear failed");

    const reloaded = await reloadedWeb(backend);
    expect((await reloaded.tcw.restoreSession(address)).status).toBe("missing");
    expect(reloaded.tcw.session()).toBeUndefined();
  });

  test("only the caller's own session is cleared: a newer saved session for the same address survives", async () => {
    const { tcw, storage, persisted, address } = await signedInWeb("https://fence-own.test", memoryBackend());
    const newer = { ...persisted, signature: `${persisted.signature}-newer` };
    await storage.save(address, newer);

    await tcw.signOut();

    expect(tcw.session()).toBeUndefined();
    const stored = await storage.loadWithStatus(address);
    expect(stored.status).toBe("loaded");
    expect(stored.data?.signature).toBe(newer.signature);
  });

  test("the session being signed out is cleared when it is still the stored one", async () => {
    const { tcw, storage, address } = await signedInWeb("https://fence-self.test", memoryBackend());

    await tcw.signOut();

    expect(storage.exists(address)).toBe(false);
  });

  test("the Node package invalidates a Web-owned adapter before a hung cleanup or storage read", async () => {
    const backend = memoryBackend();
    const { persisted, address } = await persistedRealSession("https://owned-prefix.test");
    const storage = new BrowserSessionStorage({ storage: backend });
    await storage.save(address, persisted);
    const node = new PackageNode({
      host: "https://owned-prefix.test", tinycloudRegistryUrl: null,
      wasmBindings: new PackageWasm(), sessionStorage: storage, autoBootstrapAccount: false,
    });
    await node.restoreSession(restoreDataFromPersisted(persisted));
    const cleanup = Promise.withResolvers<void>();
    (node as any).accountRegistryTail = cleanup.promise;
    storage.load = () => new Promise(() => undefined);
    const signingOut = node.signOut();
    signingOut.catch(() => undefined);
    try {
      // No await: registration must cross the actual package entry point, not merely a local helper.
      expect(backend.getItem(`tinycloud:session:${address.toLowerCase()}`) === null).toBe(true);
      const reloaded = await reloadedWeb(backend);
      expect((await reloaded.tcw.restoreSession(address)).status).toBe("missing");
    } finally {
      cleanup.resolve();
      // Do not strand the baseline's conditional read when the new assertion fails.
      delete storage.load;
    }
  });

  test("a delayed old save cannot resurrect a retired login or overwrite a replacement", async () => {
    const backend = memoryBackend();
    const { persisted, address } = await persistedRealSession("https://owned-retirement.test");
    const storage = new BrowserSessionStorage({ storage: backend });
    await storage.save(address, persisted);
    const node = new PackageNode({
      host: "https://owned-retirement.test", tinycloudRegistryUrl: null,
      wasmBindings: new PackageWasm(), sessionStorage: storage, autoBootstrapAccount: false,
    });
    await node.restoreSession(restoreDataFromPersisted(persisted));
    await node.signOut();
    const fresh = await persistedRealSession("https://owned-retirement.test");
    const replacement = new BrowserSessionStorage({ storage: backend });
    await replacement.save(address, fresh.persisted);
    const refused = await Promise.resolve().then(() => storage.save(address, persisted))
      .then(() => false, (error) => error instanceof Error);
    expect(refused).toBe(true);
    expect((await replacement.load(address))?.signature === fresh.persisted.signature).toBe(true);
  });

  test("repeating a pending sign-out cannot clear another account's new active session", async () => {
    const backend = memoryBackend();
    const { tcw, node, storage, persisted } = await signedInWeb("https://repeat-owner.test", backend);
    const cleanup = Promise.withResolvers<void>();
    (node as any).accountRegistryTail = cleanup.promise;
    const first = tcw.signOut();
    first.catch(() => undefined);
    const proof = await signedRestorableSession({ privateKey: "1".padStart(64, "0") });
    const other = {
      ...persisted, address: proof.address, chainId: proof.chainId,
      sessionKey: JSON.stringify(proof.jwk), siwe: proof.siwe, signature: proof.signature,
      tinycloudSession: {
        delegationHeader: proof.delegationHeader, delegationCid: proof.delegationCid,
        spaceId: proof.spaceId, verificationMethod: proof.verificationMethod,
      },
    };
    await storage.save(proof.address, other);
    const second = tcw.signOut();
    second.catch(() => undefined);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await storage.load(proof.address))?.signature === proof.signature).toBe(true);
      expect(storage.activeAddress() === proof.address.toLowerCase()).toBe(true);
    } finally {
      cleanup.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  test("the separately required Node package preserves legacy conditional-clear compatibility", async () => {
    const backend = memoryBackend();
    const { persisted, address } = await persistedRealSession("https://core-fallback.test");
    const storage = new BrowserSessionStorage({ storage: backend });
    await storage.save(address, persisted);
    const node = new TinyCloudNode({
      host: "https://core-fallback.test", tinycloudRegistryUrl: null,
      wasmBindings: new NodeWasmBindings(), sessionStorage: storage, autoBootstrapAccount: false,
    });
    await node.restoreSession(restoreDataFromPersisted(persisted));
    await node.signOut();
    expect((await storage.load(address)) === null).toBe(true);
    const fresh = await persistedRealSession("https://core-fallback.test");
    await storage.save(address, fresh.persisted);
    expect((await storage.load(address))?.signature === fresh.persisted.signature).toBe(true);
  });

  test("a backend that silently retains the auth record reports incomplete removal while restore stays suppressed", async () => {
    const backend = { ...memoryBackend(), removeItem: () => undefined };
    const { persisted, address } = await persistedRealSession("https://unconfirmed-clear.test");
    const storage = new BrowserSessionStorage({ storage: backend });
    await storage.save(address, persisted);
    const node = new PackageNode({
      host: "https://unconfirmed-clear.test", tinycloudRegistryUrl: null,
      wasmBindings: new PackageWasm(), sessionStorage: storage, autoBootstrapAccount: false,
    });
    await node.restoreSession(restoreDataFromPersisted(persisted));
    const error = await node.signOut().then(() => undefined, (failure) => failure);
    expect(error instanceof Error).toBe(true);
    expect(backend.getItem(`tinycloud:session:${address.toLowerCase()}`) !== null).toBe(true);
    const fresh = await reloadedWeb(backend);
    expect((await fresh.tcw.restoreSession(address)).status).toBe("missing");
  });

  test("default persistence reports unavailable storage without claiming a physical erase", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    try {
      const { node, persisted, address } = await persistedRealSession("https://unavailable-storage.test");
      await node.restoreSession(restoreDataFromPersisted(persisted));
      const client = new TinyCloudWeb({});
      await (client as any)._initPromise;
      (client as any)._node = node;
      const error = await client.signOut().then(() => undefined, (failure: unknown) => failure);
      expect(error instanceof Error).toBe(true);
      expect(client.session() === undefined).toBe(true);
      const fresh = new TinyCloudWeb({});
      await (fresh as any)._initPromise;
      expect((await fresh.restoreSession(address)).status).toBe("storage-unavailable");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("repeating sign-out while only the Web adapter clear is pending preserves another account", async () => {
    const backend = memoryBackend();
    const { persisted, address } = await persistedRealSession("https://web-clear-tail.test");
    const storage = new BrowserSessionStorage({ storage: backend });
    await storage.save(address, persisted);
    const clearing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let clears = 0;
    const legacy = {
      save: (owner: string, data: PersistedSessionData) => storage.save(owner, data),
      load: (owner: string) => storage.load(owner),
      clear: async (owner: string) => {
        if (++clears === 2) { clearing.resolve(); await release.promise; }
        await storage.clear(owner);
      },
      exists: (owner: string) => storage.exists(owner),
      isAvailable: () => storage.isAvailable(),
      activeAddress: () => storage.activeAddress(),
    };
    const node = new PackageNode({
      host: "https://web-clear-tail.test", tinycloudRegistryUrl: null,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new PackageWasm(), sessionStorage: legacy, autoBootstrapAccount: false,
    });
    await node.restoreSession(restoreDataFromPersisted(persisted));
    const client = new TinyCloudWeb({ sessionStorage: legacy });
    await (client as any)._initPromise;
    (client as any)._node = node;
    const first = client.signOut();
    first.catch(() => undefined);
    const nodeFinished = node.signOut();
    await clearing.promise;
    await nodeFinished;
    const other = await persistedRealSession("https://web-clear-tail.test", "1".padStart(64, "0"));
    await storage.save(other.address, other.persisted);
    const second = client.signOut();
    second.catch(() => undefined);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await storage.load(other.address))?.signature === other.persisted.signature).toBe(true);
      expect(storage.activeAddress() === other.address.toLowerCase()).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  test("walletless sign-out uses the verified restored proof to preserve a newer same-account login", async () => {
    const backend = memoryBackend();
    const old = await persistedRealSession("https://walletless-own.test");
    const next = await persistedRealSession("https://walletless-own.test");
    const storage = new BrowserSessionStorage({ storage: backend });
    await storage.save(old.address, next.persisted);
    const node = new PackageNode({
      host: "https://walletless-own.test", tinycloudRegistryUrl: null,
      wasmBindings: new PackageWasm(), sessionStorage: storage, autoBootstrapAccount: false,
    });
    await node.restoreSession(restoreDataFromPersisted(old.persisted));
    const client = new TinyCloudWeb({ sessionStorage: storage });
    await (client as any)._initPromise;
    (client as any)._node = node;
    await client.signOut();
    expect((await storage.load(old.address))?.signature === next.persisted.signature).toBe(true);
    expect(storage.activeAddress() === old.address.toLowerCase()).toBe(true);
  });
});

describe("BrowserSessionStorage signed-out fence", () => {
  test("a fence refuses only the fenced session, and a successful clear lifts it", async () => {
    const { persisted, address } = await persistedRealSession("https://fence-store.test");
    const backend = memoryBackend();
    const storage = new BrowserSessionStorage({ storage: backend });
    await storage.save(address, persisted);

    storage.markSignedOut(address, persisted.signature);

    expect(new BrowserSessionStorage({ storage: backend }).isSignedOut(address, persisted.signature)).toBe(true);
    expect(storage.isSignedOut(address, "0xnewer")).toBe(false);
    await storage.save(address, { ...persisted, signature: "0xnewer" });
    expect(storage.isSignedOut(address, persisted.signature)).toBe(false);

    storage.markSignedOut(address, "0xnewer");
    await storage.clear(address);
    expect(storage.isSignedOut(address, "0xnewer")).toBe(false);
  });
});
