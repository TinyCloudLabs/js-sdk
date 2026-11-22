import { describe, expect, test } from "bun:test";

import { ServiceContext } from "../context";
import { base64Decode, base64Encode, utf8Encode } from "../encryption";
import { DataVaultService } from "../vault/DataVaultService";
import { migrateSecrets } from "./migrate";
import { SecretsService } from "./SecretsService";

// TC-3802: migrateSecrets over the real SecretsService and DataVaultService
// (S1's resealToKey), with fake KV and fake key crypto. Unit tests with a
// stubbed vault are in migrate.test.ts.

const SPACE_ID = "tinycloud:pkh:eip155:1:0xabc:secrets";
const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:default";
const API_KEY = "secrets/API_KEY";
const SCOPED = "secrets/scoped/my-app/OTHER_KEY";
const DONE = "secrets/DONE_KEY";

/** An envelope whose ciphertext is the plaintext in base64; the fakes below open it. */
function envelope(fields: { v: 1 | 2; key: string; keyPath?: string; value?: string }) {
  return {
    v: fields.v,
    networkId: NETWORK_ID,
    ...(fields.keyPath === undefined ? {} : { keyPath: fields.keyPath }),
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    encryptedSymmetricKey: "c3ltbWV0cmlj",
    encryptedSymmetricKeyHash: "00112233445566778899aabbccddeeff",
    ciphertext: base64Encode(utf8Encode(JSON.stringify({ value: fields.value ?? "v", createdAt: "t", updatedAt: "t" }))),
    aad: base64Encode(utf8Encode(`tinycloud.vault:${SPACE_ID}:${fields.key}`)),
    metadata: { "x-vault-content-type": "application/json" },
  };
}

function harness(options: { reopenAs?: Uint8Array } = {}) {
  const records = new Map<string, string>();
  const versions = new Map<string, number>();
  const calls = { encrypt: 0, puts: 0 };
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
    list: async (listOptions: { prefix: string }) => ({
      ok: true,
      data: {
        keys: [...records.keys()].filter((path) => path.startsWith(listOptions.prefix)).map((path) => path.slice(listOptions.prefix.length)),
        truncated: false,
      },
    }),
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
        encryptToNetwork: async () => {
          throw new Error("migrate never seals to the network key");
        },
        decryptEnvelope: async (e: { ciphertext: string }) => ({ ok: true, data: open(e) }),
      },
      namedKeys: async () => ({
        encrypt: async (keyPath: string, plaintext: Uint8Array, encryptOptions: Record<string, unknown>) => {
          calls.encrypt++;
          return {
            ...envelope({ v: 2, key: "", keyPath }),
            ciphertext: base64Encode(plaintext),
            aad: base64Encode(encryptOptions.aad as Uint8Array),
          };
        },
        decrypt: async (e: { ciphertext: string }) => options.reopenAs ?? open(e),
      }),
    },
    tc: { kv, did: "did:key:z6MkPrincipal", address: "0xabc", chainId: 1, hosts: ["https://tinycloud.test"] },
  } as never);
  vault.initialize(context);
  const store = (key: string, value: unknown) => write(`vault/${key}`, JSON.stringify(value));
  const stored = (key: string) => JSON.parse(records.get(`vault/${key}`)!) as { v: number; keyPath?: string };
  const raw = (key: string) => records.get(`vault/${key}`);
  return { secrets: new SecretsService(vault), calls, store, stored, raw, race };
}

/** Two secrets still sealed to the network key and one already on its own key. */
function seeded(options: { reopenAs?: Uint8Array } = {}) {
  const h = harness(options);
  h.store(API_KEY, envelope({ v: 1, key: API_KEY, value: "one" }));
  h.store(SCOPED, envelope({ v: 1, key: SCOPED, value: "two" }));
  h.store(DONE, envelope({ v: 2, key: DONE, keyPath: "secrets/done_key", value: "three" }));
  return h;
}

