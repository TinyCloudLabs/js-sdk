import { describe, expect, mock, test } from "bun:test";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { ledgerFor } from "../../replica/src/kv-storage/ledger";
import { createIndexedDbLifecycle, inspectReplicaKeyPresence } from "../../replica/src/kv-storage/lifecycle";
import { indexedDbReplicaStorage } from "../../replica/src/kv-storage/client";
import { TinyCloudNode as ReplicationNode, getNodeReplicationLoaders, registerReplicationLoaders } from "@tinycloud/node-sdk/core";
import { assertValidReplicationConfig } from "@tinycloud/node-sdk/replication/authority";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "../../node-sdk/src/test-support/signed-restorable-session";
import { CaveatedDelegationUnsupportedError, composeManifestRequest, pkhDid, signLocationRecord } from "@tinycloud/sdk-core";
import { createMemoryPendingStore } from "../../sdk-services/src/kv/replication/memoryPendingStore";

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
const { dispatchSDKEvent } = require("../src/notifications");
const { TinyCloudNode, NodeWasmBindings, PrivateKeySigner } = require("@tinycloud/node-sdk");

test("optional replica import is inert until one explicit root registration", () => {
  const plugin = require("../src/replica").browserReplicaPlugin;
  const { registerBrowserReplica } = require("../src/modules/replica-wiring");
  const config = {
    replication: { enabled: true, prefixes: ["notes/"], storage: { kind: "indexeddb" } as never },
  };
  expect(() => new TinyCloudWeb(config)).toThrow("registerBrowserReplica");
  registerBrowserReplica(plugin);
  expect(() => registerBrowserReplica(plugin)).toThrow("already registered");
  expect(() => new TinyCloudWeb({ ...config, replication: {
    ...config.replication, grantTtlMs: 8 * 24 * 60 * 60 * 1000,
  } })).toThrow(TypeError);
  expect(() => new TinyCloudWeb({ ...config, replication: {
    ...config.replication, prefixes: ["notes/", "notes/sub/"],
  } })).toThrow(TypeError);
  expect(() => new TinyCloudWeb({ ...config, replication: {
    ...config.replication, prefixes: ["/"],
  } })).toThrow(TypeError);
});

// L2 (#548 security review): the static common gate cannot be swapped at runtime.
test("the browser replica plugin and its registered loaders are immutable", () => {
  const plugin = require("../src/replica").browserReplicaPlugin;
  const originalRecover = plugin.recover;
  const originalAuthority = plugin.loaders.authority;
  const swap = async () => ({});
  expect(Reflect.set(plugin, "recover", swap)).toBe(false);
  expect(Reflect.set(plugin.loaders, "authority", swap)).toBe(false);
  expect(Reflect.set(plugin, "loaders", {})).toBe(false);
  expect(plugin.recover).toBe(originalRecover);
  expect(plugin.loaders.authority).toBe(originalAuthority);

  const registered = getNodeReplicationLoaders();
  expect(registered.authority).toBe(originalAuthority);
  expect(Reflect.set(registered, "authority", swap)).toBe(false);
  expect(registered.authority).toBe(originalAuthority);
});

test("passes persisted additional spaces and expiry through browser restore data", () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const spaces = { public: `tinycloud:pkh:eip155:1:${address}:public` };

  const restored = restoreDataFromPersisted({
    address,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
    siwe: "siwe",
    signature: "signature",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer persisted" },
      delegationCid: "bafy-persisted",
      spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
      spaces,
      verificationMethod: "did:key:zPersisted#zPersisted",
    },
    expiresAt,
    createdAt: "2026-01-01T00:00:00.000Z",
    version: "1.0",
  });

  expect(restored.spaces).toEqual(spaces);
  expect(restored.expiresAt).toBe(expiresAt);
});

test("browser session managers expose every live key before restore can replace one", () => {
  const manager = new BrowserWasmBindings().createSessionManager();

  expect(manager.listSessionKeys?.()).toEqual(["default", "share-recipient"]);
});

test("forwards signStrategy to the underlying TinyCloudNode", async () => {
  const signStrategy = {
    type: "callback",
    openKeyAutoSign: true,
    handler: mock(async () => ({ approved: true, signature: "0x1234" })),
  };
  const tcw = new TinyCloudWeb({ signStrategy });

  await (tcw as any)._initPromise;

  expect((tcw as any)._node.config.signStrategy).toBe(signStrategy);
});

test("SIWE domain carries the origin host and port (TC-1488)", async () => {
  const globalWithWindow = globalThis as unknown as { window: { location: unknown } };
  const previousLocation = globalWithWindow.window.location;
  globalWithWindow.window.location = { hostname: "localhost", host: "localhost:5173", origin: "http://localhost:5173" };
  try {
    const tcw = new TinyCloudWeb({});
    const internals = tcw as unknown as { _initPromise: Promise<void>; _node: { config: { domain?: string } } };
    await internals._initPromise;
    expect(internals._node.config.domain).toBe("localhost:5173");
  } finally {
    globalWithWindow.window.location = previousLocation;
  }
});

test("SIWE uri follows the page origin when domain comes from the window (TC-1488)", async () => {
  const globalWithWindow = globalThis as unknown as { window: { location: unknown } };
  const previousLocation = globalWithWindow.window.location;
  const initWithOrigin = async (origin: string, host: string) => {
    globalWithWindow.window.location = { hostname: new URL(origin).hostname, host, origin };
    const tcw = new TinyCloudWeb({});
    const internals = tcw as unknown as { _initPromise: Promise<void>; _node: { config: { uri?: string } } };
    await internals._initPromise;
    return internals._node.config.uri;
  };
  try {
    expect(await initWithOrigin("http://localhost:5173", "localhost:5173")).toBe("http://localhost:5173");
    expect(await initWithOrigin("https://app.example.com", "app.example.com")).toBe("https://app.example.com");
  } finally {
    globalWithWindow.window.location = previousLocation;
  }
});

