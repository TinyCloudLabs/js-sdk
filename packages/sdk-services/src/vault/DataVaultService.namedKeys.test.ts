import { describe, expect, test } from "bun:test";

import { ServiceContext } from "../context";
import { base64Decode, base64Encode, utf8Encode } from "../encryption";
import { NamedKeyError } from "../encryption/namedKeys";
import { SecretsService } from "../secrets/SecretsService";
import { secretKeyPath, secretReadPermissions } from "../secrets/paths";
import { DataVaultService } from "./DataVaultService";

// TC-3284: secrets are sealed to their own named key (envelope v2). The
// envelope's own `keyPath` picks how a record opens, never KV metadata.

const SPACE_ID = "tinycloud:pkh:eip155:1:0xabc:secrets";
const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:default";

/** An envelope whose ciphertext is the plaintext in base64; the fakes below open it. */
function envelope(fields: { v: 1 | 2; keyPath?: string; aadKey?: string; networkId?: string; value?: unknown }) {
  return {
    v: fields.v,
    networkId: fields.networkId ?? NETWORK_ID,
    ...(fields.keyPath === undefined ? {} : { keyPath: fields.keyPath }),
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    encryptedSymmetricKey: "c3ltbWV0cmlj",
    encryptedSymmetricKeyHash: "00112233445566778899aabbccddeeff",
    ciphertext: base64Encode(utf8Encode(JSON.stringify(fields.value ?? { value: "v", createdAt: "t", updatedAt: "t" }))),
    aad: base64Encode(utf8Encode(`tinycloud.vault:${SPACE_ID}:${fields.aadKey ?? "secrets/API_KEY"}`)),
    metadata: { "x-vault-content-type": "application/json" },
  };
}

function harness(options: { keyDecryptStatus?: number } = {}) {
  const records = new Map<string, string>();
  const calls = { networkDecrypt: 0, keyDecrypt: 0, encrypt: [] as { keyPath: string; options: Record<string, unknown> }[] };
  const open = (e: { ciphertext: string }) => base64Decode(e.ciphertext);
  const kv = {
    get: async (path: string) => records.has(path)
      ? { ok: true, data: { data: records.get(path) } }
      : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing", service: "kv" } },
    put: async (path: string, body: string) => {
      records.set(path, body);
      return { ok: true, data: undefined };
    },
  };
  const context = new ServiceContext({ hosts: ["https://tinycloud.test"], invoke: () => ({}), fetch: (async () => new Response()) as never });
  context.setSession({
    delegationHeader: { Authorization: "a" },
    delegationCid: "bafy-delegation",
    spaceId: SPACE_ID,
    verificationMethod: "did:key:z6MkSession",
    jwk: {},
  });
  const vault = new DataVaultService({
    spaceId: SPACE_ID,
    encryption: {
      networkId: NETWORK_ID,
      service: {
        encryptToNetwork: async (_networkId: string, plaintext: Uint8Array) =>
          ({ ok: true, data: { ...envelope({ v: 1 }), ciphertext: base64Encode(plaintext) } }),
        decryptEnvelope: async (e: { ciphertext: string }) => {
          calls.networkDecrypt++;
          return { ok: true, data: open(e) };
        },
      },
      namedKeys: async () => ({
        encrypt: async (keyPath: string, plaintext: Uint8Array, encryptOptions: Record<string, unknown>) => {
          calls.encrypt.push({ keyPath, options: encryptOptions });
          return { ...envelope({ v: 2, keyPath }), ciphertext: base64Encode(plaintext), aad: base64Encode(encryptOptions.aad as Uint8Array) };
        },
        decrypt: async (e: { ciphertext: string }) => {
          calls.keyDecrypt++;
          if (options.keyDecryptStatus !== undefined) {
            throw new NamedKeyError("NODE_ERROR", "refused", { status: options.keyDecryptStatus });
          }
          return open(e);
        },
      }),
    },
    tc: { kv, did: "did:key:z6MkPrincipal", address: "0xabc", chainId: 1, hosts: ["https://tinycloud.test"] },
  } as never);
  vault.initialize(context);
  const store = (key: string, value: unknown) => records.set(`vault/${key}`, JSON.stringify(value));
  const stored = (key: string) => JSON.parse(records.get(`vault/${key}`)!) as { v: number; keyPath?: string };
  return { vault, secrets: new SecretsService(vault), calls, store, stored };
}

