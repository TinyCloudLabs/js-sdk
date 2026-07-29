import { ed25519 } from "@noble/curves/ed25519";

import type { AuthorizationTarget, UnsignedShareEnvelope } from "../src/schema.js";

/** Deterministic ed25519 test key (32-byte seed). */
export const TEST_PRIV_KEY = new Uint8Array(32).fill(7);
export const TEST_PUB_KEY = ed25519.getPublicKey(TEST_PRIV_KEY);

/** policyBytes is base64url of `{"policy":"test"}`; policyCid is its real CIDv1/raw/sha2-256. */
export const POLICY_TARGET: AuthorizationTarget = {
  kind: "policy",
  policyCid: "bafkreig36s2hz442yqcnkctpkgtjev5pyjngzymyipk3koywg4d7rqmu5u",
  policyBytes: "eyJwb2xpY3kiOiJ0ZXN0In0",
};

export const BEARER_TARGET: AuthorizationTarget = {
  kind: "bearerKey",
  sessionJwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
    d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  },
};

export const RECIPIENT_DID_TARGET: AuthorizationTarget = {
  kind: "recipientDid",
  did: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
};

export function makeUnsignedEnvelope(
  overrides: Partial<UnsignedShareEnvelope> = {},
): UnsignedShareEnvelope {
  return {
    version: 1,
    shareId: "share-123",
    delegation: "uCAESA...opaque-serialized-delegation-chain",
    authorizationTarget: POLICY_TARGET,
    target: {
      origin: "https://share.tinycloud.xyz",
      nodeAudience: "did:web:node.tinycloud.xyz",
      spaceId: "space-abc",
      resource: { kind: "exact", path: "shares/share-123/report.md" },
    },
    display: {
      senderName: "Adam",
      filename: "report.md",
      recipientHint: "b***@gmail.com",
    },
    expiry: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}
