import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  CapabilityKeyRegistry,
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

  test.each(AUTH_CASES)("kv.put $status body=$body rethrown with $rethrow", async ({ status, body, rethrow }) => {
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
      const result = await kv.put("shared/item", "value");
      if (!result.ok) throw rethrown(result.error, rethrow);
    }));

    if (status === 401) {
      expect(failure).toBeUndefined();
    } else {
      // The message keeps the HTTP status and the server text for diagnostics.
      expect(String(failure?.message)).toBe(
        `Failed to put key "shared/item": 403 - ${body || "authorization failed"}`,
      );
    }
    expect(fetchCalls).toBe(status === 401 ? 2 : 1);
    expect(signInCalls).toBe(status === 401 ? 1 : 0);
  });

  test.each([
    ["typed 401 with a non-session body", Object.assign(new Error("Forbidden"), { status: 401 }), true],
    ["typed 403 with a session body", Object.assign(new Error("session expired"), { meta: { status: 403 } }), false],
    ["typed non-auth status with a 401 body", Object.assign(new Error("401 Unauthorized"), { status: 502 }), false],
    ["AUTH_UNAUTHORIZED without status", { code: "AUTH_UNAUTHORIZED", message: "Unauthorized Action: x / y" }, false],
    ["untyped status after a colon", new Error("request failed: 401"), true],
    ["untyped KV-format 401", new Error('Failed to put key "k": 401 - Forbidden'), true],
    ["untyped KV-format 403 with session text", new Error('Failed to put key "k": 403 - session expired'), false],
    ["untyped HTTP 401", new Error("HTTP 401 from upstream"), true],
    ["untyped parenthesised 401", new Error("upstream service returned an HTML error page (401)."), true],
    ["untyped leading 403 Unauthorized Action", new Error("403 Unauthorized Action: x / y"), false],
    ["untyped session wording", new Error("session expired"), true],
    ["session wording with 403 in a path", new Error("session expired while reading /vault/403/item"), true],
    ["session wording with 403 in an id", new Error("session expired for request req-403"), true],
    ["session wording with 403 as a port", new Error("session expired at https://node.example:403/invoke"), true],
    ["session wording with a 403 byte count", new Error("session expired after 403 bytes"), true],
    ["401 as a port", new Error("connect ECONNREFUSED 127.0.0.1:401"), false],
    ["401 as a byte count", new Error("wrote 401 bytes"), false],
    ["401 in an expectation", new Error("expected 401, got 500"), false],
  ])("withSessionRefresh: %s", async (_name, failure, refreshes) => {
    let calls = 0;
    let signInCalls = 0;
    const node = { signIn: async () => { signInCalls += 1; } } as unknown as TinyCloudNode;
    const run = withSessionRefresh(node, async () => {
      calls += 1;
      if (calls === 1) throw failure;
      return "ok";
    });

    if (refreshes) {
      await expect(run).resolves.toBe("ok");
    } else {
      await expect(run).rejects.toBe(failure);
    }
    expect(signInCalls).toBe(refreshes ? 1 : 0);
    expect(calls).toBe(refreshes ? 2 : 1);
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