describe("secret writes seal to the secret's own key", () => {
  test("put ensures the key and writes v2, over v1 and v2 alike, with the unchanged AAD", async () => {
    const h = harness();
    h.store("secrets/API_KEY", envelope({ v: 1 }));
    expect((await h.secrets.put("API_KEY", "one")).ok).toBe(true);
    expect(h.stored("secrets/API_KEY")).toMatchObject({ v: 2, keyPath: "secrets/api_key" });
    expect((await h.secrets.put("API_KEY", "two", { scope: "my-app" })).ok).toBe(true);
    expect(h.stored("secrets/scoped/my-app/API_KEY")).toMatchObject({ v: 2, keyPath: "secrets/scoped/my-app/api_key" });

    expect(h.calls.encrypt.map(({ keyPath, options }) => ({
      keyPath,
      ensureKey: options.ensureKey,
      networkId: options.networkId,
      aad: new TextDecoder().decode(options.aad as Uint8Array),
    }))).toEqual([
      { keyPath: "secrets/api_key", ensureKey: true, networkId: NETWORK_ID, aad: `tinycloud.vault:${SPACE_ID}:secrets/API_KEY` },
      {
        keyPath: "secrets/scoped/my-app/api_key",
        ensureKey: true,
        networkId: NETWORK_ID,
        aad: `tinycloud.vault:${SPACE_ID}:secrets/scoped/my-app/API_KEY`,
      },
    ]);
    expect(await h.secrets.get("API_KEY")).toEqual({ ok: true, data: "one" });
    expect(h.calls).toMatchObject({ networkDecrypt: 0, keyDecrypt: 1 });
  });

  test("a name or scope longer than one key segment is refused, never written", async () => {
    const h = harness();
    const result = await h.secrets.put(`A${"B".repeat(64)}`, "x");
    expect(result.ok ? undefined : result.error.code).toBe("INVALID_INPUT");
    const scoped = await h.secrets.put("API_KEY", "x", { scope: "a".repeat(65) });
    expect(scoped.ok ? undefined : scoped.error.code).toBe("INVALID_INPUT");
    expect(h.calls.encrypt).toEqual([]);
  });
});

