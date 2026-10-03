import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  CapabilityKeyRegistry,
  HooksService,
  KVService,
  ServiceContext,
  SharingService,
  type ServiceSession,
} from "@tinycloud/sdk-core";
import {
  NonceStore,
  createServerDelegateClient,
  deriveDstackPrivateKey,
  issueSessionToken,
  parseSecretPayload,
  serverDidForPrivateKey,
  verifySessionToken,
  verifySiweMessage,
  withSessionRefresh,
} from ".";
import type { PortableDelegation, TinyCloudNode } from "@tinycloud/node-sdk";
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);

function siweMessage(address: string, nonce: string): string {
  return [
    "example.com wants you to sign in with your Ethereum account:",
    address,
    "",
    "Sign in to TinyCloud.",
    "",
    "URI: https://example.com",
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,

    "Issued At: 2026-06-28T00:00:00.000Z",
  ].join("\n");
}

const AUTH_BODIES = [
  "",
  "Unauthorized Action: tinycloud:test-space/kv/shared / tinycloud.kv/get",
  "Forbidden",
  "session expired",
  'upstream said "session expired"',
  'upstream said "Forbidden"',
];
const RETHROW_STYLES = ["error", "cause", "message"] as const;
type RethrowStyle = (typeof RETHROW_STYLES)[number];
const AUTH_CASES = [401, 403].flatMap((status) =>
  AUTH_BODIES.flatMap((body) => RETHROW_STYLES.map((rethrow) => ({ status, body, rethrow }))),
);

/** The three ways a caller unwraps a failed `Result` inside `withSessionRefresh`. */
function rethrown(error: { message: string }, style: RethrowStyle): unknown {
  if (style === "error") return error;
  return style === "cause" ? new Error(error.message, { cause: error }) : new Error(error.message);
}

/** Settle `run`, returning the rejection (or undefined when it resolved). */
async function rejectionOf(run: Promise<unknown>): Promise<{ message?: unknown } | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error as { message?: unknown };
  }
}

