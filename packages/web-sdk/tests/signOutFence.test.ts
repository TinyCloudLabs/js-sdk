import { describe, expect, mock, test } from "bun:test";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "../../node-sdk/src/test-support/signed-restorable-session";

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
async function persistedRealSession(host: string) {
  const proof = await signedRestorableSession({
    abilities: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/sync"] } },
  });
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
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