test("SIWE uri is not defaulted to the page origin when the caller sets domain (TC-1488)", async () => {
  const globalWithWindow = globalThis as unknown as { window: { location: unknown } };
  const previousLocation = globalWithWindow.window.location;
  globalWithWindow.window.location = { hostname: "localhost", host: "localhost:5173", origin: "http://localhost:5173" };
  try {
    const tcw = new TinyCloudWeb({ domain: "app.example.com" });
    const internals = tcw as unknown as { _initPromise: Promise<void>; _node: { config: { uri?: string } } };
    await internals._initPromise;
    expect(internals._node.config.uri).toBeUndefined();
  } finally {
    globalWithWindow.window.location = previousLocation;
  }
});

test("accountAuthorizationCid returns the delegation CID of a restored walletless session", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => ({
      address,
      chainId: 1,
      sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
      siwe: "siwe",
      signature: "signature",
      tinycloudSession: {
        delegationHeader: { Authorization: "Bearer persisted" },
        delegationCid: "bafy-restored-account",
        spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
        verificationMethod: "did:key:default",
      },
      tinycloudHosts: ["https://node.test.local"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      version: "1.0",
    })),
    clear: mock(async () => undefined),
  };
  // No provider: the node has no auth layer, so the restored session is held by the node itself.
  const tcw = new TinyCloudWeb({ sessionStorage: storage });

  const result = await tcw.restoreSession(address);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe("restored");
  expect(tcw.accountAuthorizationCid()).toBe("bafy-restored-account");
});

test("accountAuthorizationCid returns the delegation CID of a wallet sign-in", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const signedMessages: string[] = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        signedMessages.push(String(params?.[0]));
        return "0xsigned";
      }
      throw new Error(`Unexpected wallet request: ${method}`);
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return Response.json({ activated: ["space"], skipped: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  const tcw = new TinyCloudWeb({
    provider,
    persistSession: false,
    tinycloudHosts: ["https://node.test.local"],
  });

  try {
    await tcw.signIn();
    // Settle the background account-registry sync while fetch is still stubbed.
    await tcw._node.waitForAccountRegistrySync();
  } finally {
    globalThis.fetch = originalFetch;
    // Drop the debounced "signed in" event so it cannot fire into a later file's window shim.
    dispatchSDKEvent.cleanup();
  }

  expect(signedMessages).toHaveLength(1);
  expect(tcw.accountAuthorizationCid()).toBe("bafy-signed-in-account");
});

test("keeps a valid persisted session when the loaded binding cannot restore its signer", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => ({
      address,
      chainId: 1,
      sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
      siwe: "siwe",
      signature: "signature",
      tinycloudSession: {
        delegationHeader: { Authorization: "Bearer persisted" },
        delegationCid: "bafy-persisted",
        spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
        verificationMethod: "did:key:zPersisted#zPersisted",
      },
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      version: "1.0",
    })),
    clear: mock(async () => undefined),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;
  (tcw as any)._node = {
    restoreSession: mock(async () => {
      const error = new Error("binding does not support signer replacement") as Error & { code: string };
      error.code = "RESTORE_SESSION_KEY_REPLACEMENT_UNSUPPORTED";
      throw error;
    }),
  };
  (tcw as any)._initPromise = Promise.resolve();

  const result = await tcw.restoreSession(address);

  expect(result.status).toBe("restore-failed");
  expect(result.error?.message).not.toContain("private");
  expect(storage.clear).not.toHaveBeenCalled();
  expect(tcw.sessionRestoreStatus).toBe("restore-failed");
});

test("keeps persisted storage and reports the original rejection when cleanup would fail", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => ({
      address,
      chainId: 1,
      sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
      siwe: "siwe",
      signature: "signature",
      tinycloudSession: {
        delegationHeader: { Authorization: "Bearer persisted" },
        delegationCid: "bafy-persisted",
        spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
        spaces: { public: `tinycloud:pkh:eip155:1:${address}:public` },
        verificationMethod: "did:key:zPersisted#zPersisted",
      },
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      version: "1.0",
    })),
    clear: mock(async () => { throw new Error("storage clear failed"); }),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;
  (tcw as any)._node = {
    restoreSession: mock(async () => { throw new Error("persisted authority rejected"); }),
  };
  (tcw as any)._initPromise = Promise.resolve();

  const result = await tcw.restoreSession(address);

  expect(result.status).toBe("restore-failed");
  expect(result.error?.message).toBe("persisted authority rejected");
  expect(storage.clear).not.toHaveBeenCalled();
  expect(tcw.sessionRestoreStatus).toBe("restore-failed");
});

test("reports storage load exceptions as restore failures without clearing persisted state", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const persisted = { marker: "leave-me-intact" };
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => { throw new Error("storage read failed"); }),
    clear: mock(async () => undefined),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;

  const result = await tcw.restoreSession(address);

  expect(result.status).toBe("restore-failed");
  expect(result.error?.message).toBe("storage read failed");
  expect(storage.clear).not.toHaveBeenCalled();
  expect(persisted).toEqual({ marker: "leave-me-intact" });
  expect(tcw.sessionRestoreStatus).toBe("restore-failed");
});

test("reports browser getItem exceptions as restore failures without attempting storage cleanup", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const removeItem = mock(() => undefined);
  const backend = {
    get length() { return 1; },
    clear: () => undefined,
    getItem: mock(() => { throw new Error("getItem failed"); }),
    key: () => null,
    removeItem,
    setItem: () => undefined,
  } as Storage;
  const tcw = new TinyCloudWeb({
    sessionStorage: new BrowserSessionStorage({ storage: backend }),
  });
  await (tcw as any)._initPromise;

  const result = await tcw.restoreSession(address);

  expect(result.status).toBe("restore-failed");
  expect(result.error?.message).toBe("getItem failed");
  expect(removeItem).not.toHaveBeenCalled();
  expect(tcw.sessionRestoreStatus).toBe("restore-failed");
});

