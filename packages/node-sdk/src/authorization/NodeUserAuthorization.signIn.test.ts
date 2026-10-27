import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  authorizationVerdictOf,
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  type IWasmBindings,
  type ISessionManager,
  type ISigner,
  type TinyCloudSession,
  BOOTSTRAP_SESSION_REQUESTS,
  pkhDid,
  type Manifest,
} from "@tinycloud/sdk-core";
import {
  canonicalizeOpenKeyManifestJson,
  canonicalOpenKeyManifestSha256Hex,
  NodeUserAuthorization,
} from "./NodeUserAuthorization";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { isAppKeyHostBound } from "./appKeyHostBinding";

test("OpenKey manifest digest is stable across JSON formatting and key order", () => {
  const inMemory = {
    manifest_version: 1,
    app_id: "xyz.tinycloud.listen",
    name: "Listen",
    secrets: {
      GOOGLE_MEET_TOKENS: {
        scope: "listen",
        actions: ["read", "write", "delete"],
      },
      READ_ONLY_TOKEN: { scope: "listen" },
    },
  };
  const published = JSON.parse(`{
    "secrets": {
      "READ_ONLY_TOKEN": { "scope": "listen" },
      "GOOGLE_MEET_TOKENS": {
        "actions": ["read", "write", "delete"],
        "scope": "listen"
      }
    },
    "name": "Listen",
    "app_id": "xyz.tinycloud.listen",
    "manifest_version": 1
  }`);

  expect(canonicalizeOpenKeyManifestJson(published)).toBe(
    canonicalizeOpenKeyManifestJson(inMemory),
  );
  expect(canonicalOpenKeyManifestSha256Hex(published)).toBe(
    "9811eb387770f1c0a26f36755a6604741be995692dc97561e2de924bb2ac9c3a",
  );
});

function createSessionManager(): ISessionManager {
  const keys = new Map<string, string>();

  const ensureKey = (id: string): string => {
    if (!keys.has(id)) {
      keys.set(id, JSON.stringify({ kty: "OKP", kid: id }));
    }
    return id;
  };

  return {
    createSessionKey(id: string): string {
      return ensureKey(id);
    },
    replaceSessionKey(jwk: object, keyId: string): string {
      keys.set(keyId, JSON.stringify(jwk));
      return keyId;
    },
    renameSessionKeyId(oldId: string, newId: string): void {
      const value = keys.get(oldId);
      if (value) {
        keys.delete(oldId);
        keys.set(newId, value.replace(`"kid":"${oldId}"`, `"kid":"${newId}"`));
      } else {
        ensureKey(newId);
      }
    },
    getDID(keyId: string): string {
      return `did:key:${keyId}`;
    },
    jwk(keyId: string): string | undefined {
      const existing = keys.get(keyId);
      if (existing) {
        return existing;
      }
      ensureKey(keyId);
      return keys.get(keyId);
    },
  };
}

function createWasmBindings(captured: Array<Record<string, unknown>>): IWasmBindings {
  const sessionManager = createSessionManager();

  return {
    invoke: async () => undefined,
    prepareSession: (params: Record<string, unknown>) => {
      captured.push(params);
      return {
        siwe: [
          `Nonce: ${String(params.nonce ?? "")}`,
          `Issued At: ${String(params.issuedAt)}`,
          `Expiration Time: ${String(params.expirationTime)}`,
        ].join("\n"),
        jwk: params.jwk,
        spaceId: params.spaceId,
        verificationMethod: "did:key:verification",
      };
    },
    completeSessionSetup: () => ({
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy-session",
    }),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, prefix: string) =>
      `${prefix}:${chainId}:${address}`,
    createDelegation: async () => {
      throw new Error("not used");
    },
    generateHostSIWEMessage: () => "",
    siweToDelegationHeaders: () => ({ Authorization: "Bearer host" }),
    protocolVersion: () => 1,
    vault_encrypt: () => new Uint8Array(),
    vault_decrypt: () => new Uint8Array(),
    vault_derive_key: () => new Uint8Array(),
    vault_x25519_from_seed: () => ({ publicKey: new Uint8Array(), privateKey: new Uint8Array() }),
    vault_x25519_dh: () => new Uint8Array(),
    vault_random_bytes: () => new Uint8Array(),
    vault_sha256: () => new Uint8Array(),
    createSessionManager: () => sessionManager,
  };
}

