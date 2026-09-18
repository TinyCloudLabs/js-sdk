import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object.js";
import {
  SHARE_DELIVERY_AUTHORIZATION_V3_DOMAIN,
  validateShareDeliveryAuthorizationV3Bytes,
} from "./share-delivery-v3.js";

const seed = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(seed);
const kid = "did:web:tee.node.tinycloud.xyz#invitation-key-1";
const shareCid = `bafkrei${"a".repeat(52)}`;
const policyCid = `bafkrei${"b".repeat(52)}`;
const policyRootCid = `bafkrei${"c".repeat(52)}`;
const enforcementRootCid = `bafkrei${"d".repeat(52)}`;
const jti = "A".repeat(22);

const envelope = {
  version: 3,
  shareId: "share-v3",
  recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
  actions: ["read"],
  resource: { kind: "exact", path: "shares/share-v3/report.pdf" },
  policyCid,
  policyRoot: { cid: policyRootCid },
  enforcementRoot: { cid: enforcementRootCid },
  target: { origin: "https://tee.node.tinycloud.xyz", nodeAudience: "did:key:zEnforcer" },
  display: { filename: "report.pdf" },
  contentSource: { shareId: "share-v3", kvResource: "did:key:zOwner/kv/shares/share-v3/report.pdf" },
  contentSourceDigestHex: "1".repeat(64),
  expiry: "2026-08-07T12:00:00Z",
  signature: { algorithm: "Ed25519", signerDid: "did:key:zOwner", value: "signature" },
};

const request = {
  envelope,
  sealedEnvelope: "sealed-envelope",
  envelopeKey: "A".repeat(43),
  shareCid,
  recipientEmail: "alice@example.com",
  shareUrl: `https://share.tinycloud.xyz/s/${shareCid}#k=${"A".repeat(43)}`,
  documentName: "report.pdf",
  jti,
  expiresAt: "2026-08-06T12:05:00Z",
  requestBodyDigest: "B".repeat(43),
};

function response(overrides: Record<string, unknown> = {}): Uint8Array {
  const authorization = {
    type: "TinyCloudShareDeliveryAuthorization",
    version: 3,
    jti,
    shareCid,
    shareId: envelope.shareId,
    policyCid,
    policyRootCid,
    enforcementRootCid,
    nodeAudience: "did:web:tee.node.tinycloud.xyz",
    enforcerDid: envelope.target.nodeAudience,
    targetOrigin: envelope.target.origin,
    openCredentialsAudience: "https://witness.credentials.org",
    holder: "did:key:zSession",
    recipientMatcher: envelope.recipientMatcher,
    deliveryEmail: request.recipientEmail,
    shareUrl: request.shareUrl,
    returnOrigin: "https://share.tinycloud.xyz",
    documentName: request.documentName,
    senderDid: "did:key:zOwner",
    senderTrust: "verified",
    contentSource: envelope.contentSource,
    contentSourceDigestHex: envelope.contentSourceDigestHex,
    shareExpiresAt: envelope.expiry,
    issuedAt: "2026-08-06T12:00:00Z",
    reportAbuseToken: jti,
    actions: ["read"],
    resource: "shares/share-v3/report.pdf",
    requestBodyDigest: request.requestBodyDigest,
    idempotencyKey: jti,
    expiresAt: request.expiresAt,
    dataAuthority: false,
    ...overrides,
  };
  const signature = ed25519.sign(new TextEncoder().encode(`${SHARE_DELIVERY_AUTHORIZATION_V3_DOMAIN}${canonicalize(authorization)}`), seed);
  return new TextEncoder().encode(JSON.stringify({
    authorization,
    proof: { alg: "EdDSA", kid, signature: Buffer.from(signature).toString("base64url") },
  }));
}

describe("v3 share delivery authorization", () => {
  it("accepts the exact Node-signed envelope/root projection", () => {
    expect(validateShareDeliveryAuthorizationV3Bytes(response(), {
      request,
      nodeProof: { kid, publicKey },
      credentialsAudience: "https://witness.credentials.org",
    }).authorization.policyRootCid).toBe(policyRootCid);
  });

  it("rejects a correctly Node-signed root that differs from the submitted envelope", () => {
    expect(() => validateShareDeliveryAuthorizationV3Bytes(response({ policyRootCid: `bafkrei${"e".repeat(52)}` }), {
      request,
      nodeProof: { kid, publicKey },
      credentialsAudience: "https://witness.credentials.org",
    })).toThrow("not bound");
  });

  it("rejects a correctly Node-signed receipt with an unverified sender", () => {
    expect(() => validateShareDeliveryAuthorizationV3Bytes(response({ senderTrust: "unknown" }), {
      request,
      nodeProof: { kid, publicKey },
      credentialsAudience: "https://witness.credentials.org",
    })).toThrow("not bound");
  });

  it("rejects a link whose fragment key differs from the submitted envelope key", () => {
    const mismatchedRequest = { ...request, envelopeKey: "B".repeat(43) };
    expect(() => validateShareDeliveryAuthorizationV3Bytes(response(), {
      request: mismatchedRequest,
      nodeProof: { kid, publicKey },
      credentialsAudience: "https://witness.credentials.org",
    })).toThrow("not bound");
  });
});
