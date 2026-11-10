import { describe, expect, test } from "bun:test";
import { wireOpenKeyAuthorize } from "./openKeyBridge";

// TC-2276: expiry changes are opt-in; only an explicit true carries the flag.

async function forwardedRequest(input: { expiryChangeable?: boolean }): Promise<Record<string, unknown>> {
  let request: Record<string, unknown> | undefined;
  const authorize = wireOpenKeyAuthorize({
    async authorizeTinyCloud(received) {
      request = received as Record<string, unknown>;
      return {
        protocolVersion: 1,
        address: "0x0000000000000000000000000000000000000001",
        signature: "signature",
        signedMessage: "siwe",
        selectedActionKeys: [],
        permissions: [],
      };
    },
  });
  await authorize({ protocolVersion: 1, siwe: "siwe", jwk: { kty: "OKP", crv: "Ed25519", x: "public" }, verificationMethod: "did:key:test", ...input });
  return request!;
}

describe("wireOpenKeyAuthorize expiryChangeable", () => {
  test("forwards expiryChangeable: true", async () => {
    const request = await forwardedRequest({ expiryChangeable: true });
    expect(request.expiryChangeable).toBe(true);
  });

  test("leaves the key out when it is not set", async () => {
    const request = await forwardedRequest({});
    expect(Object.keys(request)).not.toContain("expiryChangeable");
  });

  test("leaves the key out for false", async () => {
    const request = await forwardedRequest({ expiryChangeable: false });
    expect(Object.keys(request)).not.toContain("expiryChangeable");
  });
});
