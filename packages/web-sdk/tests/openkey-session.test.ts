import { beforeEach, expect, mock, test } from "bun:test";
import type {
  EstablishOpenKeySessionOptions,
  EstablishOpenKeySessionResult,
} from "../src/openkey-session";

const ADDRESS = "0x31d40B62C395B9418C4198363619B11c65cD406F";
const KEY_ID = "key_personal_1";
const TOKEN = "ok_provider_once_fixture";
const ENDPOINT = "https://openkey.example.test/api/delegate/sign";
const SESSION_PREFIX = "coordinationos:tinycloud:session:v1:" as const;
const CANARY_PATH =
  "coordinationos/integration/v1/XxEf1YZ9gjryBBuLxMubX_/canary";
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
        throw new Error(response.reason ?? "callback rejected");
      }
    }
    return SESSION;
  }
}

mock.module("../src/modules/tcw", () => ({
  TinyCloudWeb: FakeTinyCloudWeb,
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

async function expectStrategyTokenEmpty(fetchImpl: ReturnType<typeof mock>) {
  const strategy = constructedConfigs.at(-1).signStrategy;
  await expect(strategy.handler(VALID_REQUEST)).rejects.toThrow(
    "OpenKey provider token is unavailable",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
}

beforeEach(() => {
  scenario = { restoreStatus: "missing", requests: [VALID_REQUEST] };
  constructedConfigs = [];
  constructorCount = 0;
  kvOperationCount = 0;
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
  expect((init?.headers as Record<string, string>).authorization).toBe(
    `Bearer ${TOKEN}`,
  );
  expect(JSON.parse(String(init?.body))).toEqual({
    ...VALID_REQUEST,
    keyId: KEY_ID,
  });
});

test("a simulated second callback rejects locally after one signer fetch", async () => {
  const signerFetch = mock(async () =>
    new Response(JSON.stringify({ signature: "0xdelegate-signature" }), {
      status: 200,
    }));
  await establishOpenKeySession(options(TOKEN, signerFetch));

  await expect(
    constructedConfigs[0].signStrategy.handler(VALID_REQUEST),
  ).rejects.toThrow("OpenKey provider token is unavailable");
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

test("success clears the helper token source", async () => {
  const signerFetch = mock(async () =>
    new Response(JSON.stringify({ signature: "0xdelegate-signature" })));
  await establishOpenKeySession(options(TOKEN, signerFetch));
  signerFetch.mockClear();
  await expectStrategyTokenEmpty(signerFetch);
});

const failureCases = [
  [
    "HTTP denial",
    mock(async () =>
      new Response(JSON.stringify({ approved: false, reason: "denied" }), {
        status: 403,
      })),
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
      throw new Error(`transport failed ${TOKEN}`);
    }),
    undefined,
  ],
  [
    "SDK failure",
    mock(async () => new Response()),
    new Error(`SDK failed ${TOKEN}`),
  ],
] as const;

test.each(failureCases)(
  "%s clears the helper token source and redacts the top-level error",
  async (_name, signerFetch, sdkFailure) => {
    scenario.sdkFailure = sdkFailure;
    const error = await establishOpenKeySession(
      options(TOKEN, signerFetch as typeof fetch),
    ).catch((caught) => caught as Error);

    expect(error.message).toBe("OpenKey session establishment failed");
    expect(error.message).not.toContain(TOKEN);
    (signerFetch as ReturnType<typeof mock>).mockClear();
    await expectStrategyTokenEmpty(signerFetch as ReturnType<typeof mock>);
  },
);

test("reload restores without a provider token and ten KV operations make zero signer calls", async () => {
  scenario = { restoreStatus: "restored", requests: [] };
  const signerFetch = mock(async () => {
    throw new Error("signer must not be called");
  });

  const result = await establishOpenKeySession(
    options(undefined, signerFetch),
  );
  for (let index = 0; index < 5; index += 1) {
    await (result.client as any).kv.get(CANARY_PATH);
    await (result.client as any).kv.put(CANARY_PATH, { status: "ok" });
  }

  expect(result.status).toBe("restored");
  expect(result.session).toEqual(SESSION);
  expect(kvOperationCount).toBe(10);
  expect(signerFetch).not.toHaveBeenCalled();
});

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
  "https://openkey.example.test/api/delegate/sign?retry=1",
  "https://openkey.example.test/api/delegate/sign#fragment",
  "https://user@openkey.example.test/api/delegate/sign",
  "https://openkey.example.test/api/delegate/sign/",
])("rejects unsafe signing endpoint %s", async (signingEndpoint) => {
  await expect(
    establishOpenKeySession({ ...options(TOKEN), signingEndpoint }),
  ).rejects.toThrow("OpenKey signing endpoint");
  expect(constructorCount).toBe(0);
});