function createSigner(calls: string[]): ISigner {
  return {
    getAddress: async () => "0x1234567890abcdef1234567890abcdef12345678",
    getChainId: async () => 1,
    signMessage: async (message: string) => {
      calls.push(message);
      return "0xsigned";
    },
  };
}

afterEach(() => {
  // Restore the native fetch if a test replaced it.
  if ((globalThis as any).__originalFetch) {
    globalThis.fetch = (globalThis as any).__originalFetch;
    delete (globalThis as any).__originalFetch;
  }
});

async function withSignInHost<T>(run: () => Promise<T>, features: string[] = []): Promise<T> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("manifest keys expand to top-level ReCap resources only when the node lists named keys", async () => {
  const owner = pkhDid("0x1234567890abcdef1234567890abcdef12345678", 1);
  const manifest: Manifest = {
    app_id: "billing", keys_app_id: "xyz.tinycloud.healthlog", name: "Healthlog",
    defaults: false, includePublicSpace: false,
    keys: [
      { prefix: "apps/xyz.tinycloud.healthlog/", abilities: ["key.create", "decrypt"] },
      { path: "apps/xyz.tinycloud.healthlog/token", abilities: ["key.block"] },
    ],
  };
  for (const [caseManifest, features, expected] of [
    [manifest, ["encryption-named-keys-v1"], {
      [`urn:tinycloud:encryption:${owner}:default/apps/xyz.tinycloud.healthlog/`]:
        ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"],
      [`urn:tinycloud:encryption:${owner}:default/apps/xyz.tinycloud.healthlog/token`]:
        ["tinycloud.encryption/key.block"],
    }],
    [manifest, [], {}],
    [{ ...manifest, keys: [] }, ["encryption-named-keys-v1"], {}],
    [{ ...manifest, keys: undefined }, ["encryption-named-keys-v1"], {}],
  ] as const) {
    const captured: Array<Record<string, unknown>> = [];
    const auth = new NodeUserAuthorization({
      signer: createSigner([]), wasmBindings: createWasmBindings(captured),
      signStrategy: { type: "auto-sign" }, domain: "healthlog.tinycloud.xyz",
      tinycloudHosts: ["https://tinycloud.test"], sessionStorage: new MemorySessionStorage(),
      manifest: caseManifest, includeAccountRegistryPermissions: false,
    });
    await withSignInHost(() => auth.signIn(), [...features]);
    const raw = (captured[0]?.rawAbilities ?? {}) as Record<string, string[]>;
    expect(Object.fromEntries(Object.entries(raw).filter(([resource]) => resource.includes("/apps/")))).toEqual(expected);
  }
});

test("a non-binding SIWE host omits manifest key grants and reports their paths", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const auth = new NodeUserAuthorization({
    signer: createSigner([]), wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" }, domain: "billing.example.com",
    siweConfig: { domain: "other.example.com" },
    tinycloudHosts: ["https://tinycloud.test"], sessionStorage: new MemorySessionStorage(),
    manifest: { app_id: "com.example.billing", name: "Billing", defaults: false,
      keys: [{ path: "apps/com.example.billing/token", abilities: ["key.create"] }] },
    includeAccountRegistryPermissions: false,
  });
  await withSignInHost(() => auth.signIn(), ["encryption-named-keys-v1"]);
  expect(auth.unavailableKeyPaths).toEqual(["apps/com.example.billing/token"]);
  expect(Object.keys((captured[0]?.rawAbilities ?? {}) as object).some((path) => path.includes("/apps/"))).toBe(false);
});

