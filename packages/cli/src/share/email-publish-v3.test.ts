import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import {
  canonicalDigest,
  createEmailCredentialRequirement,
  credentialRequirementDigest,
} from "@tinycloud/sdk-core";
import { didKeyFromEd25519PublicKey, verifyEnvelopeV3SignatureOnly, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { publishEmailShareV3, type EmailPublishV3Input } from "./email-publish-v3.js";

const fixtures = new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url);
const descriptor = ((await Bun.file(fixtures).json()) as { vectors: { name: string; descriptor: unknown }[] }).vectors.find((vector) => vector.name === "email")!.descriptor;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ownerDid = didKeyFromEd25519PublicKey(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url"));
const nodeDid = ownerDid;
const spaceId = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:share";
const networkId = "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";

function harness(shareId: string) {
  const roots: Parameters<EmailPublishV3Input["createOwnerRoot"]>[0][] = [];
  let registered: Record<string, unknown> | undefined;
  let envelope: ShareEnvelopeV3 | undefined;
  const input: EmailPublishV3Input = {
    shareId, ownerDid, shareOrigin: "https://share.example", nodeOrigin: "https://node.example", enforcerDid: nodeDid,
    spaceId, address: "person@example.com", resourcePath: `shares/${shareId}/note.txt`, filename: "note.txt",
    mediaType: "text/plain", byteLength: 4, actions: ["read"], expiresAt: new Date(Date.now() + 3600_000),
    credentialDescriptor: descriptor, issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller",
    encryptionNetwork: networkId, encryptionKeyPath: `share/${shareId}`, encryptedSymmetricKeyHash: "a".repeat(64),
    keyVersion: 1, storedBytes: new TextEncoder().encode("encrypted-content"),
    sign: async (bytes) => new Uint8Array(signBytes(null, bytes, privateKey)),
    createOwnerRoot: async (request) => { roots.push(request); return { cid: `root-${request.role}`, delegationHeader: { Authorization: request.role === "policy-authority" ? "a.b.c" : "d.e.f" } }; },
    issueBinding: async (expiresAt) => ({
      schema: "xyz.tinycloud.policy/attested-enforcer/v2", enforcerDid: nodeDid, nodeAudience: nodeDid,
      attestationBindingDigestHex: "b".repeat(64), issuedAt: new Date().toISOString(), expiresAt,
      signature: { suite: "Ed25519", signerDid: nodeDid, value: Buffer.alloc(64).toString("base64url") },
    }),
    registerPolicy: async (request) => { registered = request; return { policyCid: request.policyCid, policyRootCid: "root-policy-authority", enforcementRootCid: "root-policy-enforcement" }; },
    onDeliveryMaterial: (material) => { envelope = material.envelope as ShareEnvelopeV3; },
    upload: { uploadBlob: async ({ cid, deleteAfter }) => ({ cid, deleteAfter }) },
  };
  return { input, roots, get registered() { return registered; }, get envelope() { return envelope; } };
}

describe("CLI V3 email publisher", () => {
  test("publishes an exact encrypted leaf and the six-field credential commitment", async () => {
    const first = harness("shareone1234567890");
    const second = harness("sharetwo1234567890");
    const firstResult = await publishEmailShareV3(first.input);
    const secondResult = await publishEmailShareV3(second.input);
    expect(firstResult.metadata.envelopeVersion).toBe(3);
    expect(secondResult.metadata.envelopeVersion).toBe(3);
    for (const { input, roots, registered, envelope } of [first, second]) {
      expect(envelope?.version).toBe(3);
      expect(envelope?.contentSource.encryptionKeyPath).toBe(`share/${input.shareId}`);
      expect(envelope?.contentSource.encryptionNetwork).toBe(networkId);
      expect(envelope?.contentSource.encryptedSymmetricKeyDigestHex).toBe(input.encryptedSymmetricKeyHash);
      expect(envelope?.contentSource.keyVersion).toBe(1);
      expect(envelope?.policy.capabilityCeiling).toContainEqual({ kind: "encryption", resource: `${networkId}/share/${input.shareId}`, action: "tinycloud.encryption/decrypt" });
      expect(envelope?.policy.capabilityCeiling).toContainEqual({ kind: "kv", resource: `${spaceId}/kv/${input.resourcePath}`, selector: "exact", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] });
      expect(roots.map((root) => root.capabilities)).toEqual([envelope?.policy.capabilityCeiling, envelope?.policy.capabilityCeiling]);
      expect(registered?.policy).toEqual(envelope?.policy);
      expect(verifyEnvelopeV3SignatureOnly(envelope!)).toBe(true);
      const commitment = envelope?.policy.schema === "xyz.tinycloud.policy/policy/v2" ? envelope.policy.credentialRequirement : undefined;
      const requirement = createEmailCredentialRequirement({ email: input.address, profile: { id: "tinycloud.email-proof/v1", version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 } });
      expect(commitment).toEqual({
        type: "TinyCloudPolicyCredentialRequirement", version: 1,
        requirementDigest: await credentialRequirementDigest(requirement), descriptorDigest: await canonicalDigest(descriptor),
        issuerDid: input.issuerDid, issuerKid: input.issuerKid,
        profile: requirement.profile, credentialType: requirement.credentialType,
      });
    }
    expect(first.envelope?.contentSource.encryptionKeyPath).not.toBe(second.envelope?.contentSource.encryptionKeyPath);
  });

  test("rejects a mismatched issuer before root creation or registration", async () => {
    const plan = harness("sharebad1234567890");
    await expect(publishEmailShareV3({ ...plan.input, issuerKid: "did:web:issuer.credentials.org#other" })).rejects.toThrow();
    expect(plan.roots).toHaveLength(0);
    expect(plan.registered).toBeUndefined();
  });

  test("rejects a non-default network before policy publication", async () => {
    const plan = harness("sharebadnetwork1234");
    await expect(publishEmailShareV3({
      ...plan.input,
      encryptionNetwork: networkId.replace(/:default$/, ":share"),
    })).rejects.toThrow("email share binding is invalid");
    expect(plan.roots).toHaveLength(0);
    expect(plan.registered).toBeUndefined();
  });
});
