import { describe, expect, test } from "bun:test";

import { ServiceContext } from "../context";
import { base64Decode, base64Encode, utf8Encode } from "../encryption";
import { mapNodeKeyError } from "../encryption/namedKeys";
import { DataVaultService } from "../vault/DataVaultService";
import type { VaultResealResult } from "../vault/types";
import type { ISecretsService, SecretCatalogEntry } from "./ISecretsService";
import { migrateSecrets } from "./migrate";
import { SecretsService } from "./SecretsService";

// TC-4248: with a key approval to ask for, migrate classifies first and asks only for the keys that still have to
// move, so a move stopped part way (a grant that lapses mid-reseal) leaves each secret old or new and a rerun asks
// for exactly the rest.

/** A stubbed vault of v1/v2 records, logging each classify and reseal. */
function vault(records: Record<string, 1 | 2 | "datavault">) {
  const state = { ...records };
  const log: string[] = [];
  const resealToKey = async (key: string, _keyPath: string, options?: { dryRun?: boolean }): Promise<VaultResealResult> => {
    log.push(`${options?.dryRun ? "classify" : "reseal"} ${key}`);
    const record = state[key];
    if (record === "datavault") return { status: "skipped", reason: "read_failed" };
    if (record === 2) return { status: "already" };
    if (options?.dryRun) return { status: "pending" };
    state[key] = 2;
    return { status: "moved" };
  };
  const catalog: SecretCatalogEntry[] = Object.keys(records).map((key) => {
    const parts = key.split("/");
    return parts[1] === "scoped" ? { name: parts[3]!, scope: parts[2]! } : { name: parts[1]! };
  });
  const secrets = { vault: { resealToKey }, listAll: async () => ({ ok: true, data: catalog }) } as unknown as ISecretsService;
  return { secrets, state, log };
}

const SPACE_ID = "tinycloud:pkh:eip155:1:0xabc:secrets";
const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:default";

/** An envelope whose ciphertext is the plaintext in base64 (as migrate.vault.test.ts). */
function envelope(key: string, keyPath?: string) {
  return {
    v: keyPath === undefined ? 1 : 2,
    networkId: NETWORK_ID,
    ...(keyPath === undefined ? {} : { keyPath }),
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    encryptedSymmetricKey: "c3ltbWV0cmlj",
    encryptedSymmetricKeyHash: "00112233445566778899aabbccddeeff",
    ciphertext: base64Encode(utf8Encode(JSON.stringify({ value: key, createdAt: "t", updatedAt: "t" }))),
    aad: base64Encode(utf8Encode(`tinycloud.vault:${SPACE_ID}:${key}`)),
    metadata: { "x-vault-content-type": "application/json" },
  };
}

/**
 * The real SecretsService and DataVaultService over fake KV, whose key grant lapses after `grantLeft` uses: from then
 * on the node answers the named-key call (`lapseAt`: key.create on encrypt, or decrypt on the verify) with a 403, as
 * mapNodeKeyError reports it.
 */
