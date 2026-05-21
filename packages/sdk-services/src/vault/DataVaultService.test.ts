import { describe, expect, test } from "bun:test";
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