test("signIn refreshes a restored session that does not cover the configured manifest", async () => {
  const tcw = new TinyCloudWeb({
    manifest: {
      app_id: "xyz.tinycloud.secrets",
      name: "TinyCloud Secrets",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.sql",
          space: "secrets",
          path: "default",
          actions: ["read", "write", "schema"],
        },
      ],
    },
  });

  const restoredSession = {
    address: "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1",
    walletAddress: "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1",
    chainId: 1,
    sessionKey: {} as any,
    siwe: "old-siwe",
    signature: "old-signature",
  };
  const freshSession = {
    address: restoredSession.address,
    chainId: 1,
    sessionKey: {} as any,
    siwe: "fresh-siwe",
    signature: "fresh-signature",
  };
  await (tcw as any)._initPromise;

  const node = {
    hasRuntimePermissions: mock(() => false),
    signIn: mock(async () => undefined),
    session: freshSession,
  };

  (tcw as any)._node = node;
  (tcw as any)._initPromise = Promise.resolve();
  (tcw as any).restoreSession = mock(async () => ({
    status: "restored",
    session: restoredSession,
  }));
  (tcw as any).clearPersistedSession = mock(async () => undefined);

  const session = await tcw.signIn();

  expect(node.hasRuntimePermissions).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        service: "tinycloud.sql",
        space: "secrets",
        path: "xyz.tinycloud.secrets/default",
        actions: [
          "tinycloud.sql/read",
          "tinycloud.sql/write",
          "tinycloud.sql/schema",
        ],
      }),
    ]),
  );
  expect((tcw as any).clearPersistedSession).toHaveBeenCalledWith(
    restoredSession.address,
  );
  expect(node.signIn).toHaveBeenCalledTimes(1);
  expect(session.siwe).toBe("fresh-siwe");
  expect(tcw.sessionRestoreStatus).toBe("logging-in");
});

test("a manifest refresh cannot change restore status after signOut()", async () => {
  const tcw = new TinyCloudWeb({
    manifest: {
      app_id: "xyz.tinycloud.secrets",
      name: "TinyCloud Secrets",
      defaults: false,
      permissions: [{ service: "tinycloud.sql", space: "secrets", path: "default", actions: ["read"] }],
    },
  });
  await (tcw as any)._initPromise;
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const cleared = Promise.withResolvers<void>();
  const releaseClear = Promise.withResolvers<void>();
  (tcw as any)._node = {
    hasRuntimePermissions: () => false,
    signIn: mock(async () => undefined),
    signOut: mock(async () => undefined),
  };
  (tcw as any).restoreSession = async () => ({
    status: "restored",
    session: { address, walletAddress: address, chainId: 1, sessionKey: {}, siwe: "old", signature: "old" },
  });
  (tcw as any).clearPersistedSession = async () => {
    cleared.resolve();
    await releaseClear.promise;
  };

  const signingIn = tcw.signIn();
  const rejected = signingIn.catch((error: Error) => error);
  await cleared.promise;
  await tcw.signOut();
  releaseClear.resolve();

  expect((await rejected).message).toContain("cancelled by sign-out");
  expect(tcw.sessionRestoreStatus).toBe("idle");
  expect((tcw as any)._node.signIn).not.toHaveBeenCalled();
});

test("plain restored sessions require all canonical account permissions", async () => {
  const tcw = new TinyCloudWeb();
  const restoredSession = {
    address: "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1",
    walletAddress: "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1",
    chainId: 1,
    sessionKey: {} as any,
    siwe: "canonical-siwe",
    signature: "canonical-signature",
  };
  const hasRuntimePermissions = mock(() => true);
  const node = {
    accountSpaceId: "tinycloud:pkh:eip155:1:0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1:account",
    hasRuntimePermissions,
    signIn: mock(async () => undefined),
    session: restoredSession,
  };

  await (tcw as any)._initPromise;
  (tcw as any)._node = node;
  (tcw as any)._initPromise = Promise.resolve();
  (tcw as any).restoreSession = mock(async () => ({
    status: "restored",
    session: restoredSession,
  }));

  const session = await tcw.signIn();
  const permissions = hasRuntimePermissions.mock.calls[0]?.[0];

  expect(permissions).toHaveLength(6);
  expect(permissions).toEqual(expect.arrayContaining([
    expect.objectContaining({ service: "tinycloud.kv", path: "applications/" }),
    expect.objectContaining({ service: "tinycloud.kv", path: "spaces/" }),
    expect.objectContaining({ service: "tinycloud.kv", path: "system/bootstrap/complete" }),
    expect.objectContaining({ service: "tinycloud.delegation", path: "" }),
    expect.objectContaining({ service: "tinycloud.sql", path: "account" }),
    expect.objectContaining({ service: "tinycloud.capabilities", path: "" }),
  ]));
  expect(node.signIn).not.toHaveBeenCalled();
  expect(session.siwe).toBe("canonical-siwe");
});

