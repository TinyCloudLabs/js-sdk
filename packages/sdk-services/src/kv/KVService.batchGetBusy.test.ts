import { expect, test } from "bun:test";
import { ServiceContext } from "../context";
import { ErrorCodes } from "../types";
import { KVService } from "./KVService";

// TC-3211: a batch read the node answers with its busy/timeout 503 carries the same error code as a single read, so a
// caller that sees the final error can tell that the SDK already retried it.

function batchOver(answer: () => Response): { service: KVService; wire: { requests: number } } {
  const wire = { requests: 0 };
  const context = new ServiceContext({
    hosts: ["https://node.test"],
    invoke: () => ({ Authorization: "signed" }),
    invokeAny: () => ({ Authorization: "signed" }),
    fetch: async () => {
      wire.requests += 1;
      return answer();
    },
    retryPolicy: { baseDelayMs: 1, maxDelayMs: 1 },
  });
  context.setSession({
    delegationHeader: { Authorization: "test" },
    delegationCid: "bafytest",
    spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
    verificationMethod: "did:key:test",
    jwk: {},
  });
  const service = new KVService({});
  service.initialize(context);
  return { service, wire };
}

test.each([
  ["sql_busy: begin: database is busy", ErrorCodes.NODE_BUSY],
  ["request_timeout: deadline passed", ErrorCodes.REQUEST_TIMEOUT],
])("a batch read the node answers with %s ends as %s after the SDK's attempts", async (body, code) => {
  const { service, wire } = batchOver(() => new Response(body, { status: 503, headers: { "retry-after": "0" } }));
  const result = await service.batchGet(["a", "b"]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    expect(result.error.meta).toMatchObject({ status: 503, retryable: true });
  }
  expect(wire.requests).toBe(4);
});

test("a batch read refused with a 503 that is not the node's busy answer stays a network error, sent once", async () => {
  const { service, wire } = batchOver(() => new Response("gateway unavailable", { status: 503 }));
  const result = await service.batchGet(["a", "b"]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(ErrorCodes.NETWORK_ERROR);
    expect(result.error.meta).toMatchObject({ status: 503 });
  }
  expect(wire.requests).toBe(1);
});
