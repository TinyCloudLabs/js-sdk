import { expect, test } from "bun:test";
import { wireOpenKeyAuthorize } from "./openKeyBridge";

test("wireOpenKeyAuthorize forwards the requested display mode", async () => {
  let received: unknown;
  const authorize = wireOpenKeyAuthorize({
    async authorizeTinyCloud(_request, opts) {
      received = opts;
      return {
        protocolVersion: 1,
        address: "0x0000000000000000000000000000000000000001",
        signature: "signature",
        signedMessage: "siwe",
        selectedActionKeys: [],
        permissions: [],
      };
    },
  }, { mode: "redirect" });

  await authorize({ protocolVersion: 1, siwe: "siwe", jwk: {}, verificationMethod: "did:key:test" });
  expect(received).toEqual({ mode: "redirect" });
});
