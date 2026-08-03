import { beforeEach, expect, mock, test } from "bun:test";
import type { PersistedSessionData } from "@tinycloud/sdk-core";
import type {
  EstablishOpenKeySessionOptions,
  EstablishOpenKeySessionResult,
} from "../src/openkey-session";

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
    prepareSession: () => ({}),
    completeSessionSetup: () => ({
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy-session",
    }),
    invoke: async () => ({}),
    invokeAny: async () => ({}),
    createDelegation: () => ({}),
    parseRecapFromSiwe: () => [],
    parseVerifiedRecapFromSiwe: () => [
      {
        service: "kv",
        space: `tinycloud:pkh:eip155:1:${ADDRESS}:applications`,
        path: CANARY_PATH,
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        caveats: [],
      },
    ],
    validatePersistedSession: () => ({
      verifiedRecap: [
        {
          service: "kv",
          space: `tinycloud:pkh:eip155:1:${ADDRESS}:applications`,
          path: CANARY_PATH,
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
          caveats: [],
        },
      ],
    }),
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
      private restoredJwk?: object;
      createSessionKey(id: string) { return id; }
      replaceSessionKey(jwk: object, keyId: string) { this.restoredJwk = jwk; return keyId; }
      listSessionKeys() { return ["default", "share-recipient"]; }
      renameSessionKeyId() {}
      getDID(keyId: string) { return `did:key:${keyId}`; }
      jwk() {
        return JSON.stringify(this.restoredJwk ?? {
          kty: "OKP",
          crv: "Ed25519",
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          d: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        });
      }
    },
  },
}));

const { TinyCloudWeb: RealTinyCloudWeb } = require("../src/modules/tcw");
const { BrowserSessionStorage } = require("../src/adapters/BrowserSessionStorage");

const ADDRESS = "0x31d40B62C395B9418C4198363619B11c65cD406F";
const KEY_ID = "key_personal_1";
const TOKEN = "ok_provider_once_fixture";
const ENDPOINT = "https://openkey.example.test/api/delegate/sign";
const SESSION_PREFIX = "coordinationos:tinycloud:session:v1:" as const;
const CANARY_PATH =
  "coordinationos/integration/v1/XxEf1YZ9gjryBBuLxMubX_/canary";
const INVITE_CODE_PATH =
  "coordinationos/integration/v1/XxEf1YZ9gjryBBuLxMubX_/invite-code";
const MANIFEST = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.coordinationos",
  name: "CoordinationOS",
  space: "applications",
  prefix: "",
  defaults: false,
  expiry: "1h",
  permissions: [
    {
      service: "tinycloud.kv",
      space: "applications",
      path: CANARY_PATH,
      actions: ["get", "put"],
    },
  ],
} as const;
const INVITE_MANIFEST = {
  ...MANIFEST,
  permissions: [
    ...MANIFEST.permissions,
    {
      service: "tinycloud.kv",
      space: "applications",
      path: INVITE_CODE_PATH,
      actions: ["get", "put"],
    },
  ],
} as const;
const SESSION = {
  address: ADDRESS,
  walletAddress: ADDRESS,
  chainId: 1,
  sessionKey: "session-key",
  siwe: "siwe",
  signature: "0xsignature",
};
const VALID_REQUEST = {
  address: ADDRESS,
  chainId: 1,
  message: "exact TinyCloud SIWE",
  type: "siwe" as const,
  purpose: "sign-in" as const,
};

type RestoreStatus =
  | "restored"
  | "missing"
  | "expired"
  | "corrupt"
  | "storage-unavailable"
  | "restore-failed"
  | "stale"
  | "disabled";

interface Scenario {
  restoreStatus: RestoreStatus;
  requests?: Array<Record<string, unknown>>;
  sdkFailure?: Error;
}