test("a non-binding host does not fetch the named-key feature before preparing", async () => {
  const auth = new NodeUserAuthorization({
    signer: createSigner([]), wasmBindings: createWasmBindings([]),
    signStrategy: { type: "auto-sign" }, domain: "localhost",
    tinycloudHosts: ["https://tinycloud.test"], sessionStorage: new MemorySessionStorage(),
    manifest: { app_id: "com.example.billing", name: "Billing", defaults: false,
      keys: [{ path: "apps/com.example.billing/token", abilities: ["decrypt"] }] },
    includeAccountRegistryPermissions: false,
  });
  (auth as any).refreshNodeInfo = async () => { throw new Error("unexpected /info"); };
  await auth.prepareSessionForSigning();
  expect(auth.unavailableKeyPaths).toEqual(["apps/com.example.billing/token"]);
});

test("prepared sign-in with manifest keys resolves hosts from its signer parameters", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const auth = new NodeUserAuthorization({
    signer: createSigner([]), wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" }, domain: "billing.example.com",
    sessionStorage: new MemorySessionStorage(),
    manifest: { app_id: "com.example.billing", name: "Billing", defaults: false,
      keys: [{ path: "apps/com.example.billing/token", abilities: ["decrypt"] }] },
    includeAccountRegistryPermissions: false,
  });
  const hosts: Array<[string, number]> = [];
  (auth as any).resolveTinyCloudHostsForSignIn = async (address: string, chainId: number) => {
    hosts.push([address, chainId]);
    (auth as any).tinycloudHosts = ["https://tinycloud.test"];
  };
  (auth as any).refreshNodeInfo = async () => { (auth as any)._nodeFeatures = ["encryption-named-keys-v1"]; };
  await auth.prepareSessionForSigning();
  expect(hosts[0]?.[0].toLowerCase()).toBe("0x1234567890abcdef1234567890abcdef12345678");
  expect(hosts[0]?.[1]).toBe(1);
  expect((captured[0]?.rawAbilities as Record<string, string[]>)[
    `urn:tinycloud:encryption:${pkhDid(hosts[0]![0], 1)}:default/apps/com.example.billing/token`
  ]).toEqual(["tinycloud.encryption/decrypt"]);
});

test("manifest sign-in without keys keeps full capabilities identical across feature states and skips /info", async () => {
  const captures: Array<Record<string, unknown>> = [];
  for (const features of [[], ["encryption-named-keys-v1"]]) {
    const prepared: Array<Record<string, unknown>> = [];
    const auth = new NodeUserAuthorization({
      signer: createSigner([]), wasmBindings: createWasmBindings(prepared),
      signStrategy: { type: "auto-sign" }, domain: "billing.example.com",
      tinycloudHosts: ["https://tinycloud.test"], sessionStorage: new MemorySessionStorage(),
      manifest: { app_id: "com.example.billing", name: "Billing", defaults: false,
        permissions: [{ service: "tinycloud.kv", path: "records/", actions: ["get"] }] },
      includeAccountRegistryPermissions: false,
    });
    let infoFetches = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/info")) infoFetches++;
      throw new Error(`unexpected fetch: ${String(input)}`);
    };
    try {
      (auth as any)._nodeFeatures = features;
      await auth.prepareSessionForSigning();
    } finally { globalThis.fetch = previousFetch; }
    expect(infoFetches).toBe(0);
    captures.push({ abilities: prepared[0]?.abilities, rawAbilities: prepared[0]?.rawAbilities });
  }
  expect(captures[0]).toEqual(captures[1]);
});

