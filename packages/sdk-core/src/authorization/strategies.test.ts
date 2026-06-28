import { describe, expect, test } from "bun:test";

import { createOpenKeyCallbackSigningStrategy } from "./strategies";

describe("createOpenKeyCallbackSigningStrategy", () => {
  test("posts the signing request to OpenKey and returns the signature", async () => {
    const requests: unknown[] = [];
    const strategy = createOpenKeyCallbackSigningStrategy({
      endpoint: "https://openkey.test/api/delegate/sign",
      keyId: "key_123",
      token: "token_123",
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        expect((init?.headers as Record<string, string>).authorization).toBe(
          "Bearer token_123",
        );
        return new Response(JSON.stringify({ signature: "0xsigned" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await strategy.handler({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 1,
      message: "sign me",
      type: "siwe",
    });

    expect(response).toEqual({ approved: true, signature: "0xsigned" });
    expect(requests).toEqual([
      {
        address: "0x1234567890abcdef1234567890abcdef12345678",
        chainId: 1,
        keyId: "key_123",
        message: "sign me",
        type: "siwe",
      },
    ]);
  });

  test("returns a rejected callback response when OpenKey needs explicit approval", async () => {
    const strategy = createOpenKeyCallbackSigningStrategy({
      endpoint: "https://openkey.test/api/delegate/sign",
      fetch: async () =>
        new Response(
          JSON.stringify({
            needsApproval: true,
            approvalUrl: "https://openkey.test/approve/abc",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    const response = await strategy.handler({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 1,
      message: "sign me",
      type: "siwe",
    });

    expect(response.approved).toBe(false);
    expect(response.reason).toContain("https://openkey.test/approve/abc");
  });
});