let scenario: Scenario = {
  restoreStatus: "missing",
  requests: [VALID_REQUEST],
};
let constructedConfigs: any[];
let constructorCount: number;
let kvOperationCount: number;
let useRealTinyCloudWeb: boolean;
let realPersistenceEnabled: boolean;
let realSignerCallbackCount: number;
let realRestoreCount: number;

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function persistedSession(
  overrides: Partial<PersistedSessionData> = {},
): PersistedSessionData {
  const now = new Date();
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: JSON.stringify({
      kty: "OKP",
      crv: "Ed25519",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      d: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    }),
    siwe: "persisted CoordinationOS SIWE",
    signature: "0xpersisted-signature",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer persisted-delegation" },
      delegationCid: "bafy-persisted-coordinationos",
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:applications`,
      spaces: {
        applications: `tinycloud:pkh:eip155:1:${ADDRESS}:applications`,
      },
      verificationMethod: "did:key:default",
    },
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    tinycloudHosts: ["https://tinycloud.example.test"],
    version: "1.0",
    ...overrides,
  };
}

class FakeTinyCloudWeb {
  config: any;
  scenario: Scenario;
  kv = {
    get: mock(async () => {
      kvOperationCount += 1;
      return { ok: true, data: { data: { status: "ok" } } };
    }),
    put: mock(async () => {
      kvOperationCount += 1;
      return { ok: true, data: { data: undefined } };
    }),
  };

  constructor(config: any) {
    constructorCount += 1;
    this.config = config;
    this.scenario = config.__testScenario;
    constructedConfigs.push(config);
  }

  async restoreSession() {
    return this.scenario.restoreStatus === "restored"
      ? { status: "restored", session: SESSION }
      : { status: this.scenario.restoreStatus };
  }

  async signIn() {
    if (this.scenario.sdkFailure) throw this.scenario.sdkFailure;
    for (const request of this.scenario.requests ?? []) {
      const response = await this.config.signStrategy.handler(request);
      if (!response.approved) {
        const denial = new Error(response.reason ?? "callback rejected");
        Object.defineProperty(denial, "denial", {
          enumerable: true,
          value: response,
        });
        throw denial;
      }
    }
    return SESSION;
  }
}

function TinyCloudWebTestSeam(config: any): any {
  if (!useRealTinyCloudWeb) {
    return new FakeTinyCloudWeb(config);
  }

  constructorCount += 1;
  constructedConfigs.push(config);
  const strategy = config.signStrategy;
  const client = new RealTinyCloudWeb({
    ...config,
    ...(realPersistenceEnabled ? {} : { persistSession: false }),
    signStrategy: {
      ...strategy,
      handler: async (request: unknown) => {
        realSignerCallbackCount += 1;
        return strategy.handler(request);
      },
    },
  });
  const restoreSession = client.restoreSession.bind(client);
  client.restoreSession = async (...args: unknown[]) => {
    realRestoreCount += 1;
    return restoreSession(...args);
  };
  return client;
}

mock.module("../src/modules/tcw", () => ({
  TinyCloudWeb: TinyCloudWebTestSeam,
}));

const { establishOpenKeySession } = require("../src/openkey-session") as {
  establishOpenKeySession: (
    options: EstablishOpenKeySessionOptions,
  ) => Promise<EstablishOpenKeySessionResult>;
};

function options(
  providerToken: string | undefined,
  fetchImpl: typeof fetch = mock(async () =>
    new Response(
      JSON.stringify({ approved: true, signature: "0xdelegate-signature" }),
      { status: 200 },
    )),
): EstablishOpenKeySessionOptions {
  return {
    providerToken,
    signingEndpoint: ENDPOINT,
    key: { keyId: KEY_ID, address: ADDRESS, chainId: 1 },
    manifest: MANIFEST as any,
    origin: "https://coordination.example.test",
    sessionExpirationMs: 3600000,
    sessionStorageKeyPrefix: SESSION_PREFIX,
    tinycloud: {
      __testScenario: {
        ...scenario,
        requests: scenario.requests?.map((request) => ({ ...request })),
      },
    } as any,
    fetch: fetchImpl,
  };
}

async function expectStrategyTokenEmpty(
  fetchImpl: ReturnType<typeof mock>,
  sessionEstablished = false,
) {
  const strategy = constructedConfigs.at(-1).signStrategy;
  await expect(strategy.handler(VALID_REQUEST)).rejects.toThrow(
    sessionEstablished
      ? "OpenKey callback request is not a credential approval decision"
      : "OpenKey provider token is unavailable",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
}

beforeEach(() => {
  scenario = { restoreStatus: "missing", requests: [VALID_REQUEST] };
  constructedConfigs = [];
  constructorCount = 0;
  kvOperationCount = 0;
  useRealTinyCloudWeb = false;
  realPersistenceEnabled = true;
  realSignerCallbackCount = 0;
  realRestoreCount = 0;
});

test("fresh sign-in sends one unchanged SIWE sign-in body with one Bearer token", async () => {
  const signerFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Response(
      JSON.stringify({ approved: true, signature: "0xdelegate-signature" }),
      { status: 200 },
    ));

  const result = await establishOpenKeySession(options(TOKEN, signerFetch));

  expect(result.status).toBe("established");
  expect(signerFetch).toHaveBeenCalledTimes(1);
  const [url, init] = signerFetch.mock.calls[0];
  expect(url).toBe(ENDPOINT);
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`,
  );
  expect(JSON.parse(String(init?.body))).toEqual({
    ...VALID_REQUEST,
    keyId: KEY_ID,
  });
  expect(constructedConfigs[0].autoBootstrapAccount).toBe(false);
});

