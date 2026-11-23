import { describe, expect, test } from "bun:test";
import { MAX_SECRET_NAME_LENGTH, MAX_SECRET_SCOPE_LENGTH } from "@tinycloud/sdk-services";

import type { CapabilityRequirement, OperationContext, RuntimeOperationContext } from "../contract.js";
import { redactOperationError } from "../redaction.js";
import { secretsGetOperationDefinition } from "./secrets-get.js";

// TC-3284: a secret read plans the network decrypt, which the secret's own key stands in for; the hint names that key.
// A secret still in the older format reports SECRET_LEGACY_ENVELOPE with the network decrypt to approve.
const OWNER = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const KEY = `${NETWORK}/secrets/api_key`;
const decrypt = (path: string): CapabilityRequirement => ({
  service: "tinycloud.encryption",
  path,
  actions: ["tinycloud.encryption/decrypt"],
});

function context(granted: CapabilityRequirement[], readSecret: () => Promise<unknown> = async () => ({ status: "not_found" })): OperationContext {
  return {
    summary: { profile: "owner", host: "https://node.tinycloud.test", posture: "owner-openkey", sessionDid: "did:key:session" },
    runtime: { node: { getEncryptionNetworkIdForSpace: () => NETWORK, readSecret }, granted },
  };
}

const parse = (input: { name: string; scope?: string }) => secretsGetOperationDefinition.input.parse(input);
const hints = (input: { name: string; scope?: string }) =>
  secretsGetOperationDefinition.runtimeHints!(context([]) as RuntimeOperationContext, parse(input));

describe("tinycloud.secrets.get per-secret keys", () => {
  test("the plan is the network decrypt; the secret's own key replaces it, and is the runtime hint", async () => {
    const ctx = context([]) as RuntimeOperationContext;
    expect((await secretsGetOperationDefinition.authority(ctx, parse({ name: "API_KEY" })))[1]).toEqual(decrypt(NETWORK));
    expect(await secretsGetOperationDefinition.authorityAlternatives!(ctx, parse({ name: "API_KEY" })))
      .toEqual([{ replaces: decrypt(NETWORK), satisfiedBy: decrypt(KEY) }]);
    expect(await hints({ name: "API_KEY" })).toEqual([decrypt(KEY)]);
  });

  test("a name or scope of 64 characters has a key", async () => {
    const longest = `A${"B".repeat(MAX_SECRET_NAME_LENGTH - 1)}`;
    const scope = "s".repeat(MAX_SECRET_SCOPE_LENGTH);
    expect(await hints({ name: longest })).toEqual([decrypt(`${NETWORK}/secrets/${longest.toLowerCase()}`)]);
    expect(await hints({ name: "API_KEY", scope })).toEqual([decrypt(`${NETWORK}/secrets/scoped/${scope}/api_key`)]);
  });

  test("a secret still in the older format reports SECRET_LEGACY_ENVELOPE with the network decrypt to approve", async () => {
    const outcome = await secretsGetOperationDefinition.execute(
      context([decrypt(KEY)], async () => ({ status: "legacy_envelope" })),
      parse({ name: "API_KEY" }),
    );
    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "SECRET_LEGACY_ENVELOPE", details: { names: ["API_KEY"], decrypt: NETWORK } },
    });
  });

  test("the decrypt to approve crosses the result boundary; anything else in details does not", () => {
    const error = { code: "SECRET_LEGACY_ENVELOPE" as const, message: "m", retryable: false, details: { names: ["API_KEY"], scope: "my-app", decrypt: NETWORK, value: "leak" } };
    expect(redactOperationError(secretsGetOperationDefinition, error).details).toEqual({ names: ["API_KEY"], scope: "my-app", decrypt: NETWORK });
    const odd = { ...error, details: { names: ["API_KEY"], decrypt: "https://example.test/steal" } };
    expect(redactOperationError(secretsGetOperationDefinition, odd).details).toEqual({ names: ["API_KEY"] });
  });
});
