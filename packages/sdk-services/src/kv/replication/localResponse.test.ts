import { describe, expect, test } from "bun:test";
import type { IServiceContext } from "../../types";
import { KVService } from "../KVService";
import { parseLocalValue } from "./localResponse";

const context = (body: string, contentType?: string): IServiceContext => ({
  session: {
    delegationHeader: { Authorization: "Bearer test" },
    delegationCid: "bafybeitest",
    spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
    verificationMethod: "did:key:test",
    jwk: {},
  },
  isAuthenticated: true,
  invoke: () => ({ Authorization: "Bearer signed-invocation" }),
  fetch: async () => new Response(body, { status: 200, headers: contentType ? { "content-type": contentType, etag: '"etag"' } : { etag: '"etag"' } }),
  hosts: ["https://node.tinycloud.xyz"],
  getService: () => undefined,
  emit: () => undefined,
  on: () => () => undefined,
  abortSignal: new AbortController().signal,
  retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
});

async function parseThroughNetwork(body: string, contentType?: string, options: { raw?: boolean; binary?: boolean } = {}) {
  const service = new KVService({});
  service.initialize(context(body, contentType));
  return service.get("notes/a", options);
}

describe("local KV value parsing matches KVService", () => {
  const cases: Array<[string | undefined, string, { raw?: boolean; binary?: boolean }, unknown]> = [
    ["application/json", "{\"ok\":true}", {}, { ok: true }],
    ["text/plain", "{\"ok\":true}", {}, "{\"ok\":true}"],
    [undefined, "{\"ok\":true}", {}, { ok: true }],
    [undefined, "not-json", {}, "not-json"],
    [undefined, "", {}, undefined],
    ["application/json", "{\"ok\":true}", { raw: true }, "{\"ok\":true}"],
  ];
  for (const [contentType, body, options, expected] of cases) {
    test(`uses the same parser for ${contentType ?? "no content type"} / ${body}`, async () => {
      const bytes = new TextEncoder().encode(body);
      const local = parseLocalValue(bytes, contentType, options.raw, options.binary);
      const network = await parseThroughNetwork(body, contentType, options);
      expect(network.ok && network.data.data).toEqual(expected);
      expect(local).toEqual(expected);
    });
  }

  test("binary parsing preserves every byte", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 254, 1]);
    const value = parseLocalValue<Uint8Array>(bytes, "image/png", undefined, true);
    expect([...value]).toEqual([...bytes]);
  });
});
