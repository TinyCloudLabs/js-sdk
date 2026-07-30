import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import {
  OWNER_SHARE_REGISTRATION_DOMAIN,
  computeOwnerShareRegistrationCid,
  createRegisteredPolicyAuthority,
  publishAddressedShare,
  receiveShare,
  type OwnerSharePolicyRegistration,
  type RegisterOwnerSharePolicyParams,
} from "../src/index.js";

const nodeSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const nodePublicKey = ed25519.getPublicKey(nodeSeed);
const nodeKid = "did:web:node.example#share-receipt-1";
const target = {
  origin: "https://node.example",
  nodeAudience: "did:web:node.example",
  enforcerDid: "did:web:node.example",
};

function registrationFor(input: RegisterOwnerSharePolicyParams): OwnerSharePolicyRegistration {
  const decoded = JSON.parse(new TextDecoder().decode(input.policy.bytes)) as {
    readonly policy: {
      readonly ownerDid: string;
      readonly shareKeyDid: string;
      readonly shareId: string;
      readonly recipientMatcher: OwnerSharePolicyRegistration["recipientMatcher"];
      readonly target: OwnerSharePolicyRegistration["target"] & { readonly enforcerDid: string };
      readonly resource: OwnerSharePolicyRegistration["resource"];
      readonly actions: OwnerSharePolicyRegistration["actions"];
      readonly contentSource: OwnerSharePolicyRegistration["contentSource"];
      readonly contentSourceDigest: string;
      readonly expiresAt: string;
    };
  };
  const policy = decoded.policy;
  const core = {
    policyCid: input.policy.cid,
    ownerDelegationCid: input.ownerDelegation.delegationCid,
    enforcementDelegationCid: input.enforcementDelegation.cid,
    ownerDid: policy.ownerDid,
    shareKeyDid: policy.shareKeyDid,
    enforcerDid: policy.target.enforcerDid,
    shareId: policy.shareId,
    recipientMatcher: policy.recipientMatcher,
    target: { origin: policy.target.origin, nodeAudience: policy.target.nodeAudience, spaceId: policy.target.spaceId },
    resource: policy.resource,
    actions: policy.actions,
    contentSource: policy.contentSource,
    contentSourceDigest: policy.contentSourceDigest,
    registeredAt: "2026-07-30T12:00:00.000Z",
    expiresAt: policy.expiresAt,
  };
  return { registrationCid: computeOwnerShareRegistrationCid(core), ...core };
}

async function fixture() {
  let sealed = new Uint8Array();
  const published = await publishAddressedShare({
    shareId: "addressedroundtrip0001",
    shareOrigin: "https://share.tinycloud.xyz",
    nodeOrigin: target.origin,
    nodeAudience: target.nodeAudience,
    enforcerDid: target.enforcerDid,
    spaceId: "tinycloud:test:space",
    target: { kind: "email", address: "alice@example.com" },
    resource: { kind: "exact", path: "shares/addressedroundtrip0001/readme.md" },
    actions: ["read"],
    policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: { kind: "kv", space: "tinycloud:test:space", path: "shares/addressedroundtrip0001/readme.md", action: "tinycloud.kv/get" },
    filename: "readme.md",
    mediaType: "text/markdown",
    byteLength: 8,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    authority: {
      ownerDid: "did:key:z6Mkowner",
      async createOwnerDelegation(request) {
        return {
          delegationCid: "bafy-owner-delegation",
          signedDagCbor: Uint8Array.of(1, 2, 3),
          permissions: request.permissions,
          delegation: {
            delegateDID: request.delegateDid,
            spaceId: request.spaceId,
            path: request.permissions[0]!.path,
            actions: request.permissions[0]!.actions,
            expiry: request.expiresAt,
          },
        };
      },
      async registerOwnerSharePolicy(input) {
        const registration = registrationFor(input);
        const { registrationCid: _registrationCid, ...core } = registration;
        const signature = ed25519.sign(new TextEncoder().encode(`${OWNER_SHARE_REGISTRATION_DOMAIN}${canonicalize(core)}`), nodeSeed);
        return { registration, proof: { alg: "EdDSA", kid: nodeKid, signature: toBase64Url(signature) } };
      },
    },
    inline: true,
    upload: {
      async uploadBlob(input) {
        sealed = input.blob.slice();
        return { cid: input.cid, deleteAfter: input.deleteAfter };
      },
    },
  });
  return { published, sealed };
}

describe("canonical addressed publication", () => {
  it("round-trips through node-receipt policy verification", async () => {
    const { published } = await fixture();
    const result = await receiveShare(published.url, {
      expectedOrigin: "https://share.tinycloud.xyz",
      now: () => Date.parse("2026-07-30T12:00:00.000Z"),
      trustedPolicyAuthority: createRegisteredPolicyAuthority({
        nodeProof: { kid: nodeKid, publicKey: nodePublicKey },
        expectedTarget: target,
      }),
    });
    expect(result).toEqual({ state: "authorization-required", method: "email-claim" });
    expect(JSON.stringify(published)).not.toContain(published.url);
    expect(JSON.stringify(published)).not.toContain("policyBytes");
  });

  it("rejects the same self-consistent envelope without the enrolled node key", async () => {
    const { published } = await fixture();
    await expect(receiveShare(published.url, {
      expectedOrigin: "https://share.tinycloud.xyz",
      now: () => Date.parse("2026-07-30T12:00:00.000Z"),
      trustedPolicyAuthority: createRegisteredPolicyAuthority({
        nodeProof: { kid: nodeKid, publicKey: ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 2)) },
        expectedTarget: target,
      }),
    })).rejects.toMatchObject({ code: "capability-invalid" });
  });
});
