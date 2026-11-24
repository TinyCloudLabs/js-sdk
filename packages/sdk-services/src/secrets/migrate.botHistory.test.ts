import { expect, test } from "bun:test";

import type { ISecretsService, SecretCatalogEntry } from "./ISecretsService";
import { migrateSecrets } from "./migrate";
import { BOT_HISTORY_KEY_PATH } from "./paths";

// TinyChat's bot-history key and its data live under a reserved scope: migrate never counts, reads or reseals them.

// `secrets/scoped/<scope>/bot-history`: the scope, taken from the SDK's own path.
const BOT_HISTORY_SCOPE = BOT_HISTORY_KEY_PATH.split("/")[2]!;

function service(catalog: SecretCatalogEntry[]) {
  const resealed: string[] = [];
  const secrets = {
    vault: {
      resealToKey: async (key: string) => {
        resealed.push(key);
        return { status: "moved" as const };
      },
    },
    listAll: async () => ({ ok: true, data: catalog }),
  } as unknown as ISecretsService;
  return { secrets, resealed };
}

test("a secret under the bot-history scope is neither counted nor resealed", async () => {
  const { secrets, resealed } = service([
    { name: "API_KEY" },
    { name: "SESSION", scope: BOT_HISTORY_SCOPE },
    { name: "TOKEN", scope: "food-tracker" },
  ]);

  expect(await migrateSecrets(secrets)).toEqual({
    ok: true,
    data: { dryRun: false, total: 2, moved: 2, already: 0, staysOnNetwork: 0, skipped: {} },
  });
  expect(resealed).toEqual(["secrets/API_KEY", "secrets/scoped/food-tracker/TOKEN"]);
});

test("naming a secret that is only under the bot-history scope reports it not found and touches nothing", async () => {
  const { secrets, resealed } = service([{ name: "SESSION", scope: BOT_HISTORY_SCOPE }]);

  expect(await migrateSecrets(secrets, { names: ["SESSION"] })).toEqual({
    ok: true,
    data: { dryRun: false, total: 1, moved: 0, already: 0, staysOnNetwork: 0, skipped: { not_found: 1 } },
  });
  expect(resealed).toEqual([]);
});

test("migrating the bot-history scope itself is refused before the catalog is read", async () => {
  let listed = 0;
  const secrets = {
    vault: { resealToKey: async () => ({ status: "moved" as const }) },
    listAll: async () => { listed += 1; return { ok: true, data: [] }; },
  } as unknown as ISecretsService;

  const result = await migrateSecrets(secrets, { scope: BOT_HISTORY_SCOPE });

  expect(result.ok).toBe(false);
  expect(listed).toBe(0);
});
