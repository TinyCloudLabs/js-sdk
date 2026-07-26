import { describe, expect, test } from "bun:test";
import {
  canonicalOwnerSharePolicy,
  createDelegatedShareKey,
  createPolicyEnforcementDelegation,
  validateOwnerSharePolicyRegistration,
  type OwnerDelegationReceipt,
} from "./owner-policy";

const ownerDelegation: OwnerDelegationReceipt = {
  delegationCid: "bafy-owner-delegation",
  signedDagCbor: new Uint8Array([1, 2, 3]),
  delegation: {
    delegateDID: "did:key:z6MkwOwnerShareKey",
    spaceId: "tinycloud:pkh:eip155:1:0xowner:applications",
    path: "shares/share-1/document.md",
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    expiry: new Date("2030-01-01T00:00:00.000Z"),
  },
};

describe("owner share policy primitives", () => {
  test("keeps addressed private key material non-extractable", async () => {
    const key = createDelegatedShareKey({ extractable: false });
    expect(key.did).toMatch(/^did:key:z/);
    expect(key.privateJwk).toBeUndefined();
    const signature = await key.sign(new TextEncoder().encode("owner-share-test"));
    expect(signature).toHaveLength(64);
    key.clear();
    await expect(key.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  test("binds enforcement facts to the activated owner delegation", async () => {
    const key = createDelegatedShareKey({ extractable: false });
    const enforcement = await createPolicyEnforcementDelegation({
      ownerDelegation,
      shareKey: key,
      enforcerDid: "did:key:z6MkEnforcer",
      policyCid: "bafy-policy",
      shareId: "share-1",
      spaceId: ownerDelegation.delegation.spaceId,
      path: ownerDelegation.delegation.path,
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
      contentSourceDigest: "digest",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(enforcement.issuerDid).toBe(key.did);
    expect(enforcement.facts.ownerDelegationCid).toBe(ownerDelegation.delegationCid);
    expect(enforcement.facts.policyCid).toBe("bafy-policy");
    expect(enforcement.dagCbor).not.toContain("digest");
  });

  test("computes a canonical SHA-256 raw CID for policy bytes", async () => {
    const result = await canonicalOwnerSharePolicy({
      type: "TinyCloudSharePolicy",
      version: 2,
      shareId: "share-1",
      ownerDid: "did:pkh:eip155:1:0xowner",
      shareKeyDid: "did:key:z6MkShare",
      recipientMatcher: { kind: "emailDomain", value: "example.com" },
      target: { origin: "https://share.tinycloud.xyz", nodeAudience: "did:web:tee.node.tinycloud.xyz", enforcerDid: "did:key:z6MkEnforcer", spaceId: ownerDelegation.delegation.spaceId },
      resource: { kind: "exact", path: ownerDelegation.delegation.path },
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
      contentSource: { kind: "kv", space: ownerDelegation.delegation.spaceId, path: ownerDelegation.delegation.path },
      contentSourceDigest: "digest",
      ownerDelegationCid: ownerDelegation.delegationCid,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(result.cid).toMatch(/^bafkrei/);
    expect(result.digest).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("rejects a receipt that substitutes any chain identity", () => {
    expect(() => validateOwnerSharePolicyRegistration({
      registration: {
        registrationCid: "bafy-registration",
        policyCid: "bafy-other-policy",
        ownerDelegationCid: ownerDelegation.delegationCid,
        enforcementDelegationCid: "bafy-enforcement",
        ownerDid: "did:pkh:eip155:1:0xowner",
        shareKeyDid: "did:key:z6MkShare",
        enforcerDid: "did:key:z6MkEnforcer",
        target: { origin: "https://share.tinycloud.xyz", nodeAudience: "did:web:tee.node.tinycloud.xyz", enforcerDid: "did:key:z6MkEnforcer", spaceId: ownerDelegation.delegation.spaceId },
        resource: { kind: "exact", path: ownerDelegation.delegation.path },
        actions: ["tinycloud.kv/get"],
        contentSourceDigest: "digest",
        registeredAt: "2029-01-01T00:00:00.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      proof: { alg: "EdDSA", kid: "did:web:tee.node.tinycloud.xyz#key", signature: "sig" },
    }, {
      policy: { bytes: new Uint8Array([1]), cid: "bafy-policy", proof: "proof" },
      ownerDelegation,
      enforcementDelegation: { cid: "bafy-enforcement", dagCbor: "bytes", issuerDid: "did:key:z6MkShare", audienceDid: "did:key:z6MkEnforcer", facts: {}, signature: "sig" },
      contentSourceDigest: "digest",
    })).toThrow("policy bytes");
  });
});