describe("migrateSecrets on a vault", () => {
  test("moves each network-sealed secret onto its own key; running it again moves nothing", async () => {
    const h = seeded();

    expect(await migrateSecrets(h.secrets)).toEqual({
      ok: true,
      data: { dryRun: false, total: 3, moved: 2, already: 1, staysOnNetwork: 0, skipped: {} },
    });
    expect(h.stored(API_KEY)).toMatchObject({ v: 2, keyPath: "secrets/api_key" });
    expect(h.stored(SCOPED)).toMatchObject({ v: 2, keyPath: "secrets/scoped/my-app/other_key" });
    expect(await h.secrets.get("API_KEY", { namedKeyOnly: true })).toEqual({ ok: true, data: "one" });
    expect(await h.secrets.get("OTHER_KEY", { scope: "my-app", namedKeyOnly: true })).toEqual({ ok: true, data: "two" });

    const writes = h.calls.puts;
    expect(await migrateSecrets(h.secrets)).toEqual({
      ok: true,
      data: { dryRun: false, total: 3, moved: 0, already: 3, staysOnNetwork: 0, skipped: {} },
    });
    expect(h.calls.puts).toBe(writes);
  });

  test("a dry run counts what would move and changes nothing", async () => {
    const h = seeded();
    const before = [API_KEY, SCOPED, DONE].map(h.raw);

    expect(await migrateSecrets(h.secrets, { dryRun: true })).toEqual({
      ok: true,
      data: { dryRun: true, total: 3, moved: 2, already: 1, staysOnNetwork: 0, skipped: {} },
    });
    expect([API_KEY, SCOPED, DONE].map(h.raw)).toEqual(before);
    expect(h.calls).toEqual({ encrypt: 0, puts: 0 });
  });

  test("a new copy that does not open to the same value is never written; the old copy stays", async () => {
    const h = seeded({ reopenAs: utf8Encode("something else") });
    const before = [API_KEY, SCOPED].map(h.raw);

    expect(await migrateSecrets(h.secrets)).toEqual({
      ok: true,
      data: { dryRun: false, total: 3, moved: 0, already: 1, staysOnNetwork: 0, skipped: { verify_failed: 2 } },
    });
    expect([API_KEY, SCOPED].map(h.raw)).toEqual(before);
    expect(h.calls.puts).toBe(0);
  });

  test("a secret changed by someone else during the move keeps the newer copy; the rest still move", async () => {
    const h = seeded();
    // Every write races a new network-sealed API_KEY, so its conditional write never lands.
    h.race.beforeWrite = () => h.store(API_KEY, envelope({ v: 1, key: API_KEY, value: "racer" }));

    expect(await migrateSecrets(h.secrets)).toEqual({
      ok: true,
      data: { dryRun: false, total: 3, moved: 1, already: 1, staysOnNetwork: 0, skipped: { conflict: 1 } },
    });
    expect(h.stored(API_KEY)).toMatchObject({ v: 1 });
    expect(h.stored(SCOPED)).toMatchObject({ v: 2, keyPath: "secrets/scoped/my-app/other_key" });
    h.race.beforeWrite = undefined;
    expect(await h.secrets.get("API_KEY")).toEqual({ ok: true, data: "racer" });
  });

  test("only the named secrets move, and a name that is not stored is counted, not created", async () => {
    const h = seeded();

    expect(await migrateSecrets(h.secrets, { names: ["API_KEY", "MISSING_KEY"] })).toEqual({
      ok: true,
      data: { dryRun: false, total: 2, moved: 1, already: 0, staysOnNetwork: 0, skipped: { not_found: 1 } },
    });
    expect(h.stored(SCOPED)).toMatchObject({ v: 1 });
    expect(h.raw("secrets/MISSING_KEY")).toBeUndefined();
  });

  test("asks the caller once for exactly the selected secrets' own keys, before anything moves; a dry run never asks", async () => {
    const h = seeded();
    const asked: (readonly string[])[] = [];
    const authorizeKeys = async (keyPaths: readonly string[]) => {
      expect(h.calls.puts).toBe(0);
      asked.push(keyPaths);
    };

    await migrateSecrets(h.secrets, { dryRun: true, authorizeKeys });
    expect(asked).toEqual([]);

    await migrateSecrets(h.secrets, { scope: "my-app", authorizeKeys });
    expect(asked).toEqual([["secrets/scoped/my-app/other_key"]]);
  });

  test("a refused key approval stops the migration before any write", async () => {
    const h = seeded();
    const before = [API_KEY, SCOPED].map(h.raw);

    await expect(migrateSecrets(h.secrets, { authorizeKeys: async () => { throw new Error("refused"); } })).rejects.toThrow("refused");
    expect([API_KEY, SCOPED].map(h.raw)).toEqual(before);
    expect(h.calls.puts).toBe(0);
  });
});
