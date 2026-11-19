import { expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { KVService } from "./kv/KVService";
import { SQLService } from "./sql/SQLService";
import { DuckDbService } from "./duckdb/DuckDbService";
import { TinyCloudQuota } from "./quota/TinyCloudQuota";
import { NamedKeyClient, type NamedKeyClientConfig } from "./encryption/namedKeys";
import type { IServiceContext, ServiceSession } from "./types";

const session: ServiceSession = {
  delegationHeader: { Authorization: "test" }, delegationCid: "test",
  spaceId: "tinycloud:pkh:eip155:1:0x1:default", verificationMethod: "test", jwk: {},
};

function finiteBody() {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i]));
      controller.close();
    },
    cancel() { cancelled++; },
  });
  return { body, cancelled: () => cancelled };
}

for (const serviceName of ["kv", "sql", "duckdb"] as const) {
  for (const scenario of ["nonOK", "abort"] as const) {
    test(`${serviceName} ${scenario} body failure cancels and releases the foreground lane`, async () => {
      const host = `https://${serviceName}-${scenario}-owned.invalid`;
      const body = finiteBody();
      const abort = new AbortController();
      let seenSignal: AbortSignal | undefined;
      const owner = new ServiceContext({
        hosts: [host], session, invoke: () => ({}),
        // Deliberately ignores AbortSignal; cleanup must come from the consumer.
        fetch: async (_url, init) => {
          seenSignal = init?.signal;
          return new Response(body.body, { status: scenario === "nonOK" ? 400 : 200 });
        },
      });
      const sibling = new ServiceContext({
        hosts: [host], priority: "background", invoke: () => ({}),
        fetch: async () => new Response("next"),
      });
      const context: IServiceContext = {
        session, isAuthenticated: true, hosts: [host], abortSignal: owner.abortSignal,
        retryPolicy: owner.retryPolicy,
        invoke: () => ({}), getService: () => undefined, emit: () => undefined, on: () => () => {},
        fetch: async (url, init) => {
          const response = await owner.fetch(url, init);
          // Model an injected body adapter rejecting before it drains the native body.
          for (const method of scenario === "nonOK" ? ["text"] : ["text", "json"]) {
            Object.defineProperty(response, method, {
              configurable: true,
              value: async () => {
                if (scenario === "abort") {
                  abort.abort(Object.assign(new Error("Cancelled while reading"), { name: "AbortError" }));
                  throw abort.signal.reason;
                }
                throw new Error("body read failed");
              },
            });
          }
          return response;
        },
      };
      const service = serviceName === "kv" ? new KVService()
        : serviceName === "sql" ? new SQLService() : new DuckDbService();
      service.initialize(context);
      try {
        const result = service instanceof KVService
          ? await service.get("note", { signal: abort.signal })
          : await service.query("SELECT 1", [], { signal: abort.signal });
        expect(result.ok).toBe(false);
        if (!result.ok && scenario === "abort") expect(result.error.code).toBe("ABORTED");
        if (scenario === "abort") expect(seenSignal?.aborted).toBe(true);
        expect(body.cancelled()).toBe(1);
        const next = await sibling.fetch(`${host}/invoke`, { signal: AbortSignal.timeout(1500) });
        expect(await next.text()).toBe("next");
      } finally {
        owner.retire(); sibling.retire();
      }
    });
  }
}

test("quota owns a successful response when its JSON adapter rejects", async () => {
  const originalFetch = globalThis.fetch;
  const body = finiteBody();
  globalThis.fetch = (async () => {
    const response = new Response(body.body);
    Object.defineProperty(response, "json", { configurable: true, value: async () => {
      throw new DOMException("Cancelled", "AbortError");
    } });
    return response;
  }) as unknown as typeof fetch;
  try {
    const quota = new TinyCloudQuota(); quota.setQuotaUrl("https://quota-owned.invalid");
    await expect(quota.getQuota("space")).rejects.toThrow("Cancelled");
    expect(body.cancelled()).toBe(1);
  } finally { globalThis.fetch = originalFetch; }
});

test("quota releases an unread nonOK response", async () => {
  const originalFetch = globalThis.fetch;
  const body = finiteBody();
  globalThis.fetch = (async () => new Response(body.body, { status: 400 })) as unknown as typeof fetch;
  try {
    const quota = new TinyCloudQuota(); quota.setQuotaUrl("https://quota-owned.invalid");
    expect(await quota.getQuota("space")).toBeNull();
    expect(body.cancelled()).toBe(1);
  } finally { globalThis.fetch = originalFetch; }
});

test.each([200, 403])("named key graph fence owns a late %s response", async (status) => {
  const body = finiteBody();
  let stale = false;
  let calls = 0;
  const client = new NamedKeyClient({
    host: "https://named-owned.invalid", crypto: {} as NamedKeyClientConfig["crypto"],
    defaultNetworkId: () => "urn:tinycloud:encryption:did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed:default",
    assertActive: () => { if (stale) throw new DOMException("Graph retired", "AbortError"); },
    signInvocation: async () => ({ authorization: "test", invocationCid: "test" }),
    fetch: (async () => {
      if (++calls === 1) return Response.json({ nodeId: "did:key:node", features: ["encryption-named-keys-v1"] });
      stale = true;
      return new Response(body.body, { status });
    }) as unknown as typeof fetch,
  });
  await expect(client.getPublicKey("secrets/test")).rejects.toThrow("Graph retired");
  expect(calls).toBe(2);
  expect(body.cancelled()).toBe(1);
});
