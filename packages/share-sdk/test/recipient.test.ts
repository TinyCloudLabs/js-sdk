import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, type ShareEnvelopeV2, toBase64Url } from "@tinycloud/share-envelope";
import { createAddressedAuthorization } from "../src/recipient.js";

const nodePrivateKey = new Uint8Array(32).fill(41);
const nodePublicKey = ed25519.getPublicKey(nodePrivateKey);
const nodeKid = "did:web:node.example#invitation-key-1";

function envelope(resource = "documents/plan.md"): ShareEnvelopeV2 {
  return {
    version: 2,
    shareId: "share-recipient-proof",
    recipientMatcher: { kind: "exactEmail", value: "person@example.com" },
    actions: ["read"],
    resource: { kind: "exact", path: resource },
    target: { origin: "https://node.example", nodeAudience: "did:web:node.example", spaceId: "space" },
    delegationCid: "bafy-delegation",
    authorityMaterialHandle: "amh_share",
    authorityMaterialDigest: "A".repeat(43),
    contentSource: { kind: "kv", space: "space", path: resource, action: "tinycloud.kv/get" },
    contentSourceDigest: "B".repeat(43),
    authorizationTarget: { kind: "recipientDid", did: "did:key:z6Mkholder" },
    display: {},
    expiry: "2030-01-01T00:00:00.000Z",
    encrypted: true,
    metadata: { byteLength: 5, mediaType: "text/markdown" },
    signature: { signerDid: "did:key:z6Mksigner", algorithm: "Ed25519", value: "" },
  } as unknown as ShareEnvelopeV2;
}

function signedProof(value: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...value };
  delete unsigned.proof;
  const signature = ed25519.sign(
    new TextEncoder().encode(`xyz.tinycloud.share/read-response/v2\0${canonicalize(unsigned)}`),
    nodePrivateKey,
  );
  return { detached: { alg: "EdDSA", kid: nodeKid, signature: toBase64Url(signature) }, response: value };
}

describe("addressed recipient response binding", () => {
  it("rejects a trusted node response signed for another resource", async () => {
    const target = envelope();
    const adapter = createAddressedAuthorization({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: nodeKid, invitationPublicKey: nodePublicKey },
      holderDid: "did:key:z6Mkholder",
    });
    const response = {
      type: "TinyCloudShareInvokeResponse",
      version: 2,
      action: "tinycloud.kv/get",
      resource: "documents/other.md",
      content: toBase64Url(new TextEncoder().encode("wrong")),
      bodyDigest: "C".repeat(43),
      proof: { alg: "EdDSA", kid: nodeKid, signature: "placeholder" },
    };
    const proof = signedProof(response);
    const value = {
      bytes: new TextEncoder().encode("wrong"),
      bodyDigest: response.bodyDigest,
      contentSourceDigest: target.contentSourceDigest,
      binding: { shareId: target.shareId, delegationCid: target.delegationCid, authorityMaterialHandle: target.authorityMaterialHandle, authorityMaterialDigest: target.authorityMaterialDigest, resource: target.resource },
      proof,
    };
    await expect(adapter.verifyResult?.({ envelope: target, value, proof })).resolves.toBe(false);
  });

  it("accepts a response whose signed resource matches the requested share", async () => {
    const target = envelope();
    const adapter = createAddressedAuthorization({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: nodeKid, invitationPublicKey: nodePublicKey },
      holderDid: "did:key:z6Mkholder",
    });
    const response = {
      type: "TinyCloudShareInvokeResponse",
      version: 2,
      action: "tinycloud.kv/get",
      resource: target.resource.path,
      content: toBase64Url(new TextEncoder().encode("right")),
      bodyDigest: "C".repeat(43),
      proof: { alg: "EdDSA", kid: nodeKid, signature: "placeholder" },
    };
    const proof = signedProof(response);
    const value = {
      bytes: new TextEncoder().encode("right"),
      bodyDigest: response.bodyDigest,
      contentSourceDigest: target.contentSourceDigest,
      binding: { shareId: target.shareId, delegationCid: target.delegationCid, authorityMaterialHandle: target.authorityMaterialHandle, authorityMaterialDigest: target.authorityMaterialDigest, resource: target.resource },
      proof,
    };
    await expect(adapter.verifyResult?.({ envelope: target, value, proof })).resolves.toBe(true);
  });
});
