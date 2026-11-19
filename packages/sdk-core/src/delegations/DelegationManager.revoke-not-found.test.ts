import { expect, mock, test } from "bun:test";
import type { ServiceSession } from "@tinycloud/sdk-services";
import { DelegationManager } from "./DelegationManager";
import type { SessionInvocationSigner } from "./types";

const HOST = "https://node.example";
const signer: SessionInvocationSigner = { did: () => "did:key:z6MkSessionFixtureOnly", sign: async () => "header.payload.signature" };

function managerAnswering(response: () => Response) {
  return new DelegationManager({
    hosts: [HOST],
    session: { spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default" } as ServiceSession,
    invoke: mock(() => ({ Authorization: "unused" })),
    invokeAny: mock(() => ({ Authorization: "unused" })),
    fetch: mock(async () => response()) as never,
    sessionInvocationSigner: signer,
  });
}

test("the node's `Space not found` 404 to a revocation is NOT_FOUND: the delegation is gone", async () => {
  const result = await managerAnswering(() => new Response("Space not found", { status: 404 })).revokeIssued("bafy-child");

  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({ code: "NOT_FOUND", message: "Delegation not found: bafy-child", meta: expect.objectContaining({ status: 404, cid: "bafy-child" }) }),
  });
});

test("a bare 404 (a proxy page, an empty body, an older node's other text) is a failed request, never NOT_FOUND", async () => {
  for (const body of ["", "<html><body>404 Not Found</body></html>", "Not Found", "Delegation not found"]) {
    const result = await managerAnswering(() => new Response(body, { status: 404 })).revokeIssued("bafy-child");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "NETWORK_ERROR", meta: expect.objectContaining({ status: 404, cid: "bafy-child" }) }),
    });
  }
});