function lapsingVault(keys: string[], lapseAt: "encrypt" | "decrypt") {
  const records = new Map<string, string>();
  const versions = new Map<string, number>();
  const grant = { left: 0 };
  const write = (path: string, body: string) => {
    records.set(path, body);
    versions.set(path, (versions.get(path) ?? 0) + 1);
  };
  const etag = (path: string) => `"v${versions.get(path) ?? 0}"`;
  const use = (call: "encrypt" | "decrypt") => {
    if (call !== lapseAt) return;
    if (grant.left <= 0) throw mapNodeKeyError(403, "", `failed to ${call}`);
    grant.left -= 1;
  };
  const kv = {
    get: async (path: string) => records.has(path)
      ? { ok: true, data: { data: records.get(path), headers: { etag: etag(path) } } }
      : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing", service: "kv" } },
    put: async (path: string, body: string, putOptions?: { ifMatch?: string }) => {
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
  const open = (e: { ciphertext: string }) => base64Decode(e.ciphertext);
  const service = new DataVaultService({
    spaceId: SPACE_ID,
    encryption: {
      networkId: NETWORK_ID,
      service: { decryptEnvelope: async (e: { ciphertext: string }) => ({ ok: true, data: open(e) }) },
      namedKeys: async () => ({
        encrypt: async (keyPath: string, plaintext: Uint8Array, options: Record<string, unknown>) => {
          use("encrypt");
          return { ...envelope("", keyPath), ciphertext: base64Encode(plaintext), aad: base64Encode(options.aad as Uint8Array) };
        },
        decrypt: async (e: { ciphertext: string }) => {
          use("decrypt");
          return open(e);
        },
      }),
    },
    tc: { kv, did: "did:key:z6MkPrincipal", address: "0xabc", chainId: 1, hosts: ["https://tinycloud.test"] },
  } as never);
  service.initialize(context);
  for (const key of keys) write(`vault/${key}`, JSON.stringify(envelope(key)));
  const version = (key: string) => (JSON.parse(records.get(`vault/${key}`)!) as { v: number }).v;
  return { secrets: new SecretsService(service), grant, version };
}

describe("migrateSecrets with a key approval", () => {
  test("asks only for the keys that still move, before any reseal; moved, already and unreadable ones are never asked for", async () => {
    const v = vault({
      "secrets/API_KEY": 1,
      "secrets/scoped/my-app/API_KEY": 1,
      "secrets/DONE_KEY": 2,
      "secrets/LEGACY_KEY": "datavault",
    });
    const asked: (readonly string[])[] = [];

    const result = await migrateSecrets(v.secrets, {
      authorizeKeys: async (keyPaths) => {
        expect(v.log.some((line) => line.startsWith("reseal"))).toBe(false);
        asked.push(keyPaths);
      },
    });

    expect(asked).toEqual([["secrets/api_key", "secrets/scoped/my-app/api_key"]]);
    expect(result).toEqual({
      ok: true,
      data: { dryRun: false, total: 4, moved: 2, already: 1, staysOnNetwork: 0, skipped: { read_failed: 1 } },
    });
    expect(v.log.filter((line) => line.startsWith("reseal"))).toEqual([
      "reseal secrets/API_KEY",
      "reseal secrets/scoped/my-app/API_KEY",
    ]);
  });

  test("nothing left to move asks for nothing and, on a dry run, previews nothing", async () => {
    const v = vault({ "secrets/DONE_KEY": 2, "secrets/LEGACY_KEY": "datavault" });
    let asked = 0;
    const ask = async () => { asked += 1; };

    const result = await migrateSecrets(v.secrets, { authorizeKeys: ask });
    const dry = await migrateSecrets(v.secrets, { dryRun: true, authorizeKeys: ask, previewKeys: ask });

    expect(asked).toBe(0);
    expect(result).toMatchObject({ ok: true, data: { moved: 0, already: 1, skipped: { read_failed: 1 } } });
    expect(dry).toMatchObject({ ok: true, data: { moved: 0, already: 1, skipped: { read_failed: 1 } } });
  });

  test("a dry run previews the keys an approval would name and never asks", async () => {
    const v = vault({ "secrets/API_KEY": 1, "secrets/DONE_KEY": 2, "secrets/LEGACY_KEY": "datavault" });
    const previewed: (readonly string[])[] = [];
    let asked = 0;

    const result = await migrateSecrets(v.secrets, {
      dryRun: true,
      authorizeKeys: async () => { asked += 1; },
      previewKeys: async (keyPaths) => { previewed.push(keyPaths); },
    });

    expect({ asked, previewed }).toEqual({ asked: 0, previewed: [["secrets/api_key"]] });
    expect(result).toEqual({
      ok: true,
      data: { dryRun: true, total: 3, moved: 1, already: 1, staysOnNetwork: 0, skipped: { read_failed: 1 } },
    });
    expect(v.log.every((line) => line.startsWith("classify"))).toBe(true);
  });

  for (const lapseAt of ["encrypt", "decrypt"] as const) {
    test(`a key grant that lapses mid-move (${lapseAt} refused) skips the rest with the old copies kept, and a rerun asks for and moves exactly them`, async () => {
      const keys = Array.from({ length: 10 }, (_, i) => `secrets/KEY_${i}`);
      const v = lapsingVault(keys, lapseAt);
      v.grant.left = 4;
      const asked: (readonly string[])[] = [];
      const authorizeKeys = async (keyPaths: readonly string[]) => { asked.push(keyPaths); };

      // DataVaultService.resealToKey reports a refused key.create as permission_required and a refused verify decrypt
      // as verify_failed; neither throws, and nothing is written before the new copy opens.
      const first = await migrateSecrets(v.secrets, { authorizeKeys });

      expect(first).toEqual({
        ok: true,
        data: {
          dryRun: false, total: 10, moved: 4, already: 0, staysOnNetwork: 0,
          skipped: { [lapseAt === "encrypt" ? "permission_required" : "verify_failed"]: 6 },
        },
      });
      expect(keys.map(v.version).sort()).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
      const left = keys.filter((key) => v.version(key) === 1).map((key) => key.toLowerCase());

      v.grant.left = Infinity;
      const second = await migrateSecrets(v.secrets, { authorizeKeys });

      expect(asked).toEqual([keys.map((key) => key.toLowerCase()), left]);
      expect(second).toMatchObject({ ok: true, data: { moved: 6, already: 4, skipped: {} } });
      expect(keys.map(v.version)).toEqual(Array(10).fill(2));
    });
  }
});
