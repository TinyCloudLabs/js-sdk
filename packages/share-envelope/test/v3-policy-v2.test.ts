import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import {
  canonicalize,
  computeCid,
  didKeyFromEd25519PublicKey,
  shareEnvelopeV3Schema,
  signEnvelopeV3,
  toBase64Url,
  unifiedPolicySchema,
  verifyEnvelopeV3SignatureOnly,
} from "../src/index.js";

const POLICY_V2_DOMAIN = "xyz.tinycloud.policy/policy/v2\0";

describe("ShareEnvelopeV3 Policy/v2", () => {
  it("round-trips the frozen credential projection through production exports without weakening Policy/v1", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../sdk-core/test-fixtures/policy-engine-vectors/unified-policy/credential-requirement.json`,
    ).json()) as { policyProjection: Record<string, unknown> };
    const privateKey = new Uint8Array(32).fill(47);
    const ownerDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(privateKey));
    const contentSource = {
      shareId: "share-policy-v2",
      kvResource: "tinycloud://space-policy-v2/kv/shares/report.txt",
      selector: "exact" as const,
      encryptionNetwork: `urn:tinycloud:encryption:${ownerDid}:default`,
      encryptedSymmetricKeyDigestHex: "a".repeat(64),
      keyVersion: 1,
      mode: "immutable" as const,
      initialCiphertextDigestHex: "b".repeat(64),
    };
    const capabilityCeiling = [
      {
        kind: "kv" as const,
        resource: contentSource.kvResource,
        selector: "exact" as const,
        actions: ["tinycloud.kv/get" as const, "tinycloud.kv/metadata" as const],
      },
      {
        kind: "encryption" as const,
        resource: contentSource.encryptionNetwork,
        action: "tinycloud.encryption/decrypt" as const,
      },
    ];
    const unsignedPolicy = {
      schema: "xyz.tinycloud.policy/policy/v2" as const,
      ownerDid,
      createdAt: "2026-08-03T12:00:00Z",
      expiresAt: "2026-08-04T12:00:00Z",
      contentSource,
      capabilityCeiling,
      credentialRequirement: vector.policyProjection,
    };
    const policyDigest = sha256(new TextEncoder().encode(
      `${POLICY_V2_DOMAIN}${canonicalize(unsignedPolicy)}`,
    ));
    const policy = unifiedPolicySchema.parse({
      ...unsignedPolicy,
      policyId: `pol_${base32Lower(policyDigest)}`,
      signature: {
        suite: "Ed25519",
        signerDid: ownerDid,
        value: toBase64Url(ed25519.sign(policyDigest, privateKey)),
      },
    });
    const policyCid = await computeCid(new TextEncoder().encode(canonicalize(policy)));
    const envelope = signEnvelopeV3({
      version: 3,
      shareId: contentSource.shareId,
      recipientMatcher: { kind: "policyDigest", value: "c".repeat(43) },
      actions: ["read"],
      resource: { kind: "exact", path: "shares/report.txt" },
      target: {
        origin: "https://node.example.test",
        nodeAudience: ownerDid,
        spaceId: "space-policy-v2",
      },
      policy,
      policyCid,
      policyRoot: { cid: "policy-root", authorization: "a.b.c", role: "policy-authority" },
      enforcementRoot: { cid: "enforcement-root", authorization: "d.e.f", role: "policy-enforcement" },
      attestedEnforcerBinding: {
        schema: "xyz.tinycloud.policy/attested-enforcer/v2",
        enforcerDid: ownerDid,
        nodeAudience: ownerDid,
        attestationBindingDigestHex: "d".repeat(64),
        issuedAt: "2026-08-03T12:00:00Z",
        expiresAt: "2026-08-04T12:00:00Z",
        signature: { suite: "Ed25519", signerDid: ownerDid, value: toBase64Url(new Uint8Array(64)) },
      },
      contentSource,
      contentSourceDigestHex: "e".repeat(64),
      encryptionNetwork: contentSource.encryptionNetwork,
      expiry: "2026-08-04T12:00:00Z",
      display: { filename: "report.txt" },
      encrypted: true,
      metadata: { mediaType: "text/plain", byteLength: 12, filename: "report.txt", encoding: "utf-8" },
    }, privateKey);

    const roundTripped = shareEnvelopeV3Schema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(roundTripped.policy).toEqual(policy);
    if (roundTripped.policy.schema !== "xyz.tinycloud.policy/policy/v2") throw new Error("expected Policy/v2");
    expect(roundTripped.policy.credentialRequirement).toEqual(vector.policyProjection);
    expect(verifyEnvelopeV3SignatureOnly(roundTripped)).toBe(true);

    const { credentialRequirement: _requirement, ...v1Fields } = unsignedPolicy;
    const v1 = { ...v1Fields, schema: "xyz.tinycloud.policy/policy/v1", policyId: policy.policyId, signature: policy.signature };
    expect(unifiedPolicySchema.safeParse(v1).success).toBe(true);
    expect(unifiedPolicySchema.safeParse({ ...v1, credentialRequirement: vector.policyProjection }).success).toBe(false);
    expect(unifiedPolicySchema.safeParse({ ...policy, credentialRequirement: undefined }).success).toBe(false);
  });
});

function base32Lower(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}