test("signOut() ends the session on the TinyCloudWeb instance", async () => {
  const host = "https://signout.test";
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, "default");
  const now = Date.now();
  const expirationTime = new Date(now + 60 * 60_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put"] } },
    address,
    chainId,
    domain: "signout.test",
    issuedAt: new Date(now).toISOString(),
    expirationTime,
    spaceId,
    jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const completed = wasm.completeSessionSetup({ ...prepared, signature });
  // A real node-sdk session; the browser wallet flow is not under test.
  const node = new TinyCloudNode({ host, signer, wasmBindings: wasm, autoBootstrapAccount: false });
  await node.restoreSession({
    delegationHeader: completed.delegationHeader,
    delegationCid: completed.delegationCid,
    spaceId,
    jwk,
    verificationMethod: manager.getDID("default"),
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    expiresAt: expirationTime,
    tinycloudHosts: [host],
  });
  const tcw = new TinyCloudWeb({});
  await (tcw as any)._initPromise;
  (tcw as any)._node = node;

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const kv = tcw.kv;
    expect(tcw.session()).toBeDefined();
    expect(tcw.accountAuthorizationCid()).toBe(completed.delegationCid);
    await kv.get("notes/a");
    const signedInRequests = requests.length;
    expect(signedInRequests).toBeGreaterThan(0);

    await tcw.signOut();

    expect(tcw.session()).toBeUndefined();
    expect(tcw.address()).toBeUndefined();
    expect(() => tcw.accountAuthorizationCid()).toThrow("Not signed in");
    expect(() => tcw.kv).toThrow("Not signed in");
    const stale = await kv.put("notes/b", "after sign-out").catch(() => ({ ok: false }));
    expect(stale.ok).toBe(false);
    expect(requests.length).toBe(signedInRequests);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signOut then signIn uses a fresh wallet SIWE even if another tab restores the old persisted entry", async () => {
  const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
  const address = await signer.getAddress();
  const wasm = Object.assign(new NodeWasmBindings(), { ensureInitialized: async () => undefined });
  const entries = new Map<string, string>();
  const backend = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
  } satisfies Storage;
  const sessionStorage = new BrowserSessionStorage({ storage: backend });
  const signedMessages: string[] = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        signedMessages.push(String(params?.[0]));
        return signer.signMessage(Buffer.from(String(params?.[0]).slice(2), "hex").toString("utf8"));
      }
      throw new Error(`Unexpected wallet request: ${method}`);
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return Response.json({ activated: ["space"], skipped: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  const web = new TinyCloudWeb({
    provider, sessionStorage, tinycloudHosts: ["https://node.test.local"],
    includeAccountRegistryPermissions: false, autoBootstrapAccount: false,
  });
  (web as any).wasmBindings = wasm;
  try {
    await web.signIn();
    const original = await sessionStorage.load(address);
    expect(original).not.toBeNull();
    expect(signedMessages).toHaveLength(1);
    await web.signOut();
    expect(sessionStorage.exists(address)).toBe(false);
    // Another tab can still have a copy; explicit logout must not restore it on this client.
    await sessionStorage.save(address, original!);
    const separatePage = new TinyCloudWeb({
      provider, sessionStorage, tinycloudHosts: ["https://node.test.local"],
      includeAccountRegistryPermissions: false, autoBootstrapAccount: false,
    });
    (separatePage as any).wasmBindings = wasm;
    const restored = await separatePage.restoreSession(address);
    if (restored.status !== "restored") throw restored.error ?? new Error(restored.status);
    expect((await web.restoreSession(address)).status).toBe("restore-failed");
    expect(signedMessages).toHaveLength(1);
    const next = await web.signIn();
    expect(next.address).toBe(address);
    expect(signedMessages).toHaveLength(2);
    expect(web.sessionRestoreStatus).toBe("logging-in");
  } finally {
    globalThis.fetch = originalFetch;
    dispatchSDKEvent.cleanup();
  }
});

test("signIn() does not sign in again after a sign-out during its restore", async () => {
  const tcw = new TinyCloudWeb({});
  await (tcw as any)._initPromise;
  const node = {
    address: undefined,
    signIn: mock(async () => undefined),
    signOut: mock(async () => undefined),
  };
  (tcw as any)._node = node;
  (tcw as any)._initPromise = Promise.resolve();
  (tcw as any).restoreSession = mock(async () => {
    await tcw.signOut();
    return { status: "restore-failed", error: new Error("Session restore was cancelled by sign-out.") };
  });

  await expect(tcw.signIn()).rejects.toThrow("cancelled by sign-out");
  expect(node.signOut).toHaveBeenCalledTimes(1);
  expect(node.signIn).not.toHaveBeenCalled();
});

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
test("implicit signIn ignores persisted wallet A after the connected provider switches to B", async () => {
  const { persisted, address: walletA } = await persistedRealSession("https://wallet-switch.test");
  const walletB = "0x1111111111111111111111111111111111111111";
  const entries = new Map<string, string>();
  const backend = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
  } satisfies Storage;
  const storage = new BrowserSessionStorage({ storage: backend });
  await storage.save(walletA, persisted);
  let connected = walletA;
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [connected];
      throw new Error(`Unexpected wallet request: ${method}`);
    },
  };
  const web = new TinyCloudWeb({ provider, sessionStorage: storage, includeAccountRegistryPermissions: false });
  await (web as any)._initPromise;
  const freshSession = { address: walletB, chainId: 1, sessionKey: {}, siwe: "fresh-B", signature: "signed-B" };
  const node = {
    address: walletA,
    hasRuntimePermissions: () => true,
    restoreSession: mock(async () => undefined),
    signIn: mock(async () => { node.session = freshSession; }),
    session: undefined as typeof freshSession | undefined,
  };
  (web as any)._node = node;
  expect(await (web as any).walletSigner.getConnectedAddress()).toBe(walletA);
  connected = walletB;

  const result = await web.signIn();

  expect(result.address).toBe(walletB);
  expect(node.restoreSession).not.toHaveBeenCalled();
  expect(node.signIn).toHaveBeenCalledTimes(1);
  expect(storage.exists(walletA)).toBe(true);
});

