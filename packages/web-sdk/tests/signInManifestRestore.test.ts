import { expect, mock, test } from "bun:test";

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
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
  const manager = wasm.createSessionManager();
  const sessionKey = manager.jwk("default")!;
  const jwk = JSON.parse(sessionKey);
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
  const node = new TinyCloudNode({ host, signer, wasmBindings: wasm, autoBootstrapAccount: false });
  const persisted = {
    address,
    chainId,
    sessionKey,
    siwe: prepared.siwe,
    signature,
    tinycloudSession: {
      delegationHeader: completed.delegationHeader,
      delegationCid: completed.delegationCid,
      spaceId,
      verificationMethod: manager.getDID("default"),
    },
    expiresAt: expirationTime,
    createdAt: new Date(now).toISOString(),
    version: "1.0",
    tinycloudHosts: [host],
  };
  return { node, persisted, address };
}

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
