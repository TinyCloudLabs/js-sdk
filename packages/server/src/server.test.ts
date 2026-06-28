import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  NonceStore,
  createServerDelegateClient,
  deriveDstackPrivateKey,
  issueSessionToken,
  parseSecretPayload,
  serverDidForPrivateKey,
  verifySessionToken,
  verifySiweMessage,
} from ".";
import type { PortableDelegation } from "@tinycloud/node-sdk";

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