describe("@tinycloud/server sharing session refresh", () => {
  test.each(AUTH_CASES)("node.sharing.generate $status body=$body rethrown with $rethrow", async ({ status, body, rethrow }) => {
    const registry = new CapabilityKeyRegistry();
    registry.registerKey({
      id: "parent-key",
      did: "did:key:zParent",
      type: "session",
      priority: 0,
    }, [{
      cid: "bafy-parent",
      delegateDID: "did:key:zParent",
      spaceId: "tinycloud:test-space",
      path: "shared",
      actions: ["tinycloud.kv/get"],
      expiry: new Date("2099-01-01T00:00:00.000Z"),
      isRevoked: false,
      allowSubDelegation: true,
    }]);
    let fetchCalls = 0;
    let signedIn = false;
    const sharing = new SharingService({
      hosts: ["https://node.example"],
      session: {
        spaceId: "tinycloud:test-space",
        delegationCid: "bafy-session",
        verificationMethod: "did:key:zSession#zSession",
        jwk: {},
      } as unknown as ServiceSession,
      invoke: (async () => ({})) as never,
      fetch: async () => {
        fetchCalls += 1;
        return signedIn
          ? new Response(null, { status: 200 })
          : new Response(body, { status });
      },
      keyProvider: {
        createSessionKey: () => "share-key",
        getDID: () => "did:key:zShare#zShare",
        getJWK: () => ({
          kty: "OKP",
          crv: "Ed25519",
          x: "share",
          d: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        }),
      } as never,
      registry,
      createKVService: (() => ({})) as never,
      createDelegationWasm: ((params) => ({
        delegation: "share-delegation",
        cid: "bafy-child",
        delegateDID: params.delegateDID,
        expiry: new Date(params.expirationSecs * 1000),
        resources: [{
          service: "kv",
          space: params.spaceId,
          path: "shared",
          actions: ["tinycloud.kv/get"],
        }],
      })) as never,
      computeCid: () => "bafy-child",
    });
    let signInCalls = 0;
    const signIn = async () => {
      signInCalls += 1;
      signedIn = true;
    };
    const node = { sharing, signIn } as unknown as TinyCloudNode;
    let generateCalls = 0;
    const generate = () => withSessionRefresh(node, async () => {
      generateCalls += 1;
      const result = await node.sharing.generate({
        path: "shared",
        actions: ["tinycloud.kv/get"],
      });
      if (!result.ok) throw rethrown(result.error, rethrow);
      return result.data;
    });

    const failure = await rejectionOf(generate());
    if (status === 401) {
      expect(failure).toBeUndefined();
    } else {
      expect(String(failure?.message)).toContain(`Failed to register delegation with server: 403 ${body}`);
    }
    expect(generateCalls).toBe(status === 401 ? 2 : 1);
    expect(fetchCalls).toBe(status === 401 ? 2 : 1);
    expect(signInCalls).toBe(status === 401 ? 1 : 0);
  });

  // Keys whose status-like text or stray quotes disagree with the real status:
  // the (JSON-escaped) key must never decide or hide the status.
  const KV_CASES = AUTH_CASES.flatMap((authCase) =>
    ["shared/item", "report(401)", "report(403)", 'report"', 'report"HTTP 401"x'].map((key) => ({ ...authCase, key })),
  );

  test.each(KV_CASES)("kv.put key=$key $status body=$body rethrown with $rethrow", async ({ key, status, body, rethrow }) => {
    let fetchCalls = 0;
    let signedIn = false;
    const kv = new KVService({});
    kv.initialize(new ServiceContext({
      hosts: ["https://node.example"],
      session: {
        delegationHeader: { Authorization: "Bearer session" },
        delegationCid: "bafy-session",
        spaceId: "tinycloud:test-space",
        verificationMethod: "did:key:zSession#zSession",
        jwk: {},
      },
      invoke: () => ({ Authorization: "Bearer signed-invocation" }),
      fetch: async () => {
        fetchCalls += 1;
        return signedIn ? new Response(null, { status: 200 }) : new Response(body, { status });
      },
    }));
    let signInCalls = 0;
    const node = {
      signIn: async () => {
        signInCalls += 1;
        signedIn = true;
      },
    } as unknown as TinyCloudNode;

    const failure = await rejectionOf(withSessionRefresh(node, async () => {
      const result = await kv.put(key, "value");
      if (!result.ok) throw rethrown(result.error, rethrow);
    }));

    if (status === 401) {
      expect(failure).toBeUndefined();
    } else {
      // The message keeps the HTTP status and the server text for diagnostics.
      expect(String(failure?.message)).toBe(
        `Failed to put key ${JSON.stringify(key)}: 403 - ${body || "authorization failed"}`,
      );
    }
    expect(fetchCalls).toBe(status === 401 ? 2 : 1);
    expect(signInCalls).toBe(status === 401 ? 1 : 0);
  });

  /** Run `failure` through `withSessionRefresh`; report whether it signed in and retried. */
  async function refreshed(failure: unknown): Promise<boolean> {
    let calls = 0;
    let signInCalls = 0;
    const node = { signIn: async () => { signInCalls += 1; } } as unknown as TinyCloudNode;
    const outcome = await rejectionOf(withSessionRefresh(node, async () => {
      calls += 1;
      if (calls === 1) throw failure;
      return "ok";
    }));
    if (signInCalls === 0) expect(outcome).toBe(failure as { message?: unknown });
    expect(calls).toBe(signInCalls + 1);
    return signInCalls === 1;
  }

  test.each([
    ["typed 401 with a non-session body", Object.assign(new Error("Forbidden"), { status: 401 }), true],
    ["typed 403 with a session body", Object.assign(new Error("session expired"), { meta: { status: 403 } }), false],
    ["typed 502 with a 401 body", Object.assign(new Error("failed: 401 Unauthorized"), { status: 502 }), false],
    ["AUTH_UNAUTHORIZED without status", { code: "AUTH_UNAUTHORIZED", message: "session expired" }, false],
  ])("withSessionRefresh typed: %s", async (_name, failure, refreshes) => {
    expect(await refreshed(failure)).toBe(refreshes);
  });

  // Every known message shape, message-only (no typed status). `{s}` formats
  // are SDK producers: they refresh with 401 and never with 403 or 502.
  const STATUS_FORMATS = [
    'Failed to put key "k": {s} - Forbidden',
    'Failed to put key "k": {s} - authorization failed',
    "Failed to create delegation with server: {s}",
    "Failed to register delegation with server: {s} ",
    "Failed to register delegation with server: {s} Unauthorized Action: x / y",
    "SQL query failed: {s} - x",
    "SQL query failed: upstream service returned an HTML error page ({s}).",
    "Share service rejected ({s}): session refused",
    "HTTP {s} from upstream",
    "owner node delegation import returned {s}",
    "Failed to check owned space x: {s}",
    "failed to register webhook: {s} hook ticket expired",
    "failed to list webhooks: {s} Forbidden",
    "V3 share delivery authorization failed: {s}",
    "Failed to get peer ID: {s} - ",
    "upstream returned 200 then failed: {s} - x",
    'Failed to put key "report(403)": {s} - Forbidden',
    'Failed to put key "report(401)": {s} - Forbidden',
    'Failed to put key "report\\"": {s} - upstream said "session expired"',
    'Failed to put key "report\\"HTTP 401\\"x": {s} - Forbidden',
  ];
  const MESSAGE_TABLE: Array<[message: string, refreshes: boolean]> = [
    ...STATUS_FORMATS.flatMap((format): Array<[string, boolean]> => [
      [format.replace("{s}", "401"), true],
      [format.replace("{s}", "403"), false],
      [format.replace("{s}", "502"), false],
    ]),
    // No status: session wording on the unstripped message decides.
    ["session expired while reading /vault/403/item", true],
    ["session expired for request req-403", true],
    ["session expired at https://node.example:403/invoke", true],
    ["session expired after 403 bytes", true],
    ["403 bytes written; session expired", true],
    ["403 records processed; session expired", true],
    ["200 rows fetched; session expired", true],
    ['request failed {"error":"session expired"}', true],
    // Neither a diagnostic status nor session wording, or a status that wins.
    ["Owner delegation import failed: 403 Unauthorized Action", false],
    ["failed to list webhooks: 502 Unauthorized Action", false],
    ['Failed to put key "k": 502 - upstream said: 401 Unauthorized', false],
    ['"vault/401": 500', false],
    ["connect ECONNREFUSED 127.0.0.1:401", false],
    ["wrote 401 bytes", false],
    ["id 401.5", false],
    ["expected 401, got 500", false],
    ["401 records processed; socket hang up", false],
    ["error: 403\nsession expired", false],
    ["session refused by Share (403)", false],
  ];

  test.each(MESSAGE_TABLE)("withSessionRefresh message %j refreshes=%p", async (message, refreshes) => {
    expect(await refreshed(new Error(message))).toBe(refreshes);
  });

  test.each(
    [401, 403].flatMap((status) =>
      ["hook ticket expired", "Unauthorized Action: x / y"].flatMap((body) =>
        RETHROW_STYLES.map((rethrow) => ({ status, body, rethrow })),
      ),
    ),
  )("hooks.list $status body=$body rethrown with $rethrow", async ({ status, body, rethrow }) => {
    let fetchCalls = 0;
    let signedIn = false;
    const hooks = new HooksService({ host: "https://node.example" });
    hooks.initialize(new ServiceContext({
      hosts: ["https://node.example"],
      session: {
        delegationHeader: { Authorization: "Bearer session" },
        delegationCid: "bafy-session",
        spaceId: "tinycloud:test-space",
        verificationMethod: "did:key:zSession#zSession",
        jwk: {},
      },
      invoke: () => ({ Authorization: "Bearer signed-invocation" }),
      fetch: async () => {
        fetchCalls += 1;
        return signedIn ? Response.json({ webhooks: [] }) : new Response(body, { status });
      },
    }));
    let signInCalls = 0;
    const node = {
      signIn: async () => {
        signInCalls += 1;
        signedIn = true;
      },
    } as unknown as TinyCloudNode;

    const failure = await rejectionOf(withSessionRefresh(node, async () => {
      const result = await hooks.list();
      if (!result.ok) throw rethrown(result.error, rethrow);
    }));

    if (status === 403) {
      expect(String(failure?.message)).toBe(`failed to list webhooks: 403 ${body}`);
    }
    expect(fetchCalls).toBe(status === 401 ? 2 : 1);
    expect(signInCalls).toBe(status === 401 ? 1 : 0);
  });
});

