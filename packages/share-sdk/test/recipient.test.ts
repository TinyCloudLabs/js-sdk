import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, type ShareEnvelopeV2, toBase64Url } from "@tinycloud/share-envelope";
import { createAddressedAuthorization, ShareRecipientClient } from "../src/recipient.js";

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

function responseFor(target: ShareEnvelopeV2, content = "right"): Record<string, unknown> {
  return {
    type: "TinyCloudShareInvokeResponse",
    version: 2,
    action: "tinycloud.kv/get",
    resource: target.resource.path,
    shareId: target.shareId,
    delegationCid: target.delegationCid,
    authorityMaterialHandle: target.authorityMaterialHandle,
    authorityMaterialDigest: target.authorityMaterialDigest,
    contentSourceDigest: target.contentSourceDigest,
    content: toBase64Url(new TextEncoder().encode(content)),
    bodyDigest: "C".repeat(43),
    proof: { alg: "EdDSA", kid: nodeKid, signature: "placeholder" },
  };
}

describe("addressed recipient response binding", () => {
  it("rejects a trusted node response signed for another resource", async () => {
    const target = envelope();
    const adapter = createAddressedAuthorization({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: nodeKid, invitationPublicKey: nodePublicKey },
      holderDid: "did:key:z6Mkholder",
    });
    const response = { ...responseFor(target, "wrong"), resource: "documents/other.md" };
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
    const response = responseFor(target);
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

  it("rejects a signed response that omits any authority binding", async () => {
    const target = envelope();
    const adapter = createAddressedAuthorization({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: nodeKid, invitationPublicKey: nodePublicKey },
      holderDid: "did:key:z6Mkholder",
    });
    const response = responseFor(target);
    delete response.authorityMaterialDigest;
    const proof = signedProof(response);
    const value = {
      bytes: new TextEncoder().encode("right"),
      bodyDigest: response.bodyDigest,
      contentSourceDigest: target.contentSourceDigest,
      binding: { shareId: target.shareId, delegationCid: target.delegationCid, authorityMaterialHandle: target.authorityMaterialHandle, authorityMaterialDigest: target.authorityMaterialDigest, resource: target.resource },
      proof,
    };
    await expect(adapter.verifyResult?.({ envelope: target, value, proof })).resolves.toBe(false);
  });

  it("restores the presented holder proof before resuming the addressed read", async () => {
    const target = {
      ...envelope(),
      ownerAuthority: {
        registrationCid: "registration",
        shareCid: "share-cid",
        envelopeCid: "envelope-cid",
        enforcementDelegation: { cid: "enforcement-cid" },
        outerEnvelope: {
          resource: { kind: "exact", path: "documents/plan.md" },
          target: { origin: "https://node.example", nodeAudience: "did:web:node.example" },
          contentSource: { kind: "kv", space: "space", path: "documents/plan.md", action: "tinycloud.kv/get" },
          contentSourceDigest: envelope().contentSourceDigest,
        },
      },
    } as ShareEnvelopeV2;
    const holderPrivateKey = new Uint8Array(32).fill(73);
    const holderDid = "did:key:z6Mkholder";
    const session = {
      type: "TinyCloudSharePolicySession",
      version: 2,
      sessionId: "session-resumed",
      shareCid: "share-cid",
      shareId: target.shareId,
      registrationCid: "registration",
      envelopeCid: "envelope-cid",
      policyCid: "",
      delegationCid: target.delegationCid,
      holderDid,
      targetOrigin: "https://node.example",
      nodeAudience: "did:web:node.example",
      action: "tinycloud.kv/get",
      actions: ["tinycloud.kv/get"],
      contentSource: target.contentSource,
      contentSourceDigest: target.contentSourceDigest,
      resource: target.resource.path,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const content = new TextEncoder().encode("right");
    const bodyDigest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
    const response = responseFor(target);
    response.bodyDigest = bodyDigest;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/share/v2/policy/session")) {
        const proof = { alg: "EdDSA", kid: nodeKid, signature: toBase64Url(ed25519.sign(new TextEncoder().encode(`xyz.tinycloud.share/policy-session/v2\0${canonicalize(session)}`), nodePrivateKey)) };
        return new Response(JSON.stringify({ session, proof }), { status: 200 });
      }
      if (url.endsWith("/share/v2/invoke")) {
        const unsigned = { ...response };
        delete unsigned.proof;
        const proof = ed25519.sign(new TextEncoder().encode(`xyz.tinycloud.share/read-response/v2\0${canonicalize(unsigned)}`), nodePrivateKey);
        return new Response(JSON.stringify({ ...response, proof: { alg: "EdDSA", kid: nodeKid, signature: toBase64Url(proof) } }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    };
    const client = new ShareRecipientClient({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: nodeKid, invitationPublicKey: nodePublicKey },
      holderDid,
      envelope: target,
      fetchFn,
      sign: async (bytes) => ed25519.sign(bytes, holderPrivateKey),
    });
    const result = await client.resumeWithProof(target, "resume-token", {
      nonce: "nonce-resumed",
      credential: "credential",
      holderDid,
      holderBinding: { holderDid },
      presentation: { type: "TinyCloudSharePolicyPresentation", version: 2 },
      presentationProof: { alg: "EdDSA", kid: "holder-key", signature: "presented" },
    });
    expect(result.bytes).toEqual(content);
  });
});