test("fresh sign-in grants only the exact canary and invite-code records", async () => {
  const input = options(TOKEN);
  input.manifest = INVITE_MANIFEST as any;

  const result = await establishOpenKeySession(input);

  expect(result.status).toBe("established");
  expect(constructedConfigs[0].capabilityRequest.resources).toEqual([
    {
      service: "tinycloud.kv",
      space: "applications",
      path: CANARY_PATH,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
    {
      service: "tinycloud.kv",
      space: "applications",
      path: INVITE_CODE_PATH,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
  ]);
});

test.each([
  ["invite without canary", [INVITE_MANIFEST.permissions[1]]],
  [
    "unknown extra record",
    [
      ...INVITE_MANIFEST.permissions,
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "coordinationos/integration/v1/extra",
        actions: ["get", "put"],
      },
    ],
  ],
])("rejects %s before construction", async (_name, permissions) => {
  const input = options(TOKEN);
  input.manifest = {...MANIFEST, permissions} as any;

  await expect(establishOpenKeySession(input)).rejects.toThrow(
    "approved CoordinationOS KV records",
  );
  expect(constructorCount).toBe(0);
});

test("a simulated second callback rejects locally after one signer fetch", async () => {
  const signerFetch = mock(async () =>
    new Response(JSON.stringify({ signature: "0xdelegate-signature" }), {
      status: 200,
    }));
  await establishOpenKeySession(options(TOKEN, signerFetch));

  await expect(
    constructedConfigs[0].signStrategy.handler(VALID_REQUEST),
  ).rejects.toThrow("OpenKey callback request is not a credential approval decision");
  expect(signerFetch).toHaveBeenCalledTimes(1);
});

const invalidFirstRequests = [
  ["bootstrap-session", { ...VALID_REQUEST, purpose: "bootstrap-session" }],
  ["bootstrap-host", { ...VALID_REQUEST, purpose: "bootstrap-host" }],
  ["message", { ...VALID_REQUEST, type: "message", purpose: "message" }],
  ["absent-purpose", (({ purpose: _, ...request }) => request)(VALID_REQUEST)],
] as const;

test.each(invalidFirstRequests)(
  "an invalid first %s callback consumes the token and makes zero network calls",
  async (_name, request) => {
    const signerFetch = mock(async () =>
      new Response(JSON.stringify({ signature: "0xdelegate-signature" })));
    scenario.requests = [request];

    await expect(
      establishOpenKeySession(options(TOKEN, signerFetch)),
    ).rejects.toThrow("OpenKey session establishment failed");
    expect(signerFetch).not.toHaveBeenCalled();
    await expectStrategyTokenEmpty(signerFetch);
  },
);

const forbiddenOverrides = [
  "provider",
  "providers",
  "signStrategy",
  "manifest",
  "capabilityRequest",
  "siweConfig",
  "nonce",
  "domain",
  "persistSession",
  "sessionStorage",
  "sessionExpirationMs",
  "sessionStorageKeyPrefix",
  "includeAccountRegistryPermissions",
  "autoCreateSpace",
  "autoBootstrapAccount",
  "spaceCreationHandler",
  "spacePrefix",
  "kvPrefix",
] as const;

test.each(forbiddenOverrides)(
  "rejects forbidden tinycloud override %s before token access or construction",
  async (field) => {
    let tokenReads = 0;
    const signerFetch = mock(async () => new Response());
    const input = options(undefined, signerFetch) as any;
    Object.defineProperty(input, "providerToken", {
      get() {
        tokenReads += 1;
        return TOKEN;
      },
    });
    input.tinycloud = { [field]: "forbidden" };

    await expect(establishOpenKeySession(input)).rejects.toThrow(
      `TinyCloud option "${field}" is controlled by CoordinationOS`,
    );
    expect(tokenReads).toBe(0);
    expect(constructorCount).toBe(0);
    expect(signerFetch).not.toHaveBeenCalled();
  },
);

const typeFixture: EstablishOpenKeySessionOptions = {
  ...options(TOKEN),
  tinycloud: {
    // @ts-expect-error CoordinationOS owns the provider.
    provider: {},
  },
};
void typeFixture;

test("success prevents the one-shot bearer token from being reused", async () => {
  const signerFetch = mock(async () =>
    new Response(JSON.stringify({ signature: "0xdelegate-signature" })));
  await establishOpenKeySession(options(TOKEN, signerFetch));
  signerFetch.mockClear();
  await expectStrategyTokenEmpty(signerFetch, true);
});

const failureCases = [
  [
    "HTTP denial",
    mock(async () =>
      new Response(
        JSON.stringify({
          approved: false,
          reason: `denied ${TOKEN}`,
          error: `denial payload ${TOKEN}`,
        }),
        { status: 403 },
      )),
    undefined,
  ],
  [
    "malformed response",
    mock(async () => new Response("{", { status: 200 })),
    undefined,
  ],
  [
    "thrown fetch",
    mock(async () => {
      const nested = new Error(`nested transport failed ${TOKEN}`);
      const error = new Error(`transport failed ${TOKEN}`, { cause: nested });
      Object.defineProperty(error, "denial", {
        enumerable: true,
        value: { reason: `transport denial ${TOKEN}` },
      });
      throw error;
    }),
    undefined,
  ],
  [
    "SDK failure",
    mock(async () => new Response()),
    new Error(`SDK failed ${TOKEN}`, {
      cause: new Error(`nested SDK failure ${TOKEN}`),
    }),
  ],
] as const;

function observableErrorGraph(value: unknown): string {
  const text: string[] = [];
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    if (
      current === null ||
      current === undefined ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "bigint"
    ) {
      text.push(String(current));
      return;
    }
    if (typeof current === "string") {
      text.push(current);
      return;
    }
    if (typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    text.push(String(current));
    for (const key of Reflect.ownKeys(current)) {
      text.push(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && "value" in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
  return text.join("\n");
}

test.each(failureCases)(
  "%s clears the helper token source and redacts the complete observable error graph",
  async (_name, signerFetch, sdkFailure) => {
    scenario.sdkFailure = sdkFailure;
    const error = await establishOpenKeySession(
      options(TOKEN, signerFetch as typeof fetch),
    ).catch((caught) => caught as Error);

    expect(error.message).toBe("OpenKey session establishment failed");
    expect(error.cause).toBeInstanceOf(Error);
    expect(observableErrorGraph(error)).not.toContain(TOKEN);
    (signerFetch as ReturnType<typeof mock>).mockClear();
    await expectStrategyTokenEmpty(signerFetch as ReturnType<typeof mock>);
  },
);

async function seedRealBrowserPersistence(
  state: "valid" | "missing" | "corrupt" | "expired",
): Promise<MemoryStorage> {
  useRealTinyCloudWeb = true;
  const backend = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: backend,
    writable: true,
  });
  const storage = new BrowserSessionStorage({
    storage: backend,
    keyPrefix: SESSION_PREFIX,
  });
  const storageKey = `${SESSION_PREFIX}${ADDRESS.toLowerCase()}`;

  if (state === "valid") {
    await storage.save(ADDRESS, persistedSession());
  } else if (state === "corrupt") {
    backend.setItem(storageKey, "{not-json");
  } else if (state === "expired") {
    backend.setItem(
      storageKey,
      JSON.stringify(
        persistedSession({
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      ),
    );
  }
  return backend;
}

test("real persisted reload restores through BrowserSessionStorage and ten KV operations make zero signer callbacks", async () => {
  await seedRealBrowserPersistence("valid");
  const signerFetch = mock(async () => {
    throw new Error("signer must not be called");
  });

  const result = await establishOpenKeySession(
    options(undefined, signerFetch),
  );
  (result.client as any)._node._kv = {
    get: mock(async () => {
      kvOperationCount += 1;
      return { ok: true, data: { data: { status: "ok" } } };
    }),
    put: mock(async () => {
      kvOperationCount += 1;
      return { ok: true, data: { data: undefined } };
    }),
  };
  for (let index = 0; index < 5; index += 1) {
    await (result.client as any).kv.get(CANARY_PATH);
    await (result.client as any).kv.put(CANARY_PATH, { status: "ok" });
  }

  expect(result.status).toBe("restored");
  expect(result.session).toEqual(
    expect.objectContaining({ address: ADDRESS, chainId: 1 }),
  );
  expect(result.client).toBeInstanceOf(RealTinyCloudWeb);
  expect((result.client as any).sessionStorage).toBeInstanceOf(
    BrowserSessionStorage,
  );
  expect(realRestoreCount).toBe(2);
  expect(kvOperationCount).toBe(10);
  expect(signerFetch).not.toHaveBeenCalled();
  expect(realSignerCallbackCount).toBe(0);
  expect(
    (result.client as any)._node.getVerifiedSessionCapabilities(),
  ).toEqual([
    {
      service: "tinycloud.kv",
      space: "applications",
      path: CANARY_PATH,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      caveats: [],
    },
  ]);
});

test("real TinyCloudWeb forwards disabled auto-bootstrap into TinyCloudNode", async () => {
  useRealTinyCloudWeb = true;
  realPersistenceEnabled = false;
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const nodeRequests: Array<{ url: string; body: string }> = [];
  const signerFetch = mock(async () =>
    new Response(
      JSON.stringify({ approved: true, signature: "0xdelegate-signature" }),
      { status: 200 },
    ));
  const input = options(TOKEN, signerFetch);
  input.tinycloud = {
    autoDiscoverLocalNode: false,
    tinycloudHosts: ["https://tinycloud.example.test"],
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
    writable: true,
  });
  globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    nodeRequests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "test", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: [], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected TinyCloud request: ${url}`);
  };

  try {
    const result = await establishOpenKeySession(input);

    expect(result.status).toBe("established");
    expect(result.client).toBeInstanceOf(RealTinyCloudWeb);
    expect(result.client.bootstrapStatus).toEqual({
      skipped: true,
      reason: "auto-bootstrap-disabled",
    });
    expect(realSignerCallbackCount).toBe(1);
    expect(signerFetch).toHaveBeenCalledTimes(1);
    // The ordinary primary session performs its own service setup. A bootstrap
    // probe would require another signing callback, and marker I/O would carry
    // the dedicated marker path into an invocation body.
    expect(nodeRequests.filter(({ body }) =>
      body.includes("system/bootstrap/complete"))).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalStorage,
      writable: true,
    });
  }
});

test("real initialized OpenKey session separates auto-sign policy from normal approval", async () => {
  await seedRealBrowserPersistence("valid");
  const automaticDecisions = [
    { approved: true, signature: "0xpolicy-approved" },
    { approved: false, needsApproval: true, reason: "approval required" },
  ];
  const signerFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(init?.credentials).toBe("include");
    return new Response(JSON.stringify(automaticDecisions.shift()), { status: 200 });
  });
  const approvalDecisions = [
    { approved: true },
    { approved: false, reason: "user rejected credential signing" },
  ];
  const requestCredentialApproval = mock(async () => approvalDecisions.shift()!);
  const input = options(undefined, signerFetch);
  input.requestCredentialApproval = requestCredentialApproval;

  const result = await establishOpenKeySession(input);
  const activeNode = (result.client as any)._node;
  expect(activeNode.config.signStrategy.openKeyAutoSign).toBe(true);
  expect(activeNode.config.signStrategy.openKeyRequestApproval).toBe(
    requestCredentialApproval,
  );
  const bytes = new TextEncoder().encode("canonical credential holder binding");
  const automaticallySigned = await activeNode.autoSignCredentialBytes(bytes);
  expect(automaticallySigned).toBeInstanceOf(Uint8Array);
  expect(await activeNode.autoSignCredentialBytes(bytes)).toBeUndefined();
  expect(await activeNode.approveCredentialBytes(bytes)).toBeInstanceOf(Uint8Array);
  await expect(activeNode.approveCredentialBytes(bytes)).rejects.toThrow(
    "user rejected credential signing",
  );
  expect(result.status).toBe("restored");
  expect(signerFetch).toHaveBeenCalledTimes(2);
  expect(requestCredentialApproval).toHaveBeenCalledTimes(2);
});

test.each(["missing", "corrupt", "expired"] as const)(
  "real BrowserSessionStorage reports tokenless %s persistence without OpenKey or signer callbacks",
  async (restoreStatus) => {
    const backend = await seedRealBrowserPersistence(restoreStatus);
    const signerFetch = mock(async () => {
      throw new Error("OpenKey must not be called");
    });

    const result = await establishOpenKeySession(
      options(undefined, signerFetch),
    );

    expect(result.status).toBe(restoreStatus);
    expect(result.client).toBeInstanceOf(RealTinyCloudWeb);
    expect((result.client as any).sessionStorage).toBeInstanceOf(
      BrowserSessionStorage,
    );
    expect(signerFetch).not.toHaveBeenCalled();
    expect(realSignerCallbackCount).toBe(0);
    if (restoreStatus !== "missing") {
      expect(backend.length).toBe(0);
    }
  },
);

test.each([
  "missing",
  "corrupt",
  "expired",
  "stale",
  "storage-unavailable",
  "restore-failed",
  "disabled",
] as const)(
  "tokenless %s persistence returns the exact terminal status without OpenKey",
  async (restoreStatus) => {
    scenario = { restoreStatus };
    const signerFetch = mock(async () => new Response());

    const result = await establishOpenKeySession(
      options(undefined, signerFetch),
    );

    expect(result.status).toBe(restoreStatus);
    expect(signerFetch).not.toHaveBeenCalled();
  },
);

test("a manifest-stale restored session without a token returns stale locally", async () => {
  scenario = { restoreStatus: "restored", requests: [VALID_REQUEST] };
  const signerFetch = mock(async () => new Response());

  const result = await establishOpenKeySession(
    options(undefined, signerFetch),
  );

  expect(result.status).toBe("stale");
  expect(signerFetch).not.toHaveBeenCalled();
});

test("the read-only provider personal_sign fallback always throws", async () => {
  scenario = { restoreStatus: "missing" };
  const result = await establishOpenKeySession(options(undefined));
  const provider = constructedConfigs[0].provider;

  expect(await provider.request({ method: "eth_accounts" })).toEqual([ADDRESS]);
  expect(await provider.request({ method: "eth_requestAccounts" })).toEqual([
    ADDRESS,
  ]);
  expect(await provider.request({ method: "eth_chainId" })).toBe("0x1");
  await expect(
    provider.request({ method: "personal_sign" }),
  ).rejects.toThrow("OpenKey session signing must use the callback strategy");
});

test.each([
  "http://openkey.example.test/api/delegate/sign",
  "http://sub.localhost/api/delegate/sign",
  "http://127.0.0.2/api/delegate/sign",
  "http://2130706433/api/delegate/sign",
  "http://127.1/api/delegate/sign",
  "http://0177.0.0.1/api/delegate/sign",
  "http://0x7f000001/api/delegate/sign",
  "http://127.000.000.001/api/delegate/sign",
  "https://openkey.example.test/api/delegate/sign?retry=1",
  "https://openkey.example.test/api/delegate/sign?",
  "https://openkey.example.test/api/delegate/sign#fragment",
  "https://openkey.example.test/api/delegate/sign#",
  "https://user@openkey.example.test/api/delegate/sign",
  "https://openkey.example.test/api/delegate/sign/",
])("rejects unsafe signing endpoint %s", async (signingEndpoint) => {
  let tokenReads = 0;
  const signerFetch = mock(async () => new Response());
  const input = {
    ...options(undefined, signerFetch),
    signingEndpoint,
  } as EstablishOpenKeySessionOptions;
  Object.defineProperty(input, "providerToken", {
    get() {
      tokenReads += 1;
      return TOKEN;
    },
  });

  await expect(establishOpenKeySession(input)).rejects.toThrow(
    "OpenKey signing endpoint",
  );
  expect(tokenReads).toBe(0);
  expect(constructorCount).toBe(0);
  expect(signerFetch).not.toHaveBeenCalled();
});

test.each([
  "https://coordination.example.test/?",
  "https://coordination.example.test/#",
])("rejects non-canonical origin %s", async (origin) => {
  let tokenReads = 0;
  const signerFetch = mock(async () => new Response());
  const input = {
    ...options(undefined, signerFetch),
    origin,
  } as EstablishOpenKeySessionOptions;
  Object.defineProperty(input, "providerToken", {
    get() {
      tokenReads += 1;
      return TOKEN;
    },
  });

  await expect(establishOpenKeySession(input)).rejects.toThrow(
    "CoordinationOS origin",
  );
  expect(tokenReads).toBe(0);
  expect(constructorCount).toBe(0);
  expect(signerFetch).not.toHaveBeenCalled();
});
