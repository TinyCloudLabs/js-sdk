import { describe, expect, test } from "bun:test";

import type { VaultResealResult } from "../vault/types";
import type { ISecretsService, SecretCatalogEntry } from "./ISecretsService";
import { migrateSecrets } from "./migrate";

// TC-4248: with a key approval to ask for, migrate classifies first and asks only for the keys that still have to
// move, so a move stopped part way (a grant that lapses mid-reseal) leaves each secret old or new and a rerun asks
// for exactly the rest.

/** A vault of v1/v2 records; `grantLeft` is how many reseals the key grant still covers before it lapses. */
function vault(records: Record<string, 1 | 2 | "datavault">, grantLeft = Infinity) {
  const state = { ...records };
  const log: string[] = [];
  const grant = { left: grantLeft };
  const resealToKey = async (key: string, _keyPath: string, options?: { dryRun?: boolean }): Promise<VaultResealResult> => {
    log.push(`${options?.dryRun ? "classify" : "reseal"} ${key}`);
    const record = state[key];
    if (record === "datavault") return { status: "skipped", reason: "read_failed" };
    if (record === 2) return { status: "already" };
    if (options?.dryRun) return { status: "pending" };
    if (grant.left <= 0) return { status: "skipped", reason: "permission_required" };
    grant.left -= 1;
    state[key] = 2;
    return { status: "moved" };
  };
  const catalog: SecretCatalogEntry[] = Object.keys(records).map((key) => {
    const parts = key.split("/");
    return parts[1] === "scoped" ? { name: parts[3]!, scope: parts[2]! } : { name: parts[1]! };
  });
  const secrets = { vault: { resealToKey }, listAll: async () => ({ ok: true, data: catalog }) } as unknown as ISecretsService;
  return { secrets, state, log, grant };
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

  test("nothing left to move asks for nothing", async () => {
    const v = vault({ "secrets/DONE_KEY": 2, "secrets/LEGACY_KEY": "datavault" });
    let asked = 0;

    const result = await migrateSecrets(v.secrets, { authorizeKeys: async () => { asked += 1; } });

    expect(asked).toBe(0);
    expect(result).toMatchObject({ ok: true, data: { moved: 0, already: 1, skipped: { read_failed: 1 } } });
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

  test("a grant that lapses mid-move leaves each secret old or new, and a rerun asks for and moves exactly the rest", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `secrets/KEY_${i}`);
    const v = vault(Object.fromEntries(keys.map((key) => [key, 1 as const])), 4);
    const asked: (readonly string[])[] = [];
    const authorizeKeys = async (keyPaths: readonly string[]) => { asked.push(keyPaths); };

    const first = await migrateSecrets(v.secrets, { authorizeKeys });

    expect(first).toEqual({
      ok: true,
      data: { dryRun: false, total: 10, moved: 4, already: 0, staysOnNetwork: 0, skipped: { permission_required: 6 } },
    });
    expect(Object.values(v.state).every((record) => record === 1 || record === 2)).toBe(true);
    const left = keys.filter((key) => v.state[key] === 1).map((key) => key.toLowerCase());
    expect(left).toHaveLength(6);

    v.grant.left = Infinity;
    const second = await migrateSecrets(v.secrets, { authorizeKeys });

    expect(asked[1]).toEqual(left);
    expect(second).toMatchObject({ ok: true, data: { moved: 6, already: 4, skipped: {} } });
    expect(await migrateSecrets(v.secrets, { dryRun: true })).toMatchObject({ ok: true, data: { moved: 0, already: 10 } });
  });
});
