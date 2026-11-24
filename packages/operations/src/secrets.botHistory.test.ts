import { describe, expect, test } from "bun:test";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";

import { secretsGetOperationDefinition } from "./operations/secrets-get.js";
import { secretsStatusOperationDefinition } from "./operations/secrets-status.js";
import { buildSecretManagerUrl, buildSecretRequestUrl, isValidSecretRequestScope } from "./secret-request.js";

// TinyChat's bot-history key and its data live under a reserved scope. The MCP/operations surfaces read secrets and
// build Secret Manager links (the owner is asked to add secrets in a scope): none of them accepts that scope, in any
// spelling that canonicalises to it. There is no operation that lists or deletes a secret.

// `secrets/scoped/<scope>/bot-history`: the scope, taken from the SDK's own path.
const BOT_HISTORY_SCOPE = BOT_HISTORY_KEY_PATH.split("/")[2]!;
const OWNER = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";

const SPELLINGS = [
  BOT_HISTORY_SCOPE,
  BOT_HISTORY_SCOPE.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join("-"),
  ` ${BOT_HISTORY_SCOPE.toUpperCase()} `,
];

describe("the bot-history scope on the operations surfaces", () => {
  for (const scope of SPELLINGS) {
    test(`secrets get refuses scope ${JSON.stringify(scope)} at parse`, () => {
      expect(secretsGetOperationDefinition.input.safeParse({ name: "SESSION", scope }).success).toBe(false);
    });

    test(`secrets status refuses scope ${JSON.stringify(scope)} at parse`, () => {
      expect(secretsStatusOperationDefinition.input.safeParse({ names: ["SESSION"], scope }).success).toBe(false);
    });
  }

  test("no Secret Manager link, request or manager, can carry the scope", () => {
    expect(isValidSecretRequestScope(BOT_HISTORY_SCOPE)).toBe(false);
    expect(() => buildSecretRequestUrl({ owner: OWNER, names: ["SESSION"], scope: BOT_HISTORY_SCOPE })).toThrow();
    expect(() => buildSecretManagerUrl({ names: ["SESSION"], scope: BOT_HISTORY_SCOPE })).toThrow();
  });

  test("a scope that only starts like it is still accepted", () => {
    const other = BOT_HISTORY_SCOPE.slice(0, BOT_HISTORY_SCOPE.indexOf("-"));
    expect(secretsGetOperationDefinition.input.safeParse({ name: "SESSION", scope: other }).success).toBe(true);
    expect(isValidSecretRequestScope(other)).toBe(true);
  });
});
