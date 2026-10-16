import { describe, expect, mock, test } from "bun:test";
import { DataVaultService, type VaultCrypto } from "./DataVaultService";
import { authorizationVerdictOf, validatedCapabilityOf } from "../errors";
import {
  CURRENT_VAULT_VERSION,
  VaultVersionConfig,
} from "./types";

const address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const spaceId = `tinycloud:pkh:eip155:1:${address.toLowerCase()}:default`;
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

const networkId = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;

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
      options?: { metadata?: Record<string, string>; aad?: Uint8Array; scope?: { spaceId: string; path: string } },
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
        ...(options?.scope ? { scopeTag: "b".repeat(64) } : {}),
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      },
    })),
    decryptEnvelope: mock(async (
      envelope: { ciphertext: string },
      _proof?: unknown,
      _scope?: { spaceId: string; path: string },
    ) => ({
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

  test("binds a scoped secret and all three read paths to the exact stored key", async () => {
    const { vault, encryption, kv } = createNetworkVault();
    const canonicalSpaceId = `tinycloud:pkh:eip155:1:${address}:default`;
    const key = "secrets/scoped/service/API_KEY";
    const path = `vault/${key}`;
    const value = { value: "secret" };
    expect((await vault.put(key, value)).ok).toBe(true);
    expect(encryption.encryptToNetwork.mock.calls[0]?.[0]).toBe(networkId);
    expect(encryption.encryptToNetwork.mock.calls[0]?.[2]).toMatchObject({
      scope: { spaceId: canonicalSpaceId, path },
    });

    expect((await vault.get(key)).ok).toBe(true);
    expect((await vault.readNetworkEncrypted(key)).status).toBe("ok");
    expect((await vault.getShared(`did:pkh:eip155:1:${address}`, key, {
      kv,
      grantorSpaceId: canonicalSpaceId,
      grantorNetworkId: networkId,
    })).ok).toBe(true);
    expect(encryption.decryptEnvelope).toHaveBeenCalledTimes(3);
    for (const call of encryption.decryptEnvelope.mock.calls) {
      expect(call[2]).toMatchObject({ spaceId: canonicalSpaceId, path });
    }
  });

  test("shared named-secret decrypt uses the grantor's alternate space, not the recipient vault", async () => {
    const { vault, encryption, store } = createNetworkVault();
    const key = "secrets/API_KEY";
    const path = `vault/${key}`;
    const grantorSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const envelope = JSON.stringify({
      networkId,
      encryptedSymmetricKeyHash: "a".repeat(64),
      ciphertext: base64Encode(new TextEncoder().encode(JSON.stringify({ value: "grantor-only" }))),
    });
    const grantorKv = {
      get: mock(async () => ({ ok: true as const, data: { data: envelope } })),
    };

    const result = await vault.getShared(`did:pkh:eip155:1:${address}`, key, {
      kv: grantorKv,
      grantorSpaceId,
      grantorNetworkId: networkId,
    });
    expect(result.ok).toBe(true);
    expect(grantorKv.get).toHaveBeenCalledWith(path, { raw: true });
    expect(store.has(path)).toBe(false);
    expect(encryption.decryptEnvelope.mock.calls[0]?.[2]).toMatchObject({
      spaceId: grantorSpaceId, path,
    });
  });

  test("shared decrypt uses the grantor's network rather than the recipient's network", async () => {
    const { vault, encryption } = createNetworkVault();
    const grantorAddress = "0x0000000000000000000000000000000000000001";
    const grantorDID = `did:pkh:eip155:1:${grantorAddress}`;
    const grantorNetworkId = `urn:tinycloud:encryption:${grantorDID}:default`;
    const grantorSpaceId = `tinycloud:pkh:eip155:1:${grantorAddress}:secrets`;
    const key = "secrets/API_KEY";
    const envelope = JSON.stringify({
      networkId: grantorNetworkId,
      encryptedSymmetricKeyHash: "a".repeat(64),
      ciphertext: base64Encode(new TextEncoder().encode(JSON.stringify({ value: "grantor-only" }))),
    });
    const grantorKv = {
      get: mock(async () => ({ ok: true as const, data: { data: envelope } })),
    };

    const result = await vault.getShared(grantorDID, key, {
      kv: grantorKv,
      grantorSpaceId,
      grantorNetworkId,
    });
    expect(result.ok).toBe(true);
    expect(encryption.decryptEnvelope.mock.calls[0]?.[0]).toMatchObject({
      networkId: grantorNetworkId,
    });
    expect(encryption.decryptEnvelope.mock.calls[0]?.[2]).toMatchObject({
      spaceId: grantorSpaceId,
      path: `vault/${key}`,
    });
  });

  test("rejects shared named-secret release without trusted grantor scope metadata", async () => {
    const { vault, encryption, kv } = createNetworkVault();
    const key = "secrets/API_KEY";
    expect((await vault.put(key, { value: "secret" })).ok).toBe(true);

    const missing = await vault.getShared(`did:pkh:eip155:1:${address}`, key, { kv });
    const wrongOwner = await vault.getShared(
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      key,
      { kv, grantorSpaceId: spaceId, grantorNetworkId: networkId },
    );
    const wrongNetwork = await vault.getShared(`did:pkh:eip155:1:${address}`, key, {
      kv,
      grantorSpaceId: spaceId,
      grantorNetworkId: networkId.replace(/:default$/, ":alternate"),
    });
    expect(missing.ok).toBe(false);
    expect(wrongOwner.ok).toBe(false);
    expect(wrongNetwork.ok).toBe(false);
    expect(encryption.decryptEnvelope).not.toHaveBeenCalled();
  });

  test("keeps the storage-full code and byte counts when the KV write is rejected", async () => {
    const { vault, kv } = createNetworkVault();
    const meta = { status: 402, usedBytes: 155744, limitBytes: 0 };
    kv.put.mockImplementation(async () => ({
      ok: false as const,
      error: {
        code: "STORAGE_QUOTA_EXCEEDED",
        service: "kv",
        message: "TinyCloud storage is full, so this change was not saved.",
        meta,
      },
    }) as any);

    const put = await vault.put("secrets/API_KEY", { value: "secret" });

    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      service: "vault",
      message: "TinyCloud storage is full, so this change was not saved.",
      meta,
    });
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

describe("DataVaultService write errors (TC-834)", () => {
  const resource = `${spaceId}/kv/vault/secrets/API_KEY`;

  function rejectPut(
    kv: ReturnType<typeof createNetworkVault>["kv"],
    error: { code: string; message: string; meta?: Record<string, unknown> },
  ) {
    kv.put.mockImplementation(async () => ({
      ok: false as const,
      error: { service: "kv", ...error },
    }) as any);
  }

  test("ifNoneMatch forwards to KV and a 412 becomes ALREADY_EXISTS with the typed KV cause", async () => {
    const { vault, kv } = createNetworkVault();
    rejectPut(kv, {
      code: "KV_PRECONDITION_FAILED",
      message: "KV precondition failed for key",
      meta: { status: 412, statusText: "Precondition Failed" },
    });

    const put = await vault.put("secrets/API_KEY", { value: "secret" }, { ifNoneMatch: "*" });

    expect(kv.put).toHaveBeenCalledWith("vault/secrets/API_KEY", expect.any(String), { ifNoneMatch: "*" });
    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error.code).toBe("ALREADY_EXISTS");
    expect(put.error).toMatchObject({ service: "vault", key: "secrets/API_KEY", meta: { status: 412 } });
    if (put.error.code !== "ALREADY_EXISTS") return;
    expect(put.error.cause.code).toBe("KV_PRECONDITION_FAILED");
    expect(put.error.cause.service).toBe("kv");
  });

  test("a put without ifNoneMatch sends no precondition", async () => {
    const { vault, kv } = createNetworkVault();
    const put = await vault.put("secrets/API_KEY", { value: "secret" });
    expect(put.ok).toBe(true);
    expect(kv.put.mock.calls[0]).toHaveLength(2);
  });

  test("a capability 401 stays AUTH_UNAUTHORIZED and keeps the grantable capability", async () => {
    const { vault, kv } = createNetworkVault();
    rejectPut(kv, {
      code: "AUTH_UNAUTHORIZED",
      message: "Failed to put: 401 - Unauthorized",
      meta: { status: 401, resource, requiredAction: "tinycloud.kv/put" },
    });

    const put = await vault.put("secrets/API_KEY", { value: "secret" });

    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error).toMatchObject({ code: "AUTH_UNAUTHORIZED", service: "vault", meta: { status: 401 } });
    if (put.error.code !== "AUTH_UNAUTHORIZED") return;
    expect(put.error.cause.code).toBe("AUTH_UNAUTHORIZED");
    expect(validatedCapabilityOf(put.error)).toEqual({ resource, requiredAction: "tinycloud.kv/put" });
  });

  test("a 403 is PERMISSION_DENIED, never the expiry code, and keeps status and the typed cause", async () => {
    const { vault, kv } = createNetworkVault();
    rejectPut(kv, {
      code: "AUTH_UNAUTHORIZED",
      message: "Failed to put: 403 - Forbidden",
      meta: { status: 403 },
    });

    const put = await vault.put("secrets/API_KEY", { value: "secret" });

    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error).toMatchObject({ code: "PERMISSION_DENIED", service: "vault", meta: { status: 403 } });
    if (put.error.code !== "PERMISSION_DENIED") return;
    expect(put.error.cause.code).toBe("AUTH_UNAUTHORIZED");
    expect(authorizationVerdictOf(put.error)).toBe("forbidden");
  });

  test("a status-less AUTH_UNAUTHORIZED becomes PERMISSION_DENIED (only a definite 401 means sign in)", async () => {
    const { vault, kv } = createNetworkVault();
    rejectPut(kv, { code: "AUTH_UNAUTHORIZED", message: "Failed to put: Unauthorized" });

    const put = await vault.put("secrets/API_KEY", { value: "secret" });

    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error.code).toBe("PERMISSION_DENIED");
    expect(put.error).not.toHaveProperty("meta");
    if (put.error.code !== "PERMISSION_DENIED") return;
    expect(put.error.cause.code).toBe("AUTH_UNAUTHORIZED");
  });

  test("a 500 stays STORAGE_ERROR with meta and a chained cause", async () => {
    const { vault, kv } = createNetworkVault();
    rejectPut(kv, {
      code: "KV_WRITE_FAILED",
      message: "Failed to put key: 500 - boom",
      meta: { status: 500, statusText: "Internal Server Error" },
    });

    const put = await vault.put("secrets/API_KEY", { value: "secret" });

    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error).toMatchObject({ code: "STORAGE_ERROR", meta: { status: 500 } });
    if (put.error.code !== "STORAGE_ERROR") return;
    expect(put.error.cause.cause).toMatchObject({ code: "KV_WRITE_FAILED", service: "kv" });
  });

  test("a legacy vault refuses ifNoneMatch before any KV call", async () => {
    const calls: string[] = [];
    const vault = createVault(calls);
    const kvPut = mock(async () => ({ ok: true as const, data: undefined }));
    (vault as any).vaultConfig.tc.kv = { put: kvPut, get: kvPut };
    expect((await vault.unlock(createSigner(calls))).ok).toBe(true);

    const put = await vault.put("secrets/API_KEY", { value: "secret" }, { ifNoneMatch: "*" });

    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error.code).toBe("STORAGE_ERROR");
    expect(kvPut).not.toHaveBeenCalled();
  });
});
