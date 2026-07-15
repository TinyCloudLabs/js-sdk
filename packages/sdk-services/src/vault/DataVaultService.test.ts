import { describe, expect, mock, test } from "bun:test";
import { DataVaultService, type VaultCrypto } from "./DataVaultService";
import {
  CURRENT_VAULT_VERSION,
  VaultVersionConfig,
} from "./types";

const spaceId = "tinycloud:pkh:eip155:1:0xabc:default";
const address = "0xabc";
const chainId = 1;

function bytes(input: string, length = 32): Uint8Array {
  const encoded = new TextEncoder().encode(input);
  const output = new Uint8Array(length);
  output.set(encoded.slice(0, length));
  return output;
}

function createVault(calls: string[]): DataVaultService {
  const crypto: VaultCrypto = {
    encrypt: (_key, plaintext) => plaintext,
    decrypt: (_key, blob) => blob,
    deriveKey: (signature, salt, info) =>
      bytes(`${signature.length}:${salt.length}:${info.length}`),
    x25519FromSeed: (seed) => ({
      publicKey: seed.slice(0, 32),
      privateKey: seed.slice(0, 32),
    }),
    x25519Dh: () => bytes("shared-secret"),
    randomBytes: (length) => bytes("random", length),
    sha256: (data) => bytes(`hash:${data.length}`),
  };

  return new DataVaultService({
    spaceId,
    crypto,
    tc: {
      kv: {},
      ensurePublicSpace: async () => ({ ok: true, data: undefined }),
      publicKV: {
        put: async () => ({ ok: true, data: undefined }),
      },
      readPublicSpace: async () => ({
        ok: false,
        error: {
          code: "NOT_FOUND",
          service: "kv",
          message: "missing",
        },
      }),
      makePublicSpaceId: (ownerAddress: string, ownerChainId: number) =>
        `public:${ownerChainId}:${ownerAddress}`,
      did: `did:pkh:eip155:${chainId}:${address}`,
      address,
      chainId,
      hosts: ["https://tinycloud.test"],
    },
  } as any);
}

function createSigner(calls: string[]) {
  return {
    signMessage: async (message: string): Promise<string> => {
      calls.push(message);
      await Promise.resolve();
      return `signature:${message}`;
    },
  };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const networkId = "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";

function createNetworkVault() {
  const store = new Map<string, string>();
  const crypto: VaultCrypto = {
    encrypt: (_key, plaintext) => plaintext,
    decrypt: (_key, blob) => blob,
    deriveKey: (signature, salt, info) =>
      bytes(`${signature.length}:${salt.length}:${info.length}`),
    x25519FromSeed: (seed) => ({
      publicKey: seed.slice(0, 32),
      privateKey: seed.slice(0, 32),
    }),
    x25519Dh: () => bytes("shared-secret"),
    randomBytes: (length) => bytes("random", length),
    sha256: (data) => bytes(`hash:${data.length}`),
  };
  const kv = {
    put: mock(async (key: string, value: string) => {
      store.set(key, value);
      return { ok: true as const, data: undefined };
    }),
    get: mock(async (key: string) => {
      const value = store.get(key);
      if (value === undefined) {
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", service: "kv", message: "missing" },
        };
      }
      return { ok: true as const, data: { data: value } };
    }),
    delete: mock(async (key: string) => {
      const existed = store.delete(key);
      return existed
        ? { ok: true as const, data: undefined }
        : {
            ok: false as const,
            error: { code: "NOT_FOUND", service: "kv", message: "missing" },
          };
    }),
    list: mock(async (options?: { prefix?: string; removePrefix?: boolean }) => {
      const prefix = options?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) =>
          options?.removePrefix ? key.slice(prefix.length) : key,
        );
      return { ok: true as const, data: { keys } };
    }),
  };
  const encryption = {
    initialize: mock(() => {}),
    onSessionChange: mock(() => {}),
    onSignOut: mock(() => {}),
    discoverNetwork: mock(async () => ({
      ok: true as const,
      data: {
        networkId,
        ownerDid: "did:key:z6MkPrincipal",
        name: "default",
        members: [],
        threshold: { n: 1, t: 1 },
        state: "active",
        publicEncryptionKey: "AQID",
        alg: "x25519-aes256gcm/v1",
        keyVersion: 1,
        keyBackend: "local-one-of-one",
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
      },
    })),
    encryptToNetwork: mock(async (
      targetNetworkId: string,
      plaintext: Uint8Array,
      options?: { metadata?: Record<string, string>; aad?: Uint8Array },
    ) => ({
      ok: true as const,
      data: {
        v: 1,
        networkId: targetNetworkId,
        alg: "x25519-aes256gcm/v1",
        keyVersion: 1,
        encryptedSymmetricKey: "AQID",
        encryptedSymmetricKeyHash: "a".repeat(64),
        ciphertext: base64Encode(plaintext),
        ...(options?.aad ? { aad: base64Encode(options.aad) } : {}),
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      },
    })),
    decryptEnvelope: mock(async (envelope: { ciphertext: string }) => ({
      ok: true as const,
      data: base64Decode(envelope.ciphertext),
    })),
  };

  const vault = new DataVaultService({
    spaceId,
    crypto,
    encryption: {
      networkId,
      service: encryption as any,
    },
    tc: {
      kv,
      ensurePublicSpace: async () => ({ ok: true, data: undefined }),
      publicKV: { put: async () => ({ ok: true, data: undefined }) },
      readPublicSpace: async () => ({
        ok: false,
        error: { code: "NOT_FOUND", service: "kv", message: "missing" },
      }),
      makePublicSpaceId: (ownerAddress: string, ownerChainId: number) =>
        `public:${ownerChainId}:${ownerAddress}`,
      did: `did:pkh:eip155:${chainId}:${address}`,
      address,
      chainId,
      hosts: ["https://tinycloud.test"],
    },
  } as any);
  vault.initialize({
    hosts: ["https://tinycloud.test"],
    fetch: fetch as any,
    invoke: (() => ({ Authorization: "Bearer test" })) as any,
    emit: mock(() => {}),
    isAuthenticated: true,
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafy",
      spaceId,
      verificationMethod: "did:key:z6MkSession",
      jwk: {},
    },
  } as any);
  return { vault, store, encryption, kv };
}

