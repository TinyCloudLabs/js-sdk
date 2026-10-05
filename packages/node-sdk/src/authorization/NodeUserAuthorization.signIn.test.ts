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
} from "@tinycloud/sdk-core";
import {
  canonicalizeOpenKeyManifestJson,
  canonicalOpenKeyManifestSha256Hex,
  NodeUserAuthorization,
} from "./NodeUserAuthorization";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

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
