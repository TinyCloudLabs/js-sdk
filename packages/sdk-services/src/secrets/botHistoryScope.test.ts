import { expect, test } from "bun:test";
import { appSecretScope, canonicalizeSecretScope, parseSecretCatalogKey, parseSecretKeyPath, resolveSecretPath, secretKeyPath } from "./paths";
import { SecretsService } from "./SecretsService";

const scope = "tinychat-bot-history";

test("the bot-history namespace cannot name a secret or a secret record", () => {
  expect(() => canonicalizeSecretScope(scope)).toThrow("reserved");
  expect(() => appSecretScope(scope)).toThrow("reserved");
  expect(() => resolveSecretPath("BOT_HISTORY", { scope })).toThrow("reserved");
  expect(() => secretKeyPath("BOT_HISTORY", scope)).toThrow("reserved");
  expect(parseSecretKeyPath(`secrets/scoped/${scope}/bot_history`)).toBeUndefined();
  expect(parseSecretKeyPath(`secrets/scoped/${scope}/bot-history`)).toBeUndefined();
  expect(parseSecretCatalogKey(`scoped/${scope}/BOT_HISTORY`)).toBeUndefined();
});

test("a secret put in the bot-history namespace is refused before opening the vault", async () => {
  const secrets = new SecretsService(() => { throw new Error("the reserved scope must not touch the vault"); });
  expect(await secrets.put("BOT_HISTORY", "fixture", { scope, namedKey: true })).toMatchObject({
    ok: false, error: { code: "INVALID_INPUT", message: expect.stringContaining("reserved") },
  });
});
