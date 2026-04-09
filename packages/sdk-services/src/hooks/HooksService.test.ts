import { describe, expect, test } from "bun:test";
import { HooksService } from "./HooksService";
import { ErrorCodes, type IServiceContext } from "../types";
import type { HookWebhookRegistration } from "./types";

function createContext(fetchImpl: IServiceContext["fetch"]): IServiceContext {
  return {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafybeitest",
      spaceId: "space-123",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: () => ({}) as never,
    invokeAny: undefined,
    fetch: fetchImpl,
    hosts: ["https://node.tinycloud.xyz"],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryableErrors: [],
    },
  };
}

describe("HooksService.register", () => {
  test("rejects missing or empty secrets before issuing a request", async () => {
    let fetchCalls = 0;
    const service = new HooksService({ host: "https://node.tinycloud.xyz" });
    service.initialize(
      createContext(async () => {
        fetchCalls += 1;
        throw new Error("unexpected fetch");
      }),
    );

    const webhook = {
      space: "space-123",
      service: "kv",
      pathPrefix: "hooks",
      abilities: ["tinycloud.kv/put"],
      callbackUrl: "https://example.com/hooks",
    } as Omit<HookWebhookRegistration, "secret">;

    const invalidSecrets = [undefined, "", "   "];
    for (const secret of invalidSecrets) {
      const result = await service.register({
        ...webhook,
        secret: secret as unknown as string,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
        expect(result.error.message).toContain("Webhook secret is required");
      }
    }

    expect(fetchCalls).toBe(0);
  });
});