test.each([
  { name: "a different connected wallet", accounts: ["0x1111111111111111111111111111111111111111"], gate: "principal_mismatch" },
  { name: "an unknown wallet", accounts: [], gate: "gate_unavailable" },
  { name: "an unavailable provider", accounts: "error", gate: "gate_unavailable" },
  { name: "the matching wallet", accounts: null, gate: null },
])("explicit restore preserves network authority and matches replica admission for $name", async ({ accounts, gate }) => {
  const { persisted, address, wasm } = await persistedRealSession("https://wallet-restore.test");
  const entries = new Map<string, string>();
  const backend = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
  } satisfies Storage;
  const storage = new BrowserSessionStorage({ storage: backend });
  const stamp = { incarnation: "wallet-restore", lifecycleEpoch: 1 };
  await storage.save(address, { ...persisted, replicaStamp: stamp });
  let restoredStamps = 0;
  let opened = 0;
  const expiresAt = Date.now() + 60_000;
  const lifecycle = {
    kind: "indexeddb" as const,
    recover: async () => ({ erased: [], failed: [], remaining: 0 }),
    restoreSessionStamp: async () => { restoredStamps++; return stamp; },
    checkDelivery: () => ({ status: "allow" as const }),
    consentDeadline: () => expiresAt,
  };
  registerReplicationLoaders({
    validateConfig: assertValidReplicationConfig,
    runtime: () => import("@tinycloud/node-sdk/replication/runtime"),
    authority: () => import("@tinycloud/node-sdk/replication/authority"),
    gatedNetwork: () => import("@tinycloud/node-sdk/replication/gated-network"),
    gate: () => import("@tinycloud/replica/profile-gate"),
  });
  const events: unknown[] = [];
  let activeAccounts = accounts === "error" ? [] : accounts ?? [address];
  let localReads = 0;
  let localLists = 0;
  const provider = { request: async ({ method }: { method: string }) => {
    if (method === "eth_accounts") {
      if (accounts === "error") throw new Error("Wallet unavailable");
      return activeAccounts;
    }
    throw new Error(`Unexpected wallet request: ${method}`);
  } };
  const web = new TinyCloudWeb({
    provider, sessionStorage: storage, tinycloudHosts: ["https://wallet-restore.test"],
    includeAccountRegistryPermissions: false,
    replication: { enabled: true, prefixes: ["notes/"], onEvent: (event: unknown) => events.push(event),
      storage: {
        kind: "indexeddb", lifecycle,
        pendingWrites: () => createMemoryPendingStore({
          host: "https://wallet-restore.test", space: persisted.tinycloudSession.spaceId,
          principal: pkhDid(address, persisted.chainId),
        }),
        open: async (spec: { identity: { principal: string }; prefix: string }) => {
          opened++;
          const grant = {
            cid: "installed-grant", parentCid: null, expiresAt, state: "active" as const,
            unconstrained: true, installedAt: Date.now(), effectiveExpiresAt: expiresAt, consentDeadline: expiresAt,
          };
          const localStatus = {
            coverage: "complete" as const, lastSyncAt: new Date().toISOString(), syncedThroughEpoch: 0,
            authority: { state: "valid" as const, expiresAt },
            grant, counts: { keys: 1, contentMissing: 0, tombstones: 0 }, bytes: 1, lastError: null,
          };
          return {
            spec, deviceDid: spec.identity.principal, replicaId: "opaque-wallet-test",
            grant: async () => grant, status: async () => localStatus,
            sync: async ({ syncStartEpoch }: { syncStartEpoch: number }) => {
              localStatus.syncedThroughEpoch = syncStartEpoch;
              localStatus.lastSyncAt = new Date().toISOString();
              return { status: "synced" as const, pages: 1, changes: 0, deleted: 0, fetched: 0,
                contentMissing: 0, coverage: "complete" as const, syncedThroughEpoch: syncStartEpoch };
            },
            get: async (key: string) => {
              localReads++;
              return {
                status: "present" as const, key, value: new TextEncoder().encode('"local"'),
                etag: '"local"', metadata: { "content-type": "application/json" },
                meta: { asOf: new Date().toISOString(), coverage: "complete" as const,
                  authority: "valid" as const, syncedThroughEpoch: 0 },
              };
            },
            list: async () => {
              localLists++;
              return { keys: ["notes/a"], meta: { asOf: new Date().toISOString(),
                coverage: "complete" as const, authority: "valid" as const, syncedThroughEpoch: 0 } };
            },
            close: async () => undefined,
          };
        },
      } as never },
  });
  (web as any).wasmBindings = wasm;
  const originalFetch = globalThis.fetch;
  let networkReads = 0;
  let offline = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: ["kv-sync-v1"] });
    networkReads++;
    if (offline) throw new Error("Network unavailable during local read");
    return Response.json({ data: "network" });
  }) as typeof fetch;
  try {
    const restored = await web.restoreSession(address);
    expect(restored.status).toBe("restored");
    expect(web.session()?.address).toBe(address);
    expect(restoredStamps).toBe(gate ? 0 : 1);
    const statuses = await web.replication?.status();
    if (gate) expect(statuses).toEqual([expect.objectContaining({ state: "gated", gate, errorCode: "REPLICA_GATED" })]);
    else expect(statuses?.[0]?.state).not.toBe("gated");
    offline = !gate;
    const result = await web.kv.get("notes/a");
    if (gate) {
      expect(networkReads).toBeGreaterThan(0);
      expect(opened).toBe(0);
      expect(events).not.toContainEqual(expect.objectContaining({ type: "replication.read", source: "replica" }));
    } else {
      expect(result.ok && result.data.data).toBe("local");
      expect(opened).toBeGreaterThan(0);
      expect(localReads).toBe(1);
      const localList = await web.kv.list({ path: "notes/" });
      expect(localList.ok && localList.data.keys).toContain("notes/a");
      expect(localLists).toBe(1);
      offline = false;
      activeAccounts = ["0x1111111111111111111111111111111111111111"];
      const before = networkReads;
      await web.kv.get("notes/a");
      expect(networkReads).toBeGreaterThan(before);
      expect(localReads).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "replica_gated" }));
      await web.kv.list({ path: "notes/" });
      expect(localLists).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ type: "replication.read", op: "list", source: "network", reason: "replica_gated" }));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("signOut() clears an explicit pending restore address even without activeAddress()", async () => {
  const { node, persisted, address } = await persistedRealSession("https://restore-race.test");
  let stored: typeof persisted | null = persisted;
  const enteredLoad = Promise.withResolvers<void>();
  const resumeLoad = Promise.withResolvers<void>();
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => {
      enteredLoad.resolve();
      await resumeLoad.promise;
      return stored;
    }),
    clear: mock(async () => { stored = null; }),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;
  (tcw as any)._node = node;

  const restoring = tcw.restoreSession(address);
  await enteredLoad.promise;
  await tcw.signOut();
  resumeLoad.resolve();

  expect((await restoring).status).toBe("restore-failed");
  expect(storage.clear).toHaveBeenCalledWith(address);
  expect(stored).toBeNull();
  expect((await tcw.restoreSession(address)).status).toBe("missing");
  expect(tcw.session()).toBeUndefined();
});

test("signOut() clears an explicit restore started in the same turn", async () => {
  const { node, persisted, address } = await persistedRealSession("https://restore-race.test");
  let stored: typeof persisted | null = persisted;
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => stored),
    clear: mock(async () => { stored = null; }),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;
  (tcw as any)._node = node;

  const restoring = tcw.restoreSession(address);
  await tcw.signOut();

  expect((await restoring).status).toBe("restore-failed");
  expect(storage.clear).toHaveBeenCalledWith(address);
  expect(stored).toBeNull();
  expect((await tcw.restoreSession(address)).status).toBe("missing");
  expect(tcw.session()).toBeUndefined();
});