describe("@tinycloud/server identity helpers", () => {
  test("derives a stable did:pkh from a raw server private key", () => {
    expect(serverDidForPrivateKey(PRIVATE_KEY)).toBe(`did:pkh:eip155:1:${ACCOUNT.address}`);
  });

  test("hashes dstack key material into an Ethereum private key", async () => {
    const key = await deriveDstackPrivateKey({
      client: { getKey: async () => ({ key: new Uint8Array([1, 2, 3]) }) },
      path: "app/keys/server",
      purpose: "server",
    });

    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("@tinycloud/server SIWE sessions", () => {
  test("verifies exact signed SIWE bytes and returns the embedded nonce", async () => {
    const nonce = "nonce-123";
    const message = siweMessage(ACCOUNT.address, nonce);
    const signature = await ACCOUNT.signMessage({ message });

    await expect(verifySiweMessage(message, signature)).resolves.toEqual({
      address: ACCOUNT.address,
      nonce,
    });
  });

  test("burns address-bound nonces after one validation", () => {
    const store = new NonceStore();
    const nonce = store.issue(ACCOUNT.address);

    expect(store.validate(ACCOUNT.address, nonce)).toBe(true);
    expect(store.validate(ACCOUNT.address, nonce)).toBe(false);
  });

  test("issues and verifies HS256 session tokens", () => {
    const { token, expiresIn } = issueSessionToken(ACCOUNT.address, PRIVATE_KEY, 60);

    expect(expiresIn).toBe(60);
    expect(verifySessionToken(token, PRIVATE_KEY)).toEqual({ address: ACCOUNT.address });
    expect(() => verifySessionToken(token, "wrong-secret")).toThrow(/signature/);
  });
});

describe("@tinycloud/server delegated secrets", () => {
  test("reads the scoped vault path, passes the whole delegation, and decrypts with the activation proof", async () => {
    const envelope = {
      v: 1,
      networkId: "urn:tinycloud:encryption:did:pkh:eip155:1:0xowner:default",
      alg: "x25519-aes256gcm/v1",
      keyVersion: 1,
      encryptedSymmetricKey: "wrapped",
      encryptedSymmetricKeyHash: "hash",
      ciphertext: "ciphertext",
    };
    const delegation = {
      cid: "bafy-original",
      path: "",
      spaceId: "did:pkh:eip155:1:0xowner:secrets",
      actions: ["tinycloud.kv/get", "tinycloud.encryption/decrypt"],
      resources: [
        {
          service: "tinycloud.kv",
          space: "secrets",
          path: "vault/secrets/scoped/githaiku/GITHUB_TOKEN",
          actions: ["tinycloud.kv/get"],
        },
        {
          service: "tinycloud.encryption",
          path: envelope.networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
      ],
    } as unknown as PortableDelegation;
    const calls: string[] = [];

    const client = createServerDelegateClient({
      privateKey: PRIVATE_KEY,
      host: "https://node.example",
      delegation,
      nodeFactory: async () => ({
        signIn: async () => undefined,
        useDelegation: async (actual) => {
          expect(actual).toBe(delegation);
          return {
            delegation: { cid: "bafy-original" },
            restorable: { delegationCid: "bafy-activation" },
            kv: {
              get: async (key, options) => {
                calls.push(key);
                expect(options).toEqual({ raw: true, prefix: "" });
                return { ok: true, data: { data: JSON.stringify(envelope) } };
              },
            },
          };
        },
        encryption: {
          decryptEnvelope: async (actualEnvelope, proof) => {
            expect(actualEnvelope).toEqual(envelope);
            expect(proof).toEqual({ proofs: ["bafy-activation"] });
            return {
              ok: true,
              data: new TextEncoder().encode(JSON.stringify({ value: "ghp_secret" })),
            };
          },
        },
      }),
    });

    await expect(client.getSecret("GITHUB_TOKEN", { scope: "githaiku" })).resolves.toBe(
      "ghp_secret",
    );
    expect(calls).toEqual(["vault/secrets/scoped/githaiku/GITHUB_TOKEN"]);
  });

  test("parses TinyCloud secret payloads", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ value: "secret" }));
    expect(parseSecretPayload(bytes, "API_KEY")).toBe("secret");
  });
});
