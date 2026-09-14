import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object.js";
import { DELIVERY_ADMISSION_DOMAIN, validateShareDeliveryAuthorizationV3Bytes } from "./share-delivery-v3.js";

const seed = new Uint8Array(32).fill(7);
const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]))}`;
const senderKeyDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(8))]))}`;
const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(9))]))}`;
const shareCid = `bafkrei${"a".repeat(52)}`;
const jti = "A".repeat(22);

const envelope = {
  version: 3,
  policyCid: shareCid,
  shareId: "share-v3",
  recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
  actions: ["read"],
  resource: { kind: "exact", path: "shares/share-v3/report.pdf" },
  policy: { policyId: "pol_example", credentialRequirement: { credentialType: { id: "opencredentials.email/v1", version: 1 } } },
  target: { origin: "https://node.tinycloud.xyz", nodeAudience: nodeDid },
  attestedEnforcerBinding: { enforcerDid: nodeDid, nodeAudience: nodeDid },
  contentSource: { shareId: "share-v3", kvResource: `${ownerDid}/kv/shares/share-v3/report.pdf` },
  expiry: "2026-08-13T12:00:00Z",
  signature: { algorithm: "Ed25519", signerDid: ownerDid, value: "signature" },
};

const request = {
  envelope,
  shareCid,
  recipientEmail: "alice@example.com",
  shareUrl: `https://share.tinycloud.xyz/viewer?tc2=${"A".repeat(43)}`,
  documentName: "report.pdf",
  jti,
  expiresAt: "2026-08-06T12:05:00Z",
  requestBodyDigest: "B".repeat(43),
};

function response(overrides: Record<string, unknown> = {}): Uint8Array {
  const invitation = {
    schema: "xyz.tinycloud.credentials/invitation-request/v1",
    policyId: envelope.policyCid,
    recipient: request.recipientEmail,
    resource: envelope.contentSource.kvResource,
    credentialType: envelope.policy.credentialRequirement.credentialType.id,
    returnLink: request.shareUrl,
    envelopeRef: request.shareCid,
    label: request.documentName,
    shareExpiresAt: "2026-08-13T12:00:00Z",
    audience: "https://api.share.tinycloud.xyz",
    issuedAt: "2026-08-06T12:00:00Z",
    expiresAt: request.expiresAt,
    nonce: request.jti,
  };
  const admission = {
    ...invitation,
    schema: "xyz.tinycloud.policy/delivery-admission/v0",
    ownerDid,
    actions: ["tinycloud.kv/get"],
    senderKeyDid,
    ...overrides,
  };
  const digest = sha256(new TextEncoder().encode(`${DELIVERY_ADMISSION_DOMAIN}${canonicalize(admission)}`));
  return new TextEncoder().encode(JSON.stringify({
    request: invitation,
    admission: {
      ...admission,
      signature: { suite: "eddsa-ed25519-sha256-jcs-v1", signerDid: nodeDid, value: Buffer.from(ed25519.sign(digest, seed)).toString("base64url") },
    },
  }));
}

describe("v3 share delivery authorization", () => {
  it("accepts the exact generic invitation admission", () => {
    expect(validateShareDeliveryAuthorizationV3Bytes(response(), {
      request,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    }).request.envelopeRef).toBe(shareCid);
  });

  it("rejects a recipient substitution", () => {
    expect(() => validateShareDeliveryAuthorizationV3Bytes(response({ recipient: "other@example.com" }), {
      request,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    })).toThrow("not bound");
  });

  it("rejects a different sender key", () => {
    expect(() => validateShareDeliveryAuthorizationV3Bytes(response({ senderKeyDid: ownerDid }), {
      request,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    })).toThrow("not bound");
  });

  it("rejects a tampered admission signature", () => {
    const parsed = JSON.parse(new TextDecoder().decode(response()));
    parsed.admission.signature.value = `${parsed.admission.signature.value.startsWith("A") ? "B" : "A"}${parsed.admission.signature.value.slice(1)}`;
    expect(() => validateShareDeliveryAuthorizationV3Bytes(new TextEncoder().encode(JSON.stringify(parsed)), {
      request,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    })).toThrow("signature");
  });
});