test("signIn() starting during signOut() cannot reload the session being cleared", async () => {
  const { node, persisted, address } = await persistedRealSession("https://restore-race.test");
  const entries = new Map<string, string>();
  const backend = {
    get length() { return entries.size; },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
  } satisfies Storage;
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
  const registry = Promise.withResolvers<void>();
  (node as any).accountRegistryTail = registry.promise;

  const signingOut = tcw.signOut();
  const signingIn = tcw.signIn();
  const refused = signingIn.catch((error: Error) => error);
  registry.resolve();
  await signingOut;

  expect((await refused).message).toContain("cancelled by sign-out");
  expect(storage.exists(address)).toBe(false);
  expect(tcw.session()).toBeUndefined();
  expect(tcw.sessionRestoreStatus).toBe("idle");
});

test("signOut() cannot retain web authority when node key rotation fails", async () => {
  const { node, wasm, persisted, address } = await persistedRealSession("https://restore-race.test");
  const entries = new Map<string, string>();
  const backend = {
    get length() { return entries.size; },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
  } satisfies Storage;
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
  const tcw = new TinyCloudWeb({ sessionStorage: storage });
  await (tcw as any)._initPromise;
  (tcw as any)._node = node;
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const retainedKv = tcw.kv;
    await retainedKv.get("notes/a");
    const before = requests.length;
    wasm.createSessionManager = () => {
      throw new Error("session manager unavailable");
    };

    await expect(tcw.signOut()).rejects.toThrow("session manager unavailable");

    expect(tcw.session()).toBeUndefined();
    expect(storage.exists(address)).toBe(false);
    expect(() => tcw.kv).toThrow("Not signed in");
    const stale = await retainedKv.put("notes/b", "after failed sign-out").catch(() => ({ ok: false }));
    expect(stale.ok).toBe(false);
    expect(requests.length).toBe(before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed signOut cleanup keeps concurrent sign-outs from restoring stale authority", async () => {
  const { node, persisted, address } = await persistedRealSession("https://restore-race.test");
  const otherAddress = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const entries = new Map<string, string>();
  const blockedKey = `tinycloud:session:${address.toLowerCase()}`;
  const backend = {
    get length() { return entries.size; },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => {
      if (key === blockedKey) throw new Error("storage clear failed");
      entries.delete(key);
    },
    clear: () => entries.clear(),
  } satisfies Storage;
  const storage = new BrowserSessionStorage({ storage: backend });
  await storage.save(address, persisted);
  await storage.save(otherAddress, { ...persisted, address: otherAddress });
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
  const registry = Promise.withResolvers<void>();
  (node as any).accountRegistryTail = registry.promise;

  const first = tcw.signOut();
  const second = tcw.signOut();
  registry.resolve();
  const outcomes = await Promise.allSettled([first, second]);

  expect(outcomes[0].status).toBe("rejected");
  expect(storage.exists(address)).toBe(true);
  expect(storage.exists(otherAddress)).toBe(false);
  expect((await tcw.restoreSession(address)).status).toBe("restore-failed");
  expect(tcw.session()).toBeUndefined();
});

test("a persisted restore that resumes after signOut() does not reinstate the session", async () => {
  const { node, persisted, address } = await persistedRealSession("https://restore-race.test");
  const load = Promise.withResolvers<typeof persisted>();
  const enteredLoad = Promise.withResolvers<void>();
  const storage = {
    save: mock(async () => undefined),
    load: mock(() => { enteredLoad.resolve(); return load.promise; }),
    clear: mock(async () => undefined),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;
  (tcw as any)._node = node;
  (tcw as any)._initPromise = Promise.resolve();
  const nodeRestore = mock(node.restoreSession.bind(node));
  node.restoreSession = nodeRestore;

  const restoring = tcw.restoreSession(address);
  await enteredLoad.promise;
  await tcw.signOut();
  load.resolve(persisted);
  const result = await restoring;

  expect(result.status).toBe("restore-failed");
  expect(result.error?.message).toContain("cancelled by sign-out");
  expect(nodeRestore).not.toHaveBeenCalled();
  expect(tcw.session()).toBeUndefined();
  expect(() => tcw.kv).toThrow("Not signed in");
  expect(tcw.sessionRestoreStatus).toBe("idle");
});

test("signIn() rejects and leaves no session when signOut() lands during its persisted restore", async () => {
  const { node, persisted } = await persistedRealSession("https://restore-race.test");
  const load = Promise.withResolvers<typeof persisted>();
  const enteredLoad = Promise.withResolvers<void>();
  let stored: typeof persisted | null = persisted;
  const storage = {
    save: mock(async () => undefined),
    load: mock(() => { enteredLoad.resolve(); return load.promise; }),
    clear: mock(async () => { stored = null; }),
    activeAddress: () => stored?.address,
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;
  (tcw as any)._node = node;
  (tcw as any)._initPromise = Promise.resolve();
  const nodeSignIn = mock(async () => undefined);
  node.signIn = nodeSignIn;

  const signingIn = tcw.signIn();
  await enteredLoad.promise;
  await tcw.signOut();
  load.resolve(persisted);

  await expect(signingIn).rejects.toThrow("cancelled by sign-out");
  expect(nodeSignIn).not.toHaveBeenCalled();
  expect(stored).toBeNull();
  expect(tcw.session()).toBeUndefined();
  expect(() => tcw.kv).toThrow("Not signed in");
});

test("signOut during real browser gate restore and awaited storage clear cannot reinstate authority", async () => {
  const globals = ["indexedDB", "IDBKeyRange", "localStorage", "navigator"] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const values = new Map<string, string>();
  const backend = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } satisfies Storage;
  const setGlobal = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { configurable: true, value });
  setGlobal("indexedDB", fakeIndexedDB);
  setGlobal("IDBKeyRange", fakeIDBKeyRange);
  setGlobal("localStorage", backend);
  setGlobal("navigator", { locks: { request: (_name: string, options: unknown, section?: () => Promise<unknown>) =>
    (typeof options === "function" ? options : section!)() } });
  const gateEntered = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();
  const clearEntered = Promise.withResolvers<void>();
  const releaseClear = Promise.withResolvers<void>();
  try {
    const { KV_DATABASE } = require("../../replica/src/kv-storage/schema");
    await new Promise<void>((resolve, reject) => {
      const request = fakeIndexedDB.deleteDatabase(KV_DATABASE);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const source = await persistedRealSession("https://restore-race.test");
    const { persisted, address, signer, wasm } = source;
    let pauseClear = true;
    class PausedStorage extends BrowserSessionStorage {
      override async clear(target: string): Promise<void> {
        if (pauseClear) {
          pauseClear = false;
          clearEntered.resolve();
          await releaseClear.promise;
        }
        await super.clear(target);
      }
    }
    const storage = new PausedStorage({ storage: backend });
    await storage.save(address, persisted);
    const realGate = createIndexedDbLifecycle({ ledger: ledgerFor() });
    let pauseRestore = false;
    const lifecycle = {
      ...realGate,
      restoreSessionStamp: async (...args: Parameters<typeof realGate.restoreSessionStamp>) => {
        if (pauseRestore) {
          gateEntered.resolve();
          await releaseGate.promise;
        }
        return realGate.restoreSessionStamp(...args);
      },
    };
    const replicaStorage = indexedDbReplicaStorage({ lifecycle });
    registerReplicationLoaders({
      validateConfig: assertValidReplicationConfig,
      runtime: () => import("@tinycloud/node-sdk/replication/runtime"),
      authority: () => import("@tinycloud/node-sdk/replication/authority"),
      gatedNetwork: () => import("@tinycloud/node-sdk/replication/gated-network"),
      gate: () => import("@tinycloud/replica/profile-gate"),
    });
    const replication = { enabled: true, prefixes: ["notes/"], storage: replicaStorage };
    const node = new ReplicationNode({
      host: "https://restore-race.test",
      signer,
      wasmBindings: wasm,
      autoBootstrapAccount: false,
      sessionStorage: storage,
      replication,
    });
    const web = new TinyCloudWeb({
      sessionStorage: storage,
      includeAccountRegistryPermissions: false,
      replication,
    });
    await (web as any)._initPromise;
    (web as any)._node = node;

    expect((await web.restoreSession(address)).status).toBe("restored");
    expect(storage.exists(address)).toBe(true);
    const stamp = await realGate.establishSessionStamp(pkhDid(address, persisted.chainId), {
      consentAnchor: { source: "siwe", at: Date.parse(persisted.createdAt) },
    });
    await storage.save(address, { ...persisted, replicaStamp: stamp });
    pauseRestore = true;

    const restoring = web.restoreSession(address);
    await gateEntered.promise;
    const signingOut = web.signOut();
    await clearEntered.promise;
    releaseGate.resolve();
    expect((await restoring).status).toBe("restore-failed");
    expect(web.session()).toBeUndefined();
    releaseClear.resolve();
    await signingOut;

    expect(await storage.loadWithStatus(address)).toEqual({ status: "missing", data: null });
    expect(realGate.deliverable(stamp)).toBe(false);
    expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    expect((await web.restoreSession(address)).status).toBe("missing");
  } finally {
    releaseGate.resolve();
    releaseClear.resolve();
    globals.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("a restore waiting for SDK initialisation is cancelled by signOut() before the node exists", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => ({
      address,
      chainId: 1,
      sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "x", d: "d" }),
      siwe: "siwe",
      signature: "signature",
      tinycloudSession: {
        delegationHeader: { Authorization: "Bearer persisted" },
        delegationCid: "bafy-persisted",
        spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
        verificationMethod: "did:key:zPersisted#zPersisted",
      },
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      version: "1.0",
    })),
    clear: mock(async () => undefined),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: storage as any });
  await (tcw as any)._initPromise;
  const init = Promise.withResolvers<void>();
  (tcw as any)._node = undefined;
  (tcw as any)._initPromise = init.promise;
  const node = { restoreSession: mock(async () => undefined), signOut: mock(async () => undefined) };

  const restoring = tcw.restoreSession(address);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tcw.signOut();
  (tcw as any)._node = node;
  init.resolve();
  const result = await restoring;

  expect(result.status).toBe("restore-failed");
  expect(node.restoreSession).not.toHaveBeenCalled();
});