test("regular network sign-in does not invent replica issuance when signed SIWE omits Issued At", async () => {
  const wasm = createWasmBindings([]);
  wasm.prepareSession = (params: Record<string, unknown>) => ({
    siwe: `Expiration Time: ${String(params.expirationTime)}`,
    jwk: params.jwk,
    spaceId: params.spaceId,
    verificationMethod: "did:key:verification",
  });
  let observed: TinyCloudSession | undefined;
  const sessionStorage = new MemorySessionStorage();
  const auth = new NodeUserAuthorization({
    signer: createSigner([]),
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage,
    establishReplicaStamp: async (signedSession) => { observed = signedSession; return undefined; },
  });

  const session = await withSignInHost(() => auth.signIn());
  expect(session.address.toLowerCase()).toBe("0x1234567890abcdef1234567890abcdef12345678");
  expect(observed).toMatchObject({ siwe: session.siwe, signature: session.signature, delegationCid: "bafy-session" });
  expect((await sessionStorage.load(session.address))?.replicaStamp).toBeUndefined();
});

test("prepared network sign-in does not invent replica issuance when SIWE is absent", async () => {
  let observed: TinyCloudSession | undefined;
  const sessionStorage = new MemorySessionStorage();
  const auth = new NodeUserAuthorization({
    signer: createSigner([]),
    wasmBindings: createWasmBindings([]),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage,
    establishReplicaStamp: async (signedSession) => { observed = signedSession; return undefined; },
  });

  const session = await withSignInHost(() => auth.signInWithPreparedSession({
    siwe: undefined as never,
    jwk: { kty: "OKP" },
    spaceId: "space://test",
    verificationMethod: "did:key:verification",
  }, "0xsigned", "default", { kty: "OKP" }));
  expect(session.address.toLowerCase()).toBe("0x1234567890abcdef1234567890abcdef12345678");
  expect(observed).toMatchObject({ siwe: undefined, signature: "0xsigned", delegationCid: "bafy-session" });
  expect((await sessionStorage.load(session.address))?.replicaStamp).toBeUndefined();
});

test("NodeUserAuthorization.signIn keeps constructor siweConfig.nonce when no per-call nonce is provided", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    siweConfig: { nonce: "constructor-nonce" },
  });

  await auth.signIn();

  expect(captured[0]?.nonce).toBe("constructor-nonce");
  expect(signedMessages[0]).toContain("Nonce: constructor-nonce");
});

test("account-only manifest signs into the account space it authorizes", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const auth = new NodeUserAuthorization({
    signer: createSigner([]),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    spacePrefix: "account",
    manifest: {
      app_id: "xyz.tinycloud.account",
      name: "Account",
      defaults: false,
      includePublicSpace: false,
      permissions: [
        { service: "tinycloud.delegation", space: "account", path: "", actions: ["list"], skipPrefix: true },
      ],
    },
  });

  try {
    await auth.signIn();
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(captured[0]?.spaceId).toMatch(/:account$/);
  expect(captured[0]?.abilities).toMatchObject({ delegation: { "": ["tinycloud.delegation/list"] } });
});

test("NodeUserAuthorization.signIn preserves caller defaultActions when merging account parity", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const defaultActions = {
    kv: { "": ["tinycloud.kv/get"] },
  };
  const originalDefaultActions = structuredClone(defaultActions);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    spacePrefix: "account",
    defaultActions,
  });

  try {
    await auth.signIn();
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(defaultActions).toEqual(originalDefaultActions);
  expect(captured[0]?.abilities).toMatchObject({
    kv: {
      "": ["tinycloud.kv/get"],
      "applications/": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
      "spaces/": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
      "system/bootstrap/complete": ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
    delegation: { "": ["tinycloud.delegation/list"] },
    sql: { account: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] },
    capabilities: { "": ["tinycloud.capabilities/read"] },
  });
});

test("NodeUserAuthorization.signIn lets a per-call nonce override siweConfig.nonce", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    siweConfig: { nonce: "constructor-nonce" },
  });

  await auth.signIn({ nonce: "call-nonce" });

  expect(captured[0]?.nonce).toBe("call-nonce");
  expect(captured[0]?.nonce).not.toBe("constructor-nonce");
  expect(signedMessages[0]).toContain("Nonce: call-nonce");
});

