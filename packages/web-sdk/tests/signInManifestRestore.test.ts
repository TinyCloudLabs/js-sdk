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
