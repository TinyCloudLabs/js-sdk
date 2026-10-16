import { describe, expect, test } from "bun:test";

import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import { isLocalOwnerProfile } from "../profile.js";
import { createSafeOperationDiagnostic } from "../redaction.js";
import {
  secretsGetOperationDefinition,
} from "./secrets-get.js";

const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
const TARGET_SPACE =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:custom";

function context(
  readSecret: (input: Record<string, string>) => Promise<unknown>,
  nodeOverrides = {},
  localOwner = false,
): OperationContext {
  return {
    summary: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:session",
      space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default",
    },
    runtime: {
      node: {
        getEncryptionNetworkIdForSpace: () => NETWORK_ID,
        ...nodeOverrides,
        readSecret,
      },
      granted: [],
      localOwner,
    },
  };
}

describe("tinycloud.secrets.get", () => {
  test("normalizes references and plans exactly one KV read and one decrypt", async () => {
    const input = secretsGetOperationDefinition.input.parse({
      name: "  API_KEY ",
      scope: "Food Tracker",
      space: TARGET_SPACE,
    });
    const planned = await secretsGetOperationDefinition.authority(
      context(async () => ({ status: "not_found" })) as RuntimeOperationContext,
      input,
    );

    expect(input).toEqual({
      name: "API_KEY",
      scope: "food-tracker",
      space: TARGET_SPACE,
    });
    expect(planned).toEqual([
      {
        service: "tinycloud.kv",
        space: TARGET_SPACE,
        path: "vault/secrets/scoped/food-tracker/API_KEY",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.encryption",
        path: `${NETWORK_ID}/kv/${Buffer.from(TARGET_SPACE).toString("base64url")}/${Buffer.from("vault/secrets/scoped/food-tracker/API_KEY").toString("base64url")}`,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);
  });

  test("resolves the default secret to its canonical owner space before requesting decrypt", async () => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const planned = await secretsGetOperationDefinition.authority(
      context(async () => ({ status: "not_found" }), {
        getEncryptionNetworkIdForSpace: undefined,
        getDefaultEncryptionNetworkId: () => NETWORK_ID,
      }) as RuntimeOperationContext,
      input,
    );

    expect(planned).toEqual([
      {
        service: "tinycloud.kv",
        space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:secrets",
        path: "vault/secrets/API_KEY",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.encryption",
        path: `${NETWORK_ID}/kv/${Buffer.from("tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:secrets").toString("base64url")}/${Buffer.from("vault/secrets/API_KEY").toString("base64url")}`,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);
  });

  test("refuses a foreign owner's space instead of granting its decrypt through the selected network", async () => {
    const input = secretsGetOperationDefinition.input.parse({
      name: "API_KEY",
      space: "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:other",
    });
    await expect(secretsGetOperationDefinition.authority(
      context(async () => ({ status: "not_found" })) as RuntimeOperationContext,
      input,
    )).rejects.toThrow();
  });

  test("isolates a throwing scoped network resolver before using a valid local default", async () => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const planned = await secretsGetOperationDefinition.authority(
      context(async () => ({ status: "not_found" }), {
        getEncryptionNetworkIdForSpace: () => {
          throw new Error("scoped lookup unavailable");
        },
        getDefaultEncryptionNetworkId: () => NETWORK_ID,
      }) as RuntimeOperationContext,
      input,
    );

    expect(planned[1]).toMatchObject({ path: `${NETWORK_ID}/kv/${Buffer.from("tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:secrets").toString("base64url")}/${Buffer.from("vault/secrets/API_KEY").toString("base64url")}` });
  });

  test("fails closed when the encryption network cannot be resolved", async () => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });

    await expect(secretsGetOperationDefinition.authority(
      context(async () => ({ status: "not_found" }), {
        getEncryptionNetworkIdForSpace: () => undefined,
        getDefaultEncryptionNetworkId: () => undefined,
      }) as RuntimeOperationContext,
      input,
    )).rejects.toMatchObject({
      operationError: { code: "ENCRYPTION_NETWORK_UNRESOLVED" },
    });
  });

  test("reports untagged named records as owner rewrite required, not grant escalation", async () => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const result = await secretsGetOperationDefinition.execute(
      context(async () => ({ status: "scope_migration_required" })),
      input,
    );
    expect(result).toMatchObject({
      status: "error",
      error: { code: "SECRET_SCOPE_MIGRATION_REQUIRED" },
    });
  });

  test("returns the authorized value only from the successful result", async () => {
    const canary = "secret-value-canary";
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const result = await secretsGetOperationDefinition.execute(
      context(async (readInput) => {
        expect(readInput).toEqual({ space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:secrets", name: "API_KEY" });
        return { status: "ok", value: canary };
      }),
      input,
    );

    expect(result).toEqual({ status: "ok", output: { value: canary } });
    const diagnostic = createSafeOperationDiagnostic(secretsGetOperationDefinition, {
      operation: { operationId: "tinycloud.secrets.get", operationVersion: 1 },
      context: context(async () => ({ status: "not_found" })).summary,
      output: { value: canary },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(canary);
  });

  test("returns the canonical /request setup superset only after authorized absence", async () => {
    const input = secretsGetOperationDefinition.input.parse({
      name: "API_KEY",
      scope: "Food & Drinks",
      space: TARGET_SPACE,
    });
    const result = await secretsGetOperationDefinition.execute(
      context(async () => ({ status: "not_found" })),
      input,
    );

    const owner = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
    expect(result).toEqual({
      status: "setup_required",
      setup: {
        kind: "secret_manager",
        action: "add_secret",
        url: `https://secrets.tinycloud.xyz/request?owner=${encodeURIComponent(owner)}&name=API_KEY&scope=food-drinks&v=1`,
        names: ["API_KEY"],
        scope: "food-drinks",
        owner,
        secret: {
          name: "API_KEY",
          scope: "food-drinks",
          space: TARGET_SPACE,
        },
        message: "Ask the owner to add this secret in Secret Manager, then retry the operation.",
      },
      requiresCallerInput: true,
    });
    expect(JSON.stringify(result)).not.toContain("value");
  });

  test("a local identity, including a hybrid privateKey + OpenKey profile, gets KV_NOT_FOUND with no link", async () => {
    // The runtime sets localOwner from isLocalOwnerProfile, which accepts the hybrid profile.
    expect(isLocalOwnerProfile({ posture: "owner-openkey", authMethod: "openkey", privateKey: "0xabc" })).toBe(true);
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY", space: TARGET_SPACE });
    const result = await secretsGetOperationDefinition.execute(
      context(async () => ({ status: "not_found" }), {}, true),
      input,
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "KV_NOT_FOUND",
        message: expect.stringContaining("tc secrets put API_KEY --stdin"),
        details: {
          names: ["API_KEY"],
          owner: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
          recoveryKind: "put_locally",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  test.each(["scoped", "a".repeat(65)])("a scope no request link can express (%s) is not_requestable, never INTERNAL_ERROR", async (scope) => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY", scope, space: TARGET_SPACE });
    const result = await secretsGetOperationDefinition.execute(
      context(async () => ({ status: "not_found" })),
      input,
    );

    expect(result).toMatchObject({
      status: "error",
      error: { code: "KV_NOT_FOUND", details: { names: ["API_KEY"], scope, recoveryKind: "not_requestable" } },
    });
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  test.each([
    ["read_failed", "SECRET_READ_FAILED"],
    ["corrupt_envelope", "SECRET_READ_FAILED"],
    ["decrypt_failed", "SECRET_DECRYPT_FAILED"],
    ["invalid_payload", "SECRET_DECRYPT_FAILED"],
    ["node_unreachable", "NODE_UNREACHABLE"],
  ] as const)("classifies %s as %s", async (status, code) => {
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const result = await secretsGetOperationDefinition.execute(
      context(async () => ({ status })),
      input,
    );

    expect(result).toMatchObject({ status: "error", error: { code } });
    expect(result).not.toMatchObject({ status: "setup_required" });
  });
});
