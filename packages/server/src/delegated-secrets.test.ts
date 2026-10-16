import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { authorizationVerdictOf, decryptEnvelopeWithKey, encryptToNetwork, type EncryptionCrypto } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { readDelegatedSecret } from "./delegated-secrets.js";

test.each([401, 403] as const)("delegated secret KV HTTP %i retains the original error as a typed cause", async (status) => {
  const failure = { code: "AUTH_UNAUTHORIZED", message: `${status} - refused`, meta: { status } };
  const node = {
    useDelegation: async () => ({ kv: { get: async () => ({ ok: false, error: failure }) } }),
    encryption: { decryptEnvelope: async () => { throw new Error("must not decrypt"); } },
  } as unknown as Parameters<typeof readDelegatedSecret>[0];
  await readDelegatedSecret(node, {} as PortableDelegation, "CREDENTIAL").then(
    () => { throw new Error("expected refusal"); },
    (error: unknown) => {
      expect((error as Error).message).toContain(`${status} - refused`);
      expect((error as Error & { cause: unknown }).cause).toBe(failure);
      expect(authorizationVerdictOf(error)).toBe(status === 401 ? "unauthenticated" : "forbidden");
    },
  );
});

test("delegated named read rejects sibling ciphertext already copied into the requested KV key", async () => {
  const spaceId = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:other";
  const networkId = "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
  const requested = "vault/secrets/scoped/service/CREDENTIAL";
  const sibling = "vault/secrets/scoped/service/OTHER";
  const xor = (key: Uint8Array, bytes: Uint8Array) =>
    bytes.map((byte, index) => byte ^ key[index % key.length]!);
  const crypto = {
    sha256: (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest()),
    randomBytes: () => new Uint8Array(32).fill(7),
    authEncrypt: xor,
    authDecrypt: xor,
    sealToNetworkKey: (_publicKey: Uint8Array, key: Uint8Array) => key,
  } as EncryptionCrypto;
  const encrypted = (path: string) => encryptToNetwork(crypto, {
    networkId, networkPublicKey: new Uint8Array(32),
    plaintext: new TextEncoder().encode('{\"value\":\"safe\"}'),
    scope: { spaceId, path },
  });
  const a = encrypted(requested);
  const b = encrypted(sibling);
  let stored = a.envelope;
  const node = {
    useDelegation: async () => ({
      kv: { get: async () => ({ ok: true, data: { data: JSON.stringify(stored) } }) },
      delegation: { cid: "bafy-proof" },
    }),
    encryption: {
      decryptEnvelope: async (
        envelope: typeof stored,
        _proof: { proofs: string[] },
        locator: { spaceId: string; path: string },
      ) => ({ ok: true as const, data: decryptEnvelopeWithKey(crypto, envelope, a.symmetricKey, locator) }),
    },
  } as unknown as Parameters<typeof readDelegatedSecret>[0];
  const delegation = { spaceId } as PortableDelegation;

  expect(await readDelegatedSecret(node, delegation, "CREDENTIAL", { scope: "service" })).toBe("safe");
  stored = b.envelope;
  await expect(readDelegatedSecret(node, delegation, "CREDENTIAL", { scope: "service" }))
    .rejects.toThrow("scopeTag");
});
