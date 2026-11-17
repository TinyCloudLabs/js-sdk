import { describe, expect, test } from "bun:test";
import { HooksService } from "./HooksService";
import { ErrorCodes, type IServiceContext } from "../types";
import { isReservedWebhookHeader, webhookHeadersProblem } from "./webhookHeaders";

const BEARER = "Bearer grok-routine-key-DO-NOT-LEAK";

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
    retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
  };
}

function service(fetchImpl: IServiceContext["fetch"]): HooksService {
  const hooks = new HooksService({ host: "https://node.tinycloud.xyz" });
  hooks.initialize(createContext(fetchImpl));
  return hooks;
}

const webhook = {
  space: "space-123",
  service: "sql" as const,
  pathPrefix: "feed/responses",
  callbackUrl: "https://grok.example/routine/hook",
  secret: "hmac-secret",
};

describe("webhook custom headers", () => {
  test("register sends the headers to the node and returns only their names", async () => {
    let sent: Record<string, unknown> | undefined;
    const hooks = service(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      // A node that echoed the values back must not leak them through the SDK.
      return Response.json({
        id: "wh-1", space: "space-123", service: "sql", pathPrefix: "feed/responses",
        callbackUrl: webhook.callbackUrl, active: true, createdAt: "2026-11-17T13:00:00Z",
        headerNames: ["Authorization"], headers: { Authorization: BEARER },
      });
    });

    const result = await hooks.register({ ...webhook, headers: { Authorization: BEARER } });

    expect(sent?.headers).toEqual({ Authorization: BEARER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.headerNames).toEqual(["Authorization"]);
    expect(JSON.stringify(result.data)).not.toContain(BEARER);
  });

  test("a registration without headers sends no headers field", async () => {
    let sent: Record<string, unknown> | undefined;
    const hooks = service(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        id: "wh-2", space: "space-123", service: "sql", callbackUrl: webhook.callbackUrl, active: true, createdAt: "2026-11-17T13:00:00Z",
      });
    });
    const result = await hooks.register({ ...webhook, headers: {} });
    expect(result.ok).toBe(true);
    expect(sent).toBeDefined();
    expect("headers" in sent!).toBe(false);
    if (result.ok) expect(result.data.headerNames).toBeUndefined();
  });

  test.each(["Host", "content-length", "Cookie", "X-TinyCloud-Signature", "Content-Type", "Transfer-Encoding"])(
    "register refuses reserved header %s before any request, without echoing its value",
    async (name) => {
      let calls = 0;
      const hooks = service(async () => { calls += 1; throw new Error("unexpected fetch"); });
      const result = await hooks.register({ ...webhook, headers: { [name]: BEARER } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCodes.INVALID_INPUT);
      expect(result.error.meta).toMatchObject({ field: "headers" });
      expect(JSON.stringify(result.error)).not.toContain(BEARER);
      expect(calls).toBe(0);
    },
  );

  test("list returns header names for each webhook and never values", async () => {
    const hooks = service(async () => Response.json([
      {
        id: "wh-1", space: "space-123", service: "sql", callbackUrl: webhook.callbackUrl, active: true,
        createdAt: "2026-11-17T13:00:00Z", header_names: ["Authorization", "X-Routine"],
        encrypted_headers: "ciphertext", headers: { Authorization: BEARER },
      },
    ]));
    const result = await hooks.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.headerNames).toEqual(["Authorization", "X-Routine"]);
    expect(JSON.stringify(result.data)).not.toContain(BEARER);
    expect(JSON.stringify(result.data)).not.toContain("ciphertext");
  });
});

describe("webhookHeadersProblem", () => {
  test("accepts an Authorization bearer and ordinary custom headers", () => {
    expect(webhookHeadersProblem(undefined)).toBeUndefined();
    expect(webhookHeadersProblem({ Authorization: BEARER, "X-Routine-Id": "abc_123" })).toBeUndefined();
  });

  test("refuses reserved names in any case, and the reserved prefixes", () => {
    for (const name of ["HOST", "Content-Length", "cookie", "Set-Cookie", "X-TinyCloud-Delivery-Id", "x-forwarded-for", "Proxy-Authorization", "Sec-Fetch-Mode", "Connection", "Upgrade"]) {
      expect(isReservedWebhookHeader(name)).toBe(true);
      expect(webhookHeadersProblem({ [name]: "v" })).toContain("reserved");
    }
    expect(isReservedWebhookHeader("Authorization")).toBe(false);
    expect(isReservedWebhookHeader("constructor")).toBe(false);
  });

  test("refuses injection, bad names, duplicates differing in case, and oversize sets", () => {
    expect(webhookHeadersProblem({ "X-A": "ok\r\nX-Injected: 1" })).toBeDefined();
    expect(webhookHeadersProblem({ "X-A": "caf\u00e9" })).toBeDefined();
    expect(webhookHeadersProblem({ "X-A": " padded " })).toBeDefined();
    expect(webhookHeadersProblem({ "X-A": "" })).toBeDefined();
    expect(webhookHeadersProblem({ "bad name": "v" })).toBeDefined();
    expect(webhookHeadersProblem({ "": "v" })).toBeDefined();
    expect(webhookHeadersProblem({ "X-A": "1", "x-a": "2" })).toContain("more than once");
    expect(webhookHeadersProblem(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`X-H${index}`, "v"])))).toContain("limited to 8");
    expect(webhookHeadersProblem({ "X-A": "v".repeat(1025) })).toBeDefined();
    expect(webhookHeadersProblem(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`X-H${index}`, "v".repeat(1000)])))).toContain("in total");
    expect(webhookHeadersProblem(["x"])).toBeDefined();
    expect(webhookHeadersProblem({ "X-A": 1 })).toBeDefined();
  });

  test("a problem names the header but never its value", () => {
    expect(webhookHeadersProblem({ Cookie: BEARER })).not.toContain(BEARER);
    expect(webhookHeadersProblem({ "X-A": `${BEARER}\n` })).not.toContain(BEARER);
  });
});
