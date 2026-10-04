import { expect, test } from "bun:test";
import { authorizationVerdictOf } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { readDelegatedSecret } from "./delegated-secrets.js";

test.each([401, 403] as const)("delegated secret KV HTTP %i retains the original error as a typed cause", async (status) => {
  const failure = { code: "AUTH_UNAUTHORIZED", message: `${status} - refused`, meta: { status } };
  const node = {
    useDelegation: async () => ({ kv: { get: async () => ({ ok: false, error: failure }) } }),
    encryption: { decryptEnvelope: async () => { throw new Error("must not decrypt"); } },
  } as unknown as Parameters<typeof readDelegatedSecret>[0];
  await readDelegatedSecret(node, {} as PortableDelegation, "CREDENTIAL").then(
    () => { throw new Error("expected refusal"); },
    (error: unknown) => {
      expect((error as Error).message).toContain(`${status} - refused`);
      expect((error as Error & { cause: unknown }).cause).toBe(failure);
      expect(authorizationVerdictOf(error)).toBe(status === 401 ? "unauthenticated" : "forbidden");
    },
  );
});