test("NodeUserAuthorization.signIn resolves TinyCloud hosts when none are explicit", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith(`${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v1/locations/`)) {
      return new Response("{}", { status: 404 });
    }
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    sessionStorage: new MemorySessionStorage(),
    siweConfig: { nonce: "constructor-nonce" },
  });

  await auth.signIn();

  expect(auth.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  expect(requests).toContain(
    `${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v1/locations/${encodeURIComponent(
      "did:pkh:eip155:1:0x1234567890AbcdEF1234567890aBcdef12345678",
    )}`,
  );
  expect(requests).toContain(`${DEFAULT_TINYCLOUD_FALLBACK_HOST}/info`);
});

function restoredTinyCloudSession(): TinyCloudSession {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    chainId: 1,
    sessionKey: "session-key",
    spaceId: "tinycloud:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:default",
    delegationCid: "bafy-restored",
    delegationHeader: { Authorization: "Bearer restored" },
    verificationMethod: "did:key:restored#restored",
    jwk: { kty: "OKP", kid: "session-key" },
    siwe: "example.com wants you to sign in...",
    signature: "0xrestored",
  };
}

test("restored session adopts persisted hosts WITHOUT the wallet flow and a host-needing call does not throw", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/delegate") && init?.method === "POST") {
      // Primary space already activated — no creation needed.
      return new Response(
        JSON.stringify({ activated: ["space"], skipped: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    sessionStorage: new MemorySessionStorage(),
  });

  // Restore the session with the hosts that were persisted at sign-in time.
  const persistedHosts = ["https://persisted.node.test"];
  auth.setRestoredTinyCloudSession(restoredTinyCloudSession(), persistedHosts);

  // Hosts are adopted immediately, with NO wallet signing and NO registry hit.
  expect(auth.hosts).toEqual(persistedHosts);

  // A host-needing call must NOT throw "hosts have not been resolved".
  await auth.ensureSpaceExists();

  expect(signedMessages.length).toBe(0); // no wallet flow
  // No registry lookup — persisted hosts were used directly.
  expect(
    requests.some((u) => u.startsWith(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL)),
  ).toBe(false);
  // The host-needing call targeted the persisted host.
  expect(requests).toContain(`${persistedHosts[0]}/delegate`);
});

test("restored session with NO persisted hosts lazily resolves via registry/fallback", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith(`${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v1/locations/`)) {
      return new Response("{}", { status: 404 });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ activated: ["space"], skipped: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    sessionStorage: new MemorySessionStorage(),
  });

  // Old persisted session: no hosts supplied on restore.
  auth.setRestoredTinyCloudSession(restoredTinyCloudSession());
  expect(auth.hosts).toEqual([]); // not yet resolved

  // First host-needing call resolves lazily via registry -> fallback.
  await auth.ensureSpaceExists();

  expect(auth.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  expect(requests).toContain(
    `${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v1/locations/${encodeURIComponent(
      "did:pkh:eip155:1:0x1234567890AbcdEF1234567890aBcdef12345678",
    )}`,
  );
  expect(requests).toContain(`${DEFAULT_TINYCLOUD_FALLBACK_HOST}/delegate`);
  expect(signedMessages.length).toBe(0); // still no wallet flow
});

test("ensureSpaceExists records skipped spaces for fresh-account bootstrap detection", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ activated: [], skipped: ["tinycloud:fresh"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });

  await auth.signIn();

  expect(auth.lastActivationSkippedSpaceIds).toEqual(["tinycloud:fresh"]);
});

