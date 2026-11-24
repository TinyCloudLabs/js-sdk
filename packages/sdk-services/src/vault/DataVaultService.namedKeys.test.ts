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

function harness(options: { keyDecryptStatus?: number; reopenAs?: Uint8Array } = {}) {
  const records = new Map<string, string>();
  const versions = new Map<string, number>();
  const calls = { networkDecrypt: 0, keyDecrypt: 0, encrypt: [] as { keyPath: string; options: Record<string, unknown> }[], puts: 0 };
  /** Runs before each conditional write is checked, as a concurrent writer would. */
  const race = { beforeWrite: undefined as (() => void) | undefined };
  const open = (e: { ciphertext: string }) => base64Decode(e.ciphertext);
  const etag = (path: string) => `"v${versions.get(path) ?? 0}"`;
  const write = (path: string, body: string) => {
    records.set(path, body);
    versions.set(path, (versions.get(path) ?? 0) + 1);
  };
  const kv = {
    get: async (path: string) => records.has(path)
      ? { ok: true, data: { data: records.get(path), headers: { etag: etag(path) } } }
      : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing", service: "kv" } },
    put: async (path: string, body: string, putOptions?: { ifMatch?: string }) => {
      calls.puts++;
      race.beforeWrite?.();
      if (putOptions?.ifMatch !== undefined && putOptions.ifMatch !== etag(path)) {
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "etag moved", service: "kv" } };
      }
      write(path, body);
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
          return options.reopenAs ?? open(e);
        },
      }),
    },
    tc: { kv, did: "did:key:z6MkPrincipal", address: "0xabc", chainId: 1, hosts: ["https://tinycloud.test"] },
  } as never);
  vault.initialize(context);
  const store = (key: string, value: unknown) => write(`vault/${key}`, JSON.stringify(value));
  const stored = (key: string) => JSON.parse(records.get(`vault/${key}`)!) as { v: number; keyPath?: string };
  const raw = (key: string) => records.get(`vault/${key}`);
  return { vault, secrets: new SecretsService(vault), calls, store, stored, raw, race };
}

