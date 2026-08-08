import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";

import {
  didKeyFromEd25519PublicKey,
  signCompactUcanAuthorization,
  verifyCompactUcanAuthorization,
} from "../src/index.js";

describe("compact UCAN browser codec", () => {
  it("ignores an ambient Buffer polyfill that cannot encode base64url", async () => {
    const privateKey = new Uint8Array(32).fill(83);
    const issuerDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(privateKey));
    const originalBuffer = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    Object.defineProperty(globalThis, "Buffer", {
      configurable: true,
      value: { from: () => { throw new Error("browser Buffer polyfill does not support base64url"); } },
    });

    try {
      const authorization = await signCompactUcanAuthorization({
        issuerDid,
        audienceDid: "did:key:z6MkReceiver",
        attenuation: { "tinycloud:test/kv/report.txt": { "tinycloud.kv/get": [{}] } },
        facts: [{ type: "tinycloud.policy.root/v1" }],
        proofs: [],
        notBefore: 1_786_100_000,
        expiresAt: 1_786_100_060,
        nonce: "browser-codec",
        sign: async (bytes) => ed25519.sign(bytes, privateKey),
      });

      expect(verifyCompactUcanAuthorization(authorization.authorization, authorization.cid).payload.iss)
        .toBe(`${issuerDid}#${issuerDid.slice("did:key:".length)}`);
    } finally {
      if (originalBuffer === undefined) delete (globalThis as { Buffer?: unknown }).Buffer;
      else Object.defineProperty(globalThis, "Buffer", originalBuffer);
    }
  });
});