test("createBootstrapSession mints a signed single-space bootstrap session", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });

  await auth.signIn();
  const session = await auth.createBootstrapSession({
    spaceId: "tinycloud:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:account",
    capabilityRequest: BOOTSTRAP_SESSION_REQUESTS.account,
    rawAbilities: {
      "urn:tinycloud:encryption:did:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:default": [
        "tinycloud.encryption/network.create",
      ],
    },
  });

  expect(session.spaceId).toContain(":account");
  expect(session.delegationCid).toBe("bafy-session");
  expect(captured.at(-1)?.abilities).toEqual({
    kv: {
      "applications/": [
        "tinycloud.kv/get",
        "tinycloud.kv/put",
        "tinycloud.kv/list",
      ],
      "spaces/": [
        "tinycloud.kv/get",
        "tinycloud.kv/put",
        "tinycloud.kv/list",
      ],
    },
    sql: {
      account: [
        "tinycloud.sql/read",
        "tinycloud.sql/write",
        "tinycloud.sql/schema",
      ],
    },
    capabilities: {
      "": ["tinycloud.capabilities/read"],
    },
  });
  expect(captured.at(-1)?.rawAbilities).toEqual({
    "urn:tinycloud:encryption:did:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:default": [
      "tinycloud.encryption/network.create",
    ],
  });
});

