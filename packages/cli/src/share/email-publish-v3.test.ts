import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import { canonicalDigest, createEmailCredentialRequirement, credentialRequirementDigest, signCompactUcanRootAuthorization } from "@tinycloud/sdk-core";
import { canonicalize, toBase64Url, verifyEnvelopeV3, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { resolveLink } from "@tinycloud/share-envelope/links";
import { publishEmailShareV3, type EmailPublishV3Input } from "./email-publish-v3.js";

const vectors = new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url);
const descriptor = ((await Bun.file(vectors).json()) as { vectors: { name: string; descriptor: unknown }[] }).vectors.find((vector) => vector.name === "email")!.descriptor;
const ownerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(ownerSeed)]))}`;
const nodeSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(nodeSeed)]))}`;
// The wallet's canonical did:pkh owns the encryption network; the session's did:key signs the policy and roots.
const networkId = "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
const spaceId = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";

function harness(shareId: string) {
  const roots: string[] = [];
  let registered: Record<string, unknown> | undefined;
  const input: EmailPublishV3Input = {
    shareId, shareOrigin: "https://share.example", nodeOrigin: "https://node.example",
    nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId,
    target: { kind: "email", address: "person@example.com" },
    resource: { kind: "exact", path: `shares/${shareId}/note.txt` },
    actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId, kvResource: `${spaceId}/kv/shares/${shareId}/note.txt`, selector: "exact",
      encryptionNetwork: networkId, encryptionKeyPath: `share/${shareId}`,
      encryptedSymmetricKeyDigestHex: "a".repeat(64), keyVersion: 1,
      mode: "immutable", initialCiphertextDigestHex: "b".repeat(64),
    },
    filename: "note.txt", mediaType: "text/plain", byteLength: 4,
    expiresAt: new Date(Date.now() + 3600_000),
    credentialDescriptor: descriptor, issuerDid: "did:web:issuer.credentials.org",
    issuerKid: "did:web:issuer.credentials.org#controller",
    authority: {
      ownerDid,
      async sign(bytes) { return ed25519.sign(bytes, ownerSeed); },
      async createOwnerRoot(request) {
        roots.push(request.role);
        const attenuation = Object.fromEntries(request.capabilities.map((capability) => [
          capability.resource,
          capability.kind === "encryption"
            ? { [capability.action]: [{}] }
            : Object.fromEntries(capability.actions.map((action) => [action, [{ type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource }]])),
        ]));
        const facts = {
          role: request.role,
          mode: request.role === "policy-authority" ? "policy-source" : "conditional-mint",
          ownerDid, policyId: request.policyId, policyDigestHex: request.policyDigestHex,
          policyCid: request.policyCid, contentSourceDigestHex: request.contentSourceDigestHex,
          capabilityCeilingHashHex: request.capabilityCeilingHashHex,
          nativeProjectionHashHex: request.nativeProjectionHashHex, nodeAudience: request.nodeAudience,
          ...(request.role === "policy-enforcement" ? { enforcerDid: request.audienceDid } : {}),
        };
        const signed = await signCompactUcanRootAuthorization({
          issuerDid: ownerDid, audienceDid: request.audienceDid, attenuation, facts: [facts],
          notBefore: Math.floor(request.notBefore.getTime() / 1000),
          expiresAt: Math.floor(request.expiresAt.getTime() / 1000),
          nonce: `root-${request.role}`, sign: async (bytes) => ed25519.sign(bytes, ownerSeed),
        });
        return { cid: signed.cid, delegationHeader: { Authorization: signed.authorization } };
      },
      async registerPolicy(request) {
        registered = request as unknown as Record<string, unknown>;
        const binding = {
          schema: "xyz.tinycloud.policy/attested-enforcer/v2" as const,
          enforcerDid: nodeDid, nodeAudience: nodeDid,
          attestationBindingDigestHex: Buffer.from(sha256(new TextEncoder().encode(canonicalize({ enforcerDid: nodeDid, nodeAudience: nodeDid })))).toString("hex"),
          issuedAt: new Date().toISOString(), expiresAt: request.rootExpiresAt,
        };
        const digest = sha256(new TextEncoder().encode(`xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0${canonicalize(binding)}`));
        return {
          policyCid: request.policyCid, policyRootCid: request.policyRoot.cid,
          enforcementRootCid: request.enforcementRoot.cid,
          attestedEnforcerBinding: {
            ...binding,
            signature: { suite: "Ed25519" as const, signerDid: nodeDid, value: toBase64Url(ed25519.sign(digest, nodeSeed)) },
          },
        };
      },
    },
  };
  return { input, roots, get registered() { return registered; } };
}

