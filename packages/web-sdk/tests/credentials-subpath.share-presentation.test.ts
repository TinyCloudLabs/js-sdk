import { expect, test } from "bun:test";
import { buildSharePresentation, SharePresentationError } from "../src/credentials-subpath";

test("credentials subpath: a share-route (route-A) challenge is rejected with CHALLENGE_ROUTE_UNSUPPORTED before any signing", async () => {
  const rejected = await buildSharePresentation({
    holderSigner: {} as never,
    result: {} as never,
    requirement: {} as never,
    challenge: {
      challengeId: "challenge-0000000000000001",
      nonce: "nonce-0000000000000001",
      policyCid: "policy-cid",
      recipientDid: "did:key:zHolder",
      expiresAt: "2099-01-01T00:00:00.000Z",
      action: "share",
    } as never,
    policy: {},
    expectedNodeAudience: "did:key:zNode",
    requestedCapabilities: [],
  }).catch((error: unknown) => error);

  expect(rejected).toBeInstanceOf(SharePresentationError);
  expect((rejected as SharePresentationError).code).toBe("CHALLENGE_ROUTE_UNSUPPORTED");
});