describe("secret reads pick the key from the envelope", () => {
  const read = (h: ReturnType<typeof harness>, options: Parameters<DataVaultService["readNetworkEncrypted"]>[1] = {}) =>
    h.vault.readNetworkEncrypted("secrets/API_KEY", { expectAad: true, keyPath: "secrets/api_key", ...options });

  test("v1 opens with the network key and v2 with its own key, whatever the metadata claims", async () => {
    const h = harness();
    h.store("secrets/API_KEY", { ...envelope({ v: 1 }), metadata: { "x-vault-content-type": "application/json", keyPath: "secrets/api_key", "x-vault-version": "3" } });
    expect((await read(h)).status).toBe("ok");
    expect(h.calls).toMatchObject({ networkDecrypt: 1, keyDecrypt: 0 });

    h.store("secrets/API_KEY", envelope({ v: 2, keyPath: "secrets/api_key" }));
    expect((await read(h)).status).toBe("ok");
    expect(h.calls).toMatchObject({ networkDecrypt: 1, keyDecrypt: 1 });
  });

  test("a v2 envelope naming another key, another network or no expected key is refused unopened", async () => {
    const h = harness();
    for (const stored of [
      envelope({ v: 2, keyPath: "secrets/other_key" }),
      envelope({ v: 1, keyPath: "secrets/api_key" }),
      envelope({ v: 2, keyPath: "secrets/api_key", networkId: "urn:tinycloud:encryption:did:pkh:eip155:1:0xdef:default" }),
    ]) {
      h.store("secrets/API_KEY", stored);
      expect(await read(h)).toEqual({ status: "corrupt_envelope" });
    }
    h.store("secrets/API_KEY", envelope({ v: 2, keyPath: "secrets/api_key" }));
    expect(await h.vault.readNetworkEncrypted("secrets/API_KEY")).toEqual({ status: "corrupt_envelope" });
    expect(h.calls).toMatchObject({ networkDecrypt: 0, keyDecrypt: 0 });
  });

  test("a v2 envelope copied from another secret fails the AAD check", async () => {
    const h = harness();
    h.store("secrets/API_KEY", envelope({ v: 2, keyPath: "secrets/api_key", aadKey: "secrets/OTHER_KEY" }));
    expect(await read(h, { expectAad: false })).toEqual({ status: "aad_mismatch" });
    const viaGet = await h.secrets.get("API_KEY");
    expect(viaGet.ok ? undefined : viaGet.error.code).toBe("AAD_MISMATCH");
    expect(h.calls.keyDecrypt).toBe(0);
  });

  test("namedKeyOnly refuses a network-sealed record before any decrypt", async () => {
    const h = harness();
    h.store("secrets/API_KEY", envelope({ v: 1 }));
    expect(await read(h, { namedKeyOnly: true })).toEqual({ status: "legacy_envelope" });
    const viaGet = await h.vault.get("secrets/API_KEY", { namedKeyOnly: true });
    expect(viaGet.ok ? undefined : viaGet.error.code).toBe("LEGACY_ENVELOPE");
    expect(h.calls).toMatchObject({ networkDecrypt: 0, keyDecrypt: 0 });
  });

  test("a node refusal on the key asks for exactly that key, never the network", async () => {
    const h = harness({ keyDecryptStatus: 403 });
    h.store("secrets/API_KEY", envelope({ v: 2, keyPath: "secrets/api_key" }));
    expect(await read(h)).toEqual({
      status: "permission_required",
      hint: { service: "tinycloud.encryption", path: `${NETWORK_ID}/secrets/api_key`, actions: ["tinycloud.encryption/decrypt"] },
    });
  });
});

describe("secretKeyPath and the exact read grant", () => {
  test("refuses rather than normalises a scope, and names over 64 bytes", () => {
    for (const [name, scope] of [
      ["API_KEY", "My-App"],
      ["API_KEY", " my-app"],
      ["API_KEY", "my_app"],
      ["API_KEY", "a".repeat(65)],
      ["api_key", undefined],
      ["Api_Key", undefined],
      [`A${"B".repeat(64)}`, undefined],
    ] as const) {
      expect(() => secretKeyPath(name, scope)).toThrow();
    }
    expect(secretKeyPath(`A${"B".repeat(63)}`)).toBe(`secrets/a${"b".repeat(63)}`);
  });

  test("is one-to-one over valid names and scopes", () => {
    const names = ["A", "A_", "A__", "AB", "A_B", "AB_", "A1", "A_1", "API_KEY", "API_KEY_2"];
    const paths = names.flatMap((name) => [secretKeyPath(name), secretKeyPath(name, "x"), secretKeyPath(name, "x-y")]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("grants kv get on the record and decrypt on its own key only", () => {
    expect(secretReadPermissions(NETWORK_ID, "API_KEY", { scope: "my-app", space: SPACE_ID })).toEqual([
      { service: "tinycloud.kv", space: SPACE_ID, path: "vault/secrets/scoped/my-app/API_KEY", actions: ["tinycloud.kv/get"], skipPrefix: true },
      { service: "tinycloud.encryption", path: `${NETWORK_ID}/secrets/scoped/my-app/api_key`, actions: ["tinycloud.encryption/decrypt"] },
    ]);
  });
});