describe("CLI V3 email publisher", () => {
  test("publishes a signed v4 link containing the exact leaf policy and six-field credential commitment", async () => {
    const first = harness("shareone1234567890");
    const second = harness("sharetwo1234567890");
    const firstResult = await publishEmailShareV3(first.input);
    const secondResult = await publishEmailShareV3(second.input);
    expect(firstResult.url).toMatch(/^https:\/\/share\.example\/s\/full#v=4&k=/);
    expect(firstResult.link.kind).toBe("policy");
    const opened = await resolveLink(firstResult.url, {
      trustedOrigins: [first.input.shareOrigin], apiOrigin: "https://api.tinycloud.xyz",
    });
    expect(opened.form).toBe("full");
    expect(opened.header.issuer).toBe(ownerDid);
    expect(opened.header.bodyCid).toBe(firstResult.link.cid);
    const envelope = opened.value as unknown as ShareEnvelopeV3;
    expect(envelope.version).toBe(3);
    expect(await verifyEnvelopeV3(envelope, { expectedSignerDid: ownerDid })).toBe(true);
    expect(envelope.contentSource.encryptionNetwork).toBe(networkId);
    expect(envelope.contentSource.encryptionKeyPath).toBe(`share/${first.input.shareId}`);
    expect(envelope.policy.capabilityCeiling).toContainEqual({
      kind: "encryption", resource: `${networkId}/share/${first.input.shareId}`,
      action: "tinycloud.encryption/decrypt",
    });
    expect(envelope.policy.capabilityCeiling).not.toContainEqual({ kind: "encryption", resource: networkId, action: "tinycloud.encryption/decrypt" });
    expect(envelope.policy.contentSource).toEqual(envelope.contentSource);
    const requirement = createEmailCredentialRequirement({
      email: first.input.target.address,
      profile: { id: "tinycloud.email-proof/v1", version: 1 },
      credentialType: { id: "opencredentials.email/v1", version: 1 },
    });
    expect(envelope.policy.schema).toBe("xyz.tinycloud.policy/policy/v2");
    if (envelope.policy.schema !== "xyz.tinycloud.policy/policy/v2") throw new Error("missing Policy/v2");
    expect(envelope.policy.credentialRequirement).toEqual({
      type: "TinyCloudPolicyCredentialRequirement", version: 1,
      requirementDigest: await credentialRequirementDigest(requirement),
      descriptorDigest: await canonicalDigest(descriptor),
      issuerDid: first.input.issuerDid, issuerKid: first.input.issuerKid,
      profile: requirement.profile, credentialType: requirement.credentialType,
    });
    expect(first.roots).toEqual(["policy-authority", "policy-enforcement"]);
    expect(first.registered?.policyCid).toBe(firstResult.metadata.policyCid);
    expect(secondResult.deliveryMaterial?.envelope).toMatchObject({
      contentSource: { encryptionKeyPath: `share/${second.input.shareId}` },
    });
  });

  test("rejects an issuer mismatch and a non-default network before policy publication", async () => {
    const issuer = harness("sharebad1234567890");
    await expect(publishEmailShareV3({ ...issuer.input, issuerKid: "did:web:issuer.credentials.org#other" })).rejects.toThrow();
    expect(issuer.roots).toHaveLength(0);
    const network = harness("sharebadnetwork1234");
    await expect(publishEmailShareV3({ ...network.input, contentSource: { ...network.input.contentSource, encryptionNetwork: networkId.replace(/:default$/, ":share") } })).rejects.toThrow("email share binding is invalid");
    expect(network.roots).toHaveLength(0);
  });
});
