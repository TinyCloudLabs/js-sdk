import { describe, expect, test } from "bun:test";

import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import { createSafeOperationDiagnostic } from "../redaction.js";
import {
  secretsGetOperationDefinition,
} from "./secrets-get.js";

const NETWORK_ID = "urn:tinycloud:encryption:did:key:z6MkOwner:default";
const TARGET_SPACE =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:custom";

function context(readSecret: (input: Record<string, string>) => Promise<unknown>, nodeOverrides = {}): OperationContext {
  return {
    summary: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:session",
    },
    runtime: {
      node: {
        getEncryptionNetworkIdForSpace: () => NETWORK_ID,
        ...nodeOverrides,
        readSecret,
      },
      granted: [],
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
        path: NETWORK_ID,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);
  });

  test("uses the literal default secrets space and default network fallback", async () => {
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
        space: "secrets",
        path: "vault/secrets/API_KEY",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.encryption",
        path: NETWORK_ID,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);
  });

  test("preserves arbitrary full TinyCloud DID space text during planning and execution", async () => {
    const didSpace = "tinycloud:did:web:EXAMPLE.com:eip155:1:0xABCDEF:Vault";
    const input = secretsGetOperationDefinition.input.parse({
      name: "API_KEY",
      space: didSpace,
    });
    const readSecret = async (readInput: Record<string, string>) => {
      expect(readInput.space).toBe(didSpace);
      return { status: "ok", value: "did-space-value" };
    };
    const planned = await secretsGetOperationDefinition.authority(
      context(readSecret) as RuntimeOperationContext,
      input,
    );
    expect(planned[0]).toMatchObject({ service: "tinycloud.kv", space: didSpace });
    expect(await secretsGetOperationDefinition.execute(context(readSecret), input)).toMatchObject({
      status: "ok",
      output: { value: "did-space-value" },
    });
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

    expect(planned[1]).toMatchObject({ path: NETWORK_ID });
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

  test("returns the authorized value only from the successful result", async () => {
    const canary = "secret-value-canary";
    const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
    const result = await secretsGetOperationDefinition.execute(
      context(async (readInput) => {
        expect(readInput).toEqual({ space: "secrets", name: "API_KEY" });
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

  test("returns setup_required with an encoded URL only after authorized absence", async () => {
    const input = secretsGetOperationDefinition.input.parse({
      name: "API_KEY",
      scope: "Food & Drinks",
      space: TARGET_SPACE,
    });
    const result = await secretsGetOperationDefinition.execute(
      context(async () => ({ status: "not_found" })),
      input,
    );

    expect(result).toMatchObject({
      status: "setup_required",
      setup: {
        kind: "secret_manager",
        secret: {
          name: "API_KEY",
          scope: "food-drinks",
          space: TARGET_SPACE,
        },
        url: `https://secrets.tinycloud.xyz?name=API_KEY&scope=food-drinks&space=${encodeURIComponent(TARGET_SPACE)}`,
      },
    });
    expect(JSON.stringify(result)).not.toContain("value");
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
