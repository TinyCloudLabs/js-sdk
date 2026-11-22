import { describe, expect, test } from "bun:test";

import { evaluateOperationAuthority } from "../authority.js";
import type { CapabilityRequirement, OperationContext, RuntimeOperationContext } from "../contract.js";
import { redactOperationError } from "../redaction.js";
import { secretsGetOperationDefinition } from "./secrets-get.js";

// TC-3284: a secret read asks for the secret's own key; the network decrypt is only for a session that already reads
// with it, and for a secret that has no key of its own.
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

const plan = (granted: CapabilityRequirement[], name = "API_KEY") =>
  secretsGetOperationDefinition.authority(
    context(granted) as RuntimeOperationContext,
    secretsGetOperationDefinition.input.parse({ name }),
  );

describe("tinycloud.secrets.get per-secret keys", () => {
  test("plans the secret's own key for a session holding neither decrypt", async () => {
    expect((await plan([]))[1]).toEqual(decrypt(KEY));
  });

  test("a session that reads with the network decrypt, and not the key, keeps reading with it", async () => {
    expect((await plan([decrypt(NETWORK)]))[1]).toEqual(decrypt(NETWORK));
    expect((await plan([decrypt(NETWORK), decrypt(KEY)]))[1]).toEqual(decrypt(KEY));
  });

  test("a name over 64 bytes has no key of its own and plans the network decrypt", async () => {
    expect((await plan([], `A${"B".repeat(64)}`))[1]).toEqual(decrypt(NETWORK));
  });

  test("a held exact key satisfies the plan whatever the case of its owner address", () => {
    expect(evaluateOperationAuthority([decrypt(KEY)], [decrypt(KEY)]).satisfied).toBe(true);
    expect(evaluateOperationAuthority([decrypt(KEY.toLowerCase())], [decrypt(KEY)]).satisfied).toBe(true);
    expect(evaluateOperationAuthority([decrypt(NETWORK)], [decrypt(KEY)]).satisfied).toBe(false);
    expect(evaluateOperationAuthority([decrypt(`${NETWORK}/secrets/other`)], [decrypt(KEY)]).satisfied).toBe(false);
  });

  test("a secret still in the older format reports SECRET_LEGACY_ENVELOPE with the network decrypt to approve", async () => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const outcome = await secretsGetOperationDefinition.execute(
      context([decrypt(KEY)], async () => ({ status: "legacy_envelope" })),
      input,
    );
    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "SECRET_LEGACY_ENVELOPE", details: { names: ["API_KEY"], decrypt: NETWORK } },
    });
  });

  test("a secret on its own key, read with only the network decrypt, reports SECRET_KEY_GRANT_REQUIRED", async () => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const outcome = await secretsGetOperationDefinition.execute(
      context([decrypt(NETWORK)], async () => ({ status: "permission_required", hint: decrypt(KEY) })),
      input,
    );
    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "SECRET_KEY_GRANT_REQUIRED", details: { names: ["API_KEY"], decrypt: KEY } },
    });
  });

  test("a missing key grant on a session planned on that key stays an authority request", async () => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const outcome = await secretsGetOperationDefinition.execute(
      context([], async () => ({ status: "permission_required", hint: decrypt(KEY) })),
      input,
    );
    expect(outcome).toMatchObject({ status: "authority_required", missing: [decrypt(KEY)] });
  });

  test("the decrypt to approve crosses the result boundary; anything else in details does not", () => {
    for (const [code, path] of [["SECRET_LEGACY_ENVELOPE", NETWORK], ["SECRET_KEY_GRANT_REQUIRED", KEY]] as const) {
      const error = { code, message: "m", retryable: false, details: { names: ["API_KEY"], scope: "my-app", decrypt: path, value: "leak" } };
      expect(redactOperationError(secretsGetOperationDefinition, error).details).toEqual({ names: ["API_KEY"], scope: "my-app", decrypt: path });
      const odd = { ...error, details: { names: ["API_KEY"], decrypt: "https://example.test/steal" } };
      expect(redactOperationError(secretsGetOperationDefinition, odd).details).toEqual({ names: ["API_KEY"] });
    }
  });
});