// TC-362: the browser's modal handler now gives up on an unanswered dialog and
// rejects. That is only useful if the rejection actually reaches the caller of
// signIn() instead of being swallowed inside ensureSpaceExists.
test("ensureSpaceExists surfaces a space-creation handler rejection", async () => {
  const primarySpaceId = restoredTinyCloudSession().spaceId;
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/delegate") && init?.method === "POST") {
      // The primary space does not exist yet, so the handler is consulted.
      return new Response(
        JSON.stringify({ activated: [], skipped: [primarySpaceId] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    spaceCreationHandler: {
      confirmSpaceCreation: async () => {
        throw new Error("TinyCloud waited 120s for you to confirm");
      },
    },
  });
  auth.setRestoredTinyCloudSession(restoredTinyCloudSession());

  await expect(auth.ensureSpaceExists()).rejects.toThrow(
    "TinyCloud waited 120s for you to confirm",
  );
  // The space was never hosted, so no wallet signature was requested.
  expect(signedMessages.length).toBe(0);
});

test("ensureSpaceExists preserves the failed activation status and body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Unauthorized Action: denied", { status: 403 });
  const auth = new NodeUserAuthorization({
    signer: createSigner([]),
    wasmBindings: createWasmBindings([]),
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });
  auth.setRestoredTinyCloudSession(restoredTinyCloudSession());

  try {
    await auth.ensureSpaceExists().then(
      () => { throw new Error("expected activation failure"); },
      (error: unknown) => {
        expect((error as Error).message).toContain("403 - Unauthorized Action: denied");
        expect((error as Error & { cause: { status: number; error: string } }).cause).toMatchObject({
          success: false,
          status: 403,
          error: "Unauthorized Action: denied",
        });
        expect(authorizationVerdictOf(error)).toBe("forbidden");
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensureSpaceExists retains the failed retry verdict after creating a skipped space", async () => {
  const session = restoredTinyCloudSession();
  const originalFetch = globalThis.fetch;
  let activations = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/peer/generate/")) {
      return new Response("peer-id");
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      activations++;
      if (activations === 1) {
        return new Response(JSON.stringify({ activated: [], skipped: [session.spaceId] }), { status: 200 });
      }
      if (activations === 2) {
        return new Response(JSON.stringify({ activated: [session.spaceId], skipped: [] }), { status: 200 });
      }
      return new Response("session expired", { status: 401 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const auth = new NodeUserAuthorization({
    signer: createSigner([]),
    wasmBindings: createWasmBindings([]),
    domain: "example.com",
    signStrategy: { type: "auto-sign" },
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    spaceCreationHandler: { confirmSpaceCreation: async () => true },
  });
  auth.setRestoredTinyCloudSession(session);

  try {
    await auth.ensureSpaceExists().then(
      () => { throw new Error("expected activation failure"); },
      (error: unknown) => {
        expect((error as Error).message).toContain("401 - session expired");
        expect((error as Error & { cause: { status: number; error: string } }).cause).toMatchObject({
          success: false,
          status: 401,
          error: "session expired",
        });
        expect(authorizationVerdictOf(error)).toBe("unauthenticated");
      },
    );
    expect(activations).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensureSpaceExists preserves a failed host result instead of collapsing it to a boolean", async () => {
  const session = restoredTinyCloudSession();
  const originalFetch = globalThis.fetch;
  let activations = 0;
  let notified = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/peer/generate/")) return new Response("peer-id");
    if (url.endsWith("/delegate") && init?.method === "POST") {
      activations++;
      if (activations === 1) {
        return new Response(JSON.stringify({ activated: [], skipped: [session.spaceId] }), { status: 200 });
      }
      return new Response("host forbidden", { status: 403 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const auth = new NodeUserAuthorization({
    signer: createSigner([]),
    wasmBindings: createWasmBindings([]),
    domain: "example.com",
    signStrategy: { type: "auto-sign" },
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    spaceCreationHandler: {
      confirmSpaceCreation: async () => true,
      onSpaceCreationFailed: () => { notified++; },
    },
  });
  auth.setRestoredTinyCloudSession(session);
  try {
    await auth.ensureSpaceExists().then(
      () => { throw new Error("expected host failure"); },
      (error: unknown) => {
        expect((error as Error).message).toContain("403 - host forbidden");
        expect((error as Error & { cause: { status: number } }).cause).toMatchObject({ status: 403, success: false });
        expect(authorizationVerdictOf(error)).toBe("forbidden");
      },
    );
    expect(notified).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NodeUserAuthorization default session abilities never include kv/sync or kv/retain", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner([]),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });

  try {
    await auth.signIn();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const actions = Object.values(
    captured[0]?.abilities as Record<string, Record<string, string[]>>,
  ).flatMap((byPath) => Object.values(byPath).flat());
  expect(actions).toContain("tinycloud.kv/get");
  expect(actions).not.toContain("tinycloud.kv/sync");
  expect(actions).not.toContain("tinycloud.kv/retain");
});

test("isAppKeyHostBound agrees with the sign-in key grant for every SIWE domain", async () => {
  const appId = "chat.tinycloud.tinychat";
  const path = `apps/${appId}/token`;
  const table: Array<[string, boolean]> = [
    ["tinycloud.chat", true],
    ["localhost", false],
    ["tauri.localhost", false],
    ["x.pages.dev", false],
    ["evil-tinycloud.chat", false],
    ["tinycloud.chat.evil.com", false],
    ["tinycloud.chat:8443", false],
  ];
  for (const [domain, bound] of table) {
    const captured: Array<Record<string, unknown>> = [];
    const auth = new NodeUserAuthorization({
      signer: createSigner([]), wasmBindings: createWasmBindings(captured),
      signStrategy: { type: "auto-sign" }, domain,
      tinycloudHosts: ["https://tinycloud.test"], sessionStorage: new MemorySessionStorage(),
      manifest: { app_id: appId, name: "Chat", defaults: false, keys: [{ path, abilities: ["decrypt"] }] },
      includeAccountRegistryPermissions: false,
    });
    await withSignInHost(() => auth.signIn(), ["encryption-named-keys-v1"]);
    const granted = Object.keys((captured[0]?.rawAbilities ?? {}) as object).some((resource) => resource.endsWith(`/${path}`));
    expect(granted).toBe(bound);
    expect(auth.unavailableKeyPaths).toEqual(bound ? [] : [path]);
    expect(isAppKeyHostBound(appId, domain)).toBe(bound);
    expect(isAppKeyHostBound(appId, `https://${domain}`)).toBe(bound);
  }
});