describe("DataVaultService.unlock", () => {
  test("dedupes concurrent unlock calls so the signer is prompted once per vault signature", async () => {
    const calls: string[] = [];
    const vault = createVault(calls);
    const signer = createSigner(calls);

    const results = await Promise.all([
      vault.unlock(signer),
      vault.unlock(signer),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(calls).toEqual([
      VaultVersionConfig[CURRENT_VAULT_VERSION].masterMessage(spaceId),
      VaultVersionConfig[CURRENT_VAULT_VERSION].identityMessage,
    ]);
  });

  test("does not prompt the signer again when unlock is repeated after key material is present", async () => {
    const calls: string[] = [];
    const vault = createVault(calls);
    const signer = createSigner(calls);

    const first = await vault.unlock(signer);
    const second = await vault.unlock(signer);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(calls).toEqual([
      VaultVersionConfig[CURRENT_VAULT_VERSION].masterMessage(spaceId),
      VaultVersionConfig[CURRENT_VAULT_VERSION].identityMessage,
    ]);
  });
});

describe("DataVaultService network envelopes", () => {
  test("stores inline envelopes under vault/ without writing keys/", async () => {
    const { vault, store, encryption } = createNetworkVault();

    expect(vault.isUnlocked).toBe(true);
    const put = await vault.put("secrets/API_KEY", { value: "secret" });
    expect(put.ok).toBe(true);
    expect(store.has("vault/secrets/API_KEY")).toBe(true);
    expect([...store.keys()].some((key) => key.startsWith("keys/"))).toBe(false);
    expect(encryption.encryptToNetwork).toHaveBeenCalledWith(
      networkId,
      expect.any(Uint8Array),
      expect.objectContaining({
        metadata: expect.objectContaining({
          "x-vault-version": "2",
          "x-vault-cipher": "tinycloud-network-envelope",
          "x-vault-content-type": "application/json",
        }),
      }),
    );

    const get = await vault.get<{ value: string }>("secrets/API_KEY");
    expect(get.ok).toBe(true);
    expect(get.ok && get.data.value.value).toBe("secret");
    expect(encryption.decryptEnvelope).toHaveBeenCalledTimes(1);
  });

  test("does not create legacy grant blobs in network mode", async () => {
    const { vault, store } = createNetworkVault();

    const put = await vault.put("secrets/API_KEY", { value: "secret" });
    expect(put.ok).toBe(true);
    const grant = await vault.reencrypt("secrets/API_KEY", "did:key:z6MkBackend");

    expect(grant.ok).toBe(false);
    expect([...store.keys()].some((key) => key.startsWith("grants/"))).toBe(false);
  });

});
