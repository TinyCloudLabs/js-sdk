import { describe, expect, test } from "bun:test";
import {
  canonicalOwnerSharePolicy,
  createDelegatedShareKey,
  createPolicyEnforcementDelegation,
  computeOwnerShareRegistrationCid,
  OWNER_SHARE_REGISTRATION_DOMAIN,
  validateOwnerSharePolicyRegistration,
  type OwnerDelegationReceipt,
} from "./owner-policy";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object";

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

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

describe("owner share policy primitives", () => {
  test("keeps addressed private key material non-extractable", async () => {
    const key = await createDelegatedShareKey({ extractable: false });
    expect(key.did).toMatch(/^did:key:z/);
    expect(key.privateJwk).toBeUndefined();
    const signature = await key.sign(new TextEncoder().encode("owner-share-test"));
    expect(signature).toHaveLength(64);
    key.clear();
    await expect(key.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  test("binds enforcement facts to the activated owner delegation", async () => {
    const key = await createDelegatedShareKey({ extractable: false });
    const enforcement = await createPolicyEnforcementDelegation({
      ownerDelegation,
      shareKey: key,
      enforcerDid: "did:key:z6MkEnforcer",
      policyCid: "bafy-policy",
      shareId: "share-1",
      spaceId: ownerDelegation.delegation.spaceId,
      nodeAudience: "did:web:tee.node.tinycloud.xyz",
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
      contentSource: { kind: "kv", space: ownerDelegation.delegation.spaceId, path: ownerDelegation.delegation.path, action: "tinycloud.kv/get" },
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

  test("verifies the exact Node receipt kid with its canonical did:key fragment", async () => {
    const shareKey = await createDelegatedShareKey({ extractable: false });
    const policy = await canonicalOwnerSharePolicy({
      type: "TinyCloudSharePolicy",
      version: 2,
      shareId: "share-1",
      ownerDid: "did:pkh:eip155:1:0xowner",
      shareKeyDid: shareKey.did,
      recipientMatcher: { kind: "emailDomain", value: "example.com" },
      target: { origin: "https://share.tinycloud.xyz", nodeAudience: "did:web:tee.node.tinycloud.xyz", enforcerDid: "did:key:z6MkEnforcer", spaceId: ownerDelegation.delegation.spaceId },
      resource: { kind: "exact", path: ownerDelegation.delegation.path },
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
      contentSource: { kind: "kv", space: ownerDelegation.delegation.spaceId, path: ownerDelegation.delegation.path, action: "tinycloud.kv/get" },
      contentSourceDigest: "digest",
      ownerDelegationCid: ownerDelegation.delegationCid,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const policyProof = b64(await shareKey.sign(policy.bytes));
    const registrationCore = {
      policyCid: policy.cid,
      ownerDelegationCid: ownerDelegation.delegationCid,
      enforcementDelegationCid: "bafy-enforcement",
      ownerDid: "did:pkh:eip155:1:0xowner",
      shareKeyDid: shareKey.did,
      enforcerDid: "did:key:z6MkEnforcer",
      shareId: "share-1",
      recipientMatcher: { kind: "emailDomain", value: "example.com" },
      target: { origin: "https://share.tinycloud.xyz", nodeAudience: "did:web:tee.node.tinycloud.xyz", enforcerDid: "did:key:z6MkEnforcer", spaceId: ownerDelegation.delegation.spaceId },
      resource: { kind: "exact", path: ownerDelegation.delegation.path },
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
      contentSource: { kind: "kv", space: ownerDelegation.delegation.spaceId, path: ownerDelegation.delegation.path, action: "tinycloud.kv/get" },
      contentSourceDigest: "digest",
      registeredAt: "2098-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as const;
    const registration = { registrationCid: computeOwnerShareRegistrationCid(registrationCore), ...registrationCore };
    const signedBytes = new TextEncoder().encode(`${OWNER_SHARE_REGISTRATION_DOMAIN}${canonicalize(registrationCore)}`);
    const proof = { alg: "EdDSA" as const, kid: `${shareKey.did}#${shareKey.did.slice("did:key:".length)}`, signature: b64(await shareKey.sign(signedBytes)) };
    const result = validateOwnerSharePolicyRegistration({ registration, proof }, {
      policy: { ...policy, proof: policyProof },
      ownerDelegation,
      enforcementDelegation: { cid: "bafy-enforcement", dagCbor: "bytes", issuerDid: shareKey.did, audienceDid: "did:key:z6MkEnforcer", facts: { ownerDelegationCid: ownerDelegation.delegationCid, policyCid: policy.cid, shareId: "share-1", shareKeyDid: shareKey.did, enforcerDid: "did:key:z6MkEnforcer", nodeAudience: "did:web:tee.node.tinycloud.xyz", spaceId: ownerDelegation.delegation.spaceId, path: ownerDelegation.delegation.path, actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"], contentSourceDigest: "digest", expiresAt: "2099-01-01T00:00:00.000Z" }, signature: "sig" },
      contentSourceDigest: "digest",
      nodeProof: { kid: `${shareKey.did}#${shareKey.did.slice("did:key:".length)}`, publicKey: shareKey.publicKey },
    });
    expect(result.registration.registrationCid).toBe(registration.registrationCid);
  });
});
