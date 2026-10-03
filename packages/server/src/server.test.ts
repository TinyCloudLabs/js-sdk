import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  CapabilityKeyRegistry,
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
const AUTH_CASES = [401, 403].flatMap((status) =>
  AUTH_BODIES.flatMap((body) =>
    (["cause", "message"] as const).map((rethrow) => ({ status, body, rethrow })),
  ),
);

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
      if (!result.ok) {
        throw rethrow === "cause"
          ? new Error(result.error.message, { cause: result.error })
          : new Error(result.error.message);
      }
      return result.data;
    });

    if (status === 401) {
      await expect(generate()).resolves.toBeDefined();
    } else {
      await expect(generate()).rejects.toThrow(
        `Failed to register delegation with server: 403 ${body}`,
      );
    }
    expect(generateCalls).toBe(status === 401 ? 2 : 1);
    expect(fetchCalls).toBe(status === 401 ? 2 : 1);
    expect(signInCalls).toBe(status === 401 ? 1 : 0);
  });

  test.each([
    ["typed 401 with a non-session body", Object.assign(new Error("Forbidden"), { status: 401 }), true],
    ["typed 403 with a session body", Object.assign(new Error("session expired"), { meta: { status: 403 } }), false],
    ["typed non-auth status with a 401 body", Object.assign(new Error("401 Unauthorized"), { status: 502 }), false],
    ["AUTH_UNAUTHORIZED without status", { code: "AUTH_UNAUTHORIZED", message: "Unauthorized Action: x / y" }, false],
    ["untyped 401 text", new Error("request failed: 401"), true],
    ["untyped 403 Unauthorized Action text", new Error("403 Unauthorized Action: x / y"), false],
    ["untyped session wording", new Error("session expired"), true],
    ["untyped generic failure", new Error("socket hang up"), false],
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