test("useDelegation() and useRuntimeDelegation() waiting for initialisation are cancelled by signOut()", async () => {
  const tcw = new TinyCloudWeb({});
  await (tcw as any)._initPromise;
  const init = Promise.withResolvers<void>();
  (tcw as any)._node = undefined;
  (tcw as any)._initPromise = init.promise;
  const node = {
    useDelegation: mock(async () => ({})),
    useRuntimeDelegation: mock(async () => undefined),
    signOut: mock(async () => undefined),
  };
  const delegation = { cid: "bafy-delegation" };

  const using = tcw.useDelegation(delegation as any).catch((error: Error) => error);
  const usingRuntime = tcw.useRuntimeDelegation(delegation as any).catch((error: Error) => error);
  const signingOut = tcw.signOut();
  (tcw as any)._node = node;
  init.resolve();

  const [delegationError, runtimeError] = await Promise.all([using, usingRuntime]);
  await signingOut;
  expect(delegationError).toBeInstanceOf(Error);
  expect((delegationError as Error).message).toContain("cancelled by sign-out");
  expect(runtimeError).toBeInstanceOf(Error);
  expect((runtimeError as Error).message).toContain("cancelled by sign-out");
  expect(node.useDelegation).not.toHaveBeenCalled();
  expect(node.useRuntimeDelegation).not.toHaveBeenCalled();
});