describe("secret writes seal to the secret's own key", () => {
  test("put ensures the key and writes v2, over v1 and v2 alike, with the unchanged AAD", async () => {
    const h = harness();
    h.store("secrets/API_KEY", envelope({ v: 1 }));
    expect((await h.secrets.put("API_KEY", "one", { namedKey: true })).ok).toBe(true);
    expect(h.stored("secrets/API_KEY")).toMatchObject({ v: 2, keyPath: "secrets/api_key" });
    expect((await h.secrets.put("API_KEY", "two", { scope: "my-app", namedKey: true })).ok).toBe(true);
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

  test("a v1 envelope without AAD stays readable through the network decrypt until migrate; bound ones stay strict", async () => {
    const h = harness();
    const unbound = ({ v }: { v: 1 | 2 }) => {
      const { aad: _aad, ...rest } = envelope(v === 1 ? { v } : { v, keyPath: "secrets/api_key" });
      return rest;
    };
    h.store("secrets/API_KEY", unbound({ v: 1 }));
    expect((await read(h)).status).toBe("ok");
    expect(await h.secrets.get("API_KEY")).toEqual({ ok: true, data: "v" });
    expect(h.calls).toMatchObject({ networkDecrypt: 2, keyDecrypt: 0 });

    h.store("secrets/API_KEY", envelope({ v: 1, aadKey: "secrets/OTHER_KEY" }));
    expect(await read(h)).toEqual({ status: "aad_mismatch" });
    h.store("secrets/API_KEY", unbound({ v: 2 }));
    expect(await read(h)).toEqual({ status: "aad_mismatch" });
    expect(h.calls).toMatchObject({ networkDecrypt: 2, keyDecrypt: 0 });
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

  test("get, secrets.get and getEntry keep a refused grant apart from a failed decrypt", async () => {
    const hint = { service: "tinycloud.encryption", path: `${NETWORK_ID}/secrets/api_key`, actions: ["tinycloud.encryption/decrypt"] };
    for (const status of [401, 403]) {
      const h = harness({ keyDecryptStatus: status });
      h.store("secrets/API_KEY", envelope({ v: 2, keyPath: "secrets/api_key" }));
      for (const result of [
        await h.vault.get("secrets/API_KEY", { expectAad: true, keyPath: "secrets/api_key" }),
        await h.secrets.get("API_KEY"),
        await h.secrets.getEntry("API_KEY"),
      ]) {
        expect(result.ok ? undefined : result.error).toMatchObject({ code: "DECRYPT_DENIED", key: "secrets/API_KEY", permissionHint: hint });
      }
    }

    const failed = harness({ keyDecryptStatus: 500 });
    failed.store("secrets/API_KEY", envelope({ v: 2, keyPath: "secrets/api_key" }));
    for (const result of [await failed.secrets.get("API_KEY"), await failed.secrets.getEntry("API_KEY")]) {
      expect(result.ok ? undefined : result.error.code).toBe("DECRYPTION_FAILED");
      expect(result.ok ? undefined : "permissionHint" in result.error).toBe(false);
    }
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

describe("resealToKey verifies before it writes", () => {
  const KEY = "secrets/API_KEY";
  const KEY_PATH = "secrets/api_key";
  const withoutAad = (e: Record<string, unknown>) => {
    const { aad: _aad, ...rest } = e;
    return rest;
  };

  test("moves a v1 copy, with or without AAD, onto its own key and binds the AAD", async () => {
    for (const old of [envelope({ v: 1 }), withoutAad(envelope({ v: 1 }))]) {
      const h = harness();
      h.store(KEY, old);
      expect(await h.vault.resealToKey(KEY, KEY_PATH)).toEqual({ status: "moved" });
      expect(h.stored(KEY)).toMatchObject({ v: 2, keyPath: KEY_PATH });
      expect(new TextDecoder().decode(h.calls.encrypt[0]!.options.aad as Uint8Array)).toBe(`tinycloud.vault:${SPACE_ID}:${KEY}`);
      expect(await h.secrets.get("API_KEY")).toEqual({ ok: true, data: "v" });
    }
  });

  test("a copy already on its own key is left alone; a dry run reports what would move", async () => {
    const h = harness();
    h.store(KEY, envelope({ v: 2, keyPath: KEY_PATH }));
    expect(await h.vault.resealToKey(KEY, KEY_PATH)).toEqual({ status: "already" });
    expect(await h.vault.resealToKey(KEY, KEY_PATH, { dryRun: true })).toEqual({ status: "already" });

    h.store(KEY, envelope({ v: 1 }));
    const before = h.raw(KEY);
    expect(await h.vault.resealToKey(KEY, KEY_PATH, { dryRun: true })).toEqual({ status: "pending" });
    expect(h.raw(KEY)).toBe(before);
    expect(h.calls).toMatchObject({ puts: 0, networkDecrypt: 0, keyDecrypt: 0, encrypt: [] });
  });

  test("a new copy that does not open to the same bytes is never written", async () => {
    const h = harness({ reopenAs: utf8Encode("something else") });
    h.store(KEY, envelope({ v: 1 }));
    const before = h.raw(KEY);
    expect(await h.vault.resealToKey(KEY, KEY_PATH)).toEqual({ status: "skipped", reason: "verify_failed" });
    expect(h.raw(KEY)).toBe(before);
    expect(h.calls.puts).toBe(0);
  });

  test("a write lost to a concurrent change rereads once, then gives up and keeps the newer copy", async () => {
    const once = harness();
    once.store(KEY, envelope({ v: 1 }));
    once.race.beforeWrite = () => {
      once.race.beforeWrite = undefined;
      once.store(KEY, envelope({ v: 1, value: { value: "newer", createdAt: "t", updatedAt: "t" } }));
    };
    expect(await once.vault.resealToKey(KEY, KEY_PATH)).toEqual({ status: "moved" });
    expect(once.stored(KEY)).toMatchObject({ v: 2, keyPath: KEY_PATH });
    expect(await once.secrets.get("API_KEY")).toEqual({ ok: true, data: "newer" });

    const always = harness();
    always.store(KEY, envelope({ v: 1 }));
    always.race.beforeWrite = () => always.store(KEY, envelope({ v: 1, value: { value: "racer", createdAt: "t", updatedAt: "t" } }));
    expect(await always.vault.resealToKey(KEY, KEY_PATH)).toEqual({ status: "skipped", reason: "conflict" });
    expect(always.calls.puts).toBe(2);
    expect(always.stored(KEY)).toMatchObject({ v: 1 });
  });

  test("a missing record, or one bound to another key, is skipped without a write", async () => {
    const h = harness();
    expect(await h.vault.resealToKey(KEY, KEY_PATH)).toEqual({ status: "skipped", reason: "not_found" });
    h.store(KEY, envelope({ v: 1, aadKey: "secrets/OTHER_KEY" }));
    expect(await h.vault.resealToKey(KEY, KEY_PATH)).toEqual({ status: "skipped", reason: "aad_mismatch" });
    expect(h.calls).toMatchObject({ puts: 0, encrypt: [] });
  });

  test("a keyPath other than the record's own secret key throws before any read or write", async () => {
    const h = harness();
    h.store(KEY, envelope({ v: 1 }));
    for (const [key, keyPath] of [
      [KEY, "secrets/other_key"],
      [KEY, "secrets/API_KEY"],
      [KEY, "secrets/"],
      [KEY, "secrets/scoped/food/api_key"],
      ["secrets/scoped/food/API_KEY", KEY_PATH],
      ["notes/API_KEY", KEY_PATH],
    ]) {
      await expect(h.vault.resealToKey(key!, keyPath!)).rejects.toThrow("is not the own key of");
      await expect(h.vault.resealToKey(key!, keyPath!, { dryRun: true })).rejects.toThrow("is not the own key of");
    }
    expect(h.calls).toMatchObject({ networkDecrypt: 0, keyDecrypt: 0, puts: 0, encrypt: [] });
    expect(h.stored(KEY)).toMatchObject({ v: 1 });
  });
});
