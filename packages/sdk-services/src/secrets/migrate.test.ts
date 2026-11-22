import { describe, expect, test } from "bun:test";

import type { VaultResealResult } from "../vault/types";
import type { ISecretsService, SecretCatalogEntry } from "./ISecretsService";
import { migrateSecrets } from "./migrate";

// A vault whose `resealToKey` answers from a table; it records what migrate asked for.
function service(catalog: SecretCatalogEntry[], outcomes: Record<string, VaultResealResult> = {}) {
  const calls: { key: string; keyPath: string; dryRun?: boolean }[] = [];
  const vault = {
    resealToKey: async (key: string, keyPath: string, options?: { dryRun?: boolean }) => {
      calls.push({ key, keyPath, ...options });
      return outcomes[key] ?? (options?.dryRun ? { status: "pending" } : { status: "moved" });
    },
  };
  const secrets = {
    vault,
    listAll: async () => ({ ok: true, data: catalog }),
  } as unknown as ISecretsService;
  return { secrets, calls };
}

const LONG = `A${"B".repeat(64)}`;

describe("migrateSecrets", () => {
  test("reseals every secret to its own key and reports counts by outcome", async () => {
    const { secrets, calls } = service(
      [{ name: "API_KEY" }, { name: "TOKEN", scope: "food-tracker" }, { name: "OLD" }, { name: "RACE" }, { name: LONG }],
      {
        "secrets/OLD": { status: "already" },
        "secrets/RACE": { status: "skipped", reason: "conflict" },
      },
    );

    const result = await migrateSecrets(secrets);

    expect(result).toEqual({
      ok: true,
      data: { dryRun: false, total: 5, moved: 2, already: 1, staysOnNetwork: 1, skipped: { conflict: 1 } },
    });
    expect(calls).toEqual([
      { key: "secrets/API_KEY", keyPath: "secrets/api_key", dryRun: false },
      { key: "secrets/scoped/food-tracker/TOKEN", keyPath: "secrets/scoped/food-tracker/token", dryRun: false },
      { key: "secrets/OLD", keyPath: "secrets/old", dryRun: false },
      { key: "secrets/RACE", keyPath: "secrets/race", dryRun: false },
    ]);
  });

  test("a dry run passes dryRun through and counts what would move", async () => {
    const { secrets, calls } = service([{ name: "API_KEY" }, { name: "OLD" }], { "secrets/OLD": { status: "already" } });

    const result = await migrateSecrets(secrets, { dryRun: true });

    expect(result).toEqual({
      ok: true,
      data: { dryRun: true, total: 2, moved: 1, already: 1, staysOnNetwork: 0, skipped: {} },
    });
    expect(calls.every((call) => call.dryRun === true)).toBe(true);
  });

  test("names and scope select secrets; a named secret not stored counts as not found", async () => {
    const { secrets, calls } = service([
      { name: "API_KEY" },
      { name: "API_KEY", scope: "food-tracker" },
      { name: "OTHER", scope: "food-tracker" },
    ]);

    const result = await migrateSecrets(secrets, { names: [" API_KEY", "MISSING"], scope: "Food Tracker" });

    expect(calls.map((call) => call.key)).toEqual(["secrets/scoped/food-tracker/API_KEY"]);
    expect(result).toEqual({
      ok: true,
      data: { dryRun: false, total: 2, moved: 1, already: 0, staysOnNetwork: 0, skipped: { not_found: 1 } },
    });
  });

  test("an invalid name is refused before anything is read", async () => {
    const { secrets, calls } = service([{ name: "API_KEY" }]);

    const result = await migrateSecrets(secrets, { names: ["api-key"] });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(calls).toEqual([]);
  });

  test("a vault without resealToKey is refused before any key is asked for", async () => {
    let asked = false;
    const secrets = { vault: {}, listAll: async () => ({ ok: true, data: [{ name: "API_KEY" }] }) } as unknown as ISecretsService;

    const result = await migrateSecrets(secrets, { authorizeKeys: async () => { asked = true; } });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(asked).toBe(false);
  });
});