describe("registryPolicy fail-closed through TinyCloudWeb (TC-1443)", () => {
  const REGISTRY = "https://registry.test";
  const owner = new PrivateKeySigner(PROOF_PRIVATE_KEY);

  /** A persisted walletless session with no hosts, so restore resolves one. */
  async function restoreWithoutHosts(registry: () => Promise<Response>) {
    const address = await owner.getAddress();
    const storage = {
      save: mock(async () => undefined),
      load: mock(async () => ({
        address,
        chainId: 1,
        sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
        siwe: "siwe",
        signature: "signature",
        tinycloudSession: {
          delegationHeader: { Authorization: "Bearer persisted" },
          delegationCid: "bafy-restored-account",
          spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
          verificationMethod: "did:key:default",
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        version: "1.0",
      })),
      clear: mock(async () => undefined),
    };
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith(`${REGISTRY}/`)) return registry();
      throw new TypeError(`unreachable: ${url}`);
    }) as typeof fetch;
    try {
      const tcw = new TinyCloudWeb({
        sessionStorage: storage,
        registryPolicy: "fail-closed",
        tinycloudRegistryUrl: REGISTRY,
        autoDiscoverLocalNode: false,
      });
      return { tcw, result: await tcw.restoreSession(address), requests };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("an unavailable registry fails the restore instead of using the hosted node", async () => {
    const { result, requests } = await restoreWithoutHosts(async () => new Response("down", { status: 503 }));

    expect(result.status).toBe("restore-failed");
    expect(result.error).toMatchObject({ code: "registry_unavailable" });
    expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  });

  test("a registered owner is restored onto the record's host", async () => {
    const { tcw, result } = await restoreWithoutHosts(async () => {
      const record = await signLocationRecord(
        {
          version: 1,
          subject: pkhDid(await owner.getAddress(), 1),
          multiaddrs: ["/dns4/my.node.example/tcp/443/https"],
          updated_at: "2026-10-18T00:00:00.000Z",
          sequence: 1,
        },
        { type: "did:pkh", signMessage: (message: string) => owner.signMessage(message) },
      );
      return Response.json({ record });
    });

    expect(result.status).toBe("restored");
    expect(tcw._node.hosts[0]).toBe("https://my.node.example");
  });
});

describe("signIn refuses caveated manifests (TC-1855)", () => {
  // `tcw` comes from `require`, so it is untyped here; the error class must be the
  // same ESM instance the source throws, hence the static import at the top.
  type Caveats = Array<Record<string, unknown>> | undefined;
  const restoredSession = {
    address: "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1",
    walletAddress: "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1",
    chainId: 1,
    sessionKey: {},
    siwe: "persisted-siwe",
    signature: "persisted-signature",
  };
  const manifestWith = (caveats: Caveats) => ({
    app_id: "xyz.tinycloud.refuse-caveats",
    name: "Refuse caveats",
    defaults: false,
    permissions: [
      {
        service: "tinycloud.kv",
        path: "notes/",
        actions: ["get"],
        ...(caveats === undefined ? {} : { caveats }),
      },
    ],
  });

  async function webWith(config: Record<string, unknown>) {
    const walletRequest = mock(async () => {
      throw new Error("wallet is closed in this test");
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("network is closed in this test");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tcw = new TinyCloudWeb({
      provider: { request: walletRequest },
      includeAccountRegistryPermissions: false,
      autoBootstrapAccount: false,
      ...config,
    });
    await tcw._initPromise;
    walletRequest.mockClear();
    fetchMock.mockClear();
    const node = {
      hasRuntimePermissions: mock(() => true),
      signIn: mock(async () => undefined),
    };
    const restoreSession = mock(async () => ({ status: "restored", session: restoredSession }));
    tcw._node = node;
    tcw.restoreSession = restoreSession;
    return {
      tcw,
      node,
      restoreSession,
      walletRequest,
      fetchMock,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  const constrained: Caveats[] = [
    [{ kind: "prefix", prefix: "notes/" }],
    [{}, { kind: "prefix", prefix: "notes/" }],
    [{}, {}],
  ];

  for (const caveats of constrained) {
    test(`manifest ${JSON.stringify(caveats)}: no restore, wallet request, fetch or node sign-in`, async () => {
      const harness = await webWith({ manifest: manifestWith(caveats) });
      try {
        const error = await harness.tcw.signIn().then(() => undefined, (rejected: unknown) => rejected);

        expect(error).toBeInstanceOf(CaveatedDelegationUnsupportedError);
        expect(error).toMatchObject({ code: "CAVEATED_DELEGATION_UNSUPPORTED" });
        expect(harness.restoreSession).not.toHaveBeenCalled();
        expect(harness.node.hasRuntimePermissions).not.toHaveBeenCalled();
        expect(harness.node.signIn).not.toHaveBeenCalled();
        expect(harness.walletRequest).not.toHaveBeenCalled();
        expect(harness.fetchMock).not.toHaveBeenCalled();
      } finally {
        harness.restore();
      }
    });
  }

  test("a pre-composed capabilityRequest is refused the same way", async () => {
    const harness = await webWith({
      capabilityRequest: composeManifestRequest([manifestWith([{ kind: "prefix", prefix: "notes/" }])], {
        includeAccountRegistryPermissions: false,
      }),
    });
    try {
      const error = await harness.tcw.signIn().then(() => undefined, (rejected: unknown) => rejected);

      expect(error).toBeInstanceOf(CaveatedDelegationUnsupportedError);
      expect(harness.restoreSession).not.toHaveBeenCalled();
      expect(harness.node.signIn).not.toHaveBeenCalled();
      expect(harness.walletRequest).not.toHaveBeenCalled();
      expect(harness.fetchMock).not.toHaveBeenCalled();
    } finally {
      harness.restore();
    }
  });

  for (const caveats of [undefined, [], [{}]] as Caveats[]) {
    test(`manifest ${JSON.stringify(caveats) ?? "without caveats"}: unchanged, still restores`, async () => {
      const harness = await webWith({ manifest: manifestWith(caveats) });
      try {
        const session = await harness.tcw.signIn();

        expect(session).toBe(restoredSession);
        expect(harness.restoreSession).toHaveBeenCalledTimes(1);
        expect(harness.node.hasRuntimePermissions).toHaveBeenCalledTimes(1);
      } finally {
        harness.restore();
      }
    });
  }
});
