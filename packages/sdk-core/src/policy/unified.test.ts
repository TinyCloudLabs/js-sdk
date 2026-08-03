import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import {
  contentSourceDigestHex,
  compactAttenuationContains,
  createCompactPolicyDescendant,
  createCompactPolicyInvocation,
  jcsCanonicalize,
  mintPolicySessionV3,
  normalizeUnifiedPolicyCapability,
  parsePolicySessionUcan,
  parseCompactUcanAuthorization,
  policyDigestHex,
  policyIdForDigestHex,
  ROOT_STATUS_V1_DOMAIN,
  projectUnifiedPolicyCapability,
  unifiedNativeProjectionHashHex,
  unifiedPolicyCapabilityContains,
  unifiedPolicyCapabilityDigestHex,
  unifiedPolicyCapabilityFromNative,
  verifyPolicyRootStatusCheckpointV3,
  verifyPolicyRootRevocationV3,
} from "./index";

const kv = {
  kind: "kv" as const,
  resource: "tinycloud://space/kv/docs/a",
  selector: "exact" as const,
  actions: ["tinycloud.kv/put", "tinycloud.kv/get"] as const,
};

describe("TC-405 unified policy contracts", () => {
  test("matches the Rust canonicalization and content-source vectors", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/canonicalization.json`,
    ).json()) as any;
    expect(jcsCanonicalize(normalizeUnifiedPolicyCapability(kv))).toBe(
      Buffer.from(vector.vectors[0].canonicalJcsUtf8Hex, "hex").toString(
        "utf8",
      ),
    );
    expect(unifiedPolicyCapabilityDigestHex(kv)).toBe(
      vector.vectors[0].policyCapabilityDigestHex,
    );
    expect(contentSourceDigestHex(vector.contentSource)).toBe(
      vector.contentSourceDigestHex,
    );
  });

  test("projects KV selector caveats and exact encryption resources", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/projection.json`,
    ).json()) as any;
    const projected = projectUnifiedPolicyCapability(
      vector.vectors[0].policyCapability,
    );
    expect(projected).toEqual(vector.vectors[0].nativeCapability);
    expect(
      unifiedNativeProjectionHashHex([vector.vectors[0].policyCapability]),
    ).toBe(vector.vectors[0].nativeProjectionHashHex);
    expect(unifiedPolicyCapabilityFromNative(projected)).toEqual(
      vector.vectors[0].policyCapability,
    );
    expect(
      unifiedPolicyCapabilityContains(
        vector.vectors[1].authorized,
        vector.vectors[1].requested,
      ),
    ).toBe(true);
    expect(
      unifiedPolicyCapabilityContains(
        vector.vectors[2].authorized,
        vector.vectors[2].requested,
      ),
    ).toBe(false);
    expect(
      unifiedPolicyCapabilityContains(
        vector.vectors[3].authorized,
        vector.vectors[3].requested,
      ),
    ).toBe(false);
  });

  test("uses one segment-bounded selector containment rule for descendants", () => {
    const root = "tinycloud://space/kv/shares/root";
    const caveat = (kind: "exact" | "prefix", value: string) => [{
      type: "xyz.tinycloud.resource/selector",
      kind,
      value,
    }];
    const parent = { [root]: { "tinycloud.kv/get": caveat("prefix", root) } };
    expect(compactAttenuationContains(parent, {
      [root]: { "tinycloud.kv/get": caveat("exact", root) },
    })).toBe(true);
    expect(compactAttenuationContains(parent, {
      [`${root}/folder/document.txt`]: { "tinycloud.kv/get": caveat("exact", `${root}/folder/document.txt`) },
    })).toBe(true);
    expect(compactAttenuationContains(parent, {
      [`${root}-sibling`]: { "tinycloud.kv/get": caveat("exact", `${root}-sibling`) },
    })).toBe(false);
    expect(compactAttenuationContains(parent, {
      [`${root}/folder`]: { "tinycloud.kv/put": caveat("exact", `${root}/folder`) },
    })).toBe(false);
  });

  test("verifies current root checkpoints before lifecycle clients trust them", () => {
    const privateKey = new Uint8Array(32).fill(23);
    const publicKey = ed25519.getPublicKey(privateKey);
    const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
    const unsigned = {
      schema: "xyz.tinycloud.policy/root-status/v1",
      targetCid: "bafy-root",
      targetRole: "policy-authority",
      ownerDid: "did:key:zOwner",
      nodeAudience: nodeDid,
      state: "active",
      sequence: 1,
      checkedAt: "2026-07-31T00:00:00Z",
      freshUntil: "2026-07-31T00:05:00Z",
      issuerDid: nodeDid,
    };
    const signature = ed25519.sign(sha256(new TextEncoder().encode(`${ROOT_STATUS_V1_DOMAIN}${jcsCanonicalize(unsigned)}`)), privateKey);
    const checkpoint = { ...unsigned, signature: { suite: "Ed25519", signerDid: nodeDid, value: Buffer.from(signature).toString("base64url") } };
    const now = new Date("2026-07-31T00:01:00Z");
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-root", checkpoint, expectedNodeAudience: nodeDid, now })).toBe(true);
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-other", checkpoint, expectedNodeAudience: nodeDid, now })).toBe(false);
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-root", checkpoint: { ...checkpoint, sequence: 2 }, expectedNodeAudience: nodeDid, now })).toBe(false);
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-root", checkpoint, expectedNodeAudience: nodeDid, now: new Date("2026-07-31T00:06:00Z") })).toBe(false);
  });

  test("binds mint responses to the exact ordered roots and requested attenuation", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const input = {
      nodeOrigin: "https://node.example",
      policyCid: vector.policy.policyCid as string,
      policyRootCid: vector.policyRoot.cid as string,
      enforcementRootCid: vector.enforcementRoot.cid as string,
      recipientDid: vector.principals.recipientDid as string,
      requestedCapabilities: vector.policy.value.capabilityCeiling,
      claim: {},
      presentation: {},
      challenge: { challengeId: "challenge-405", nonce: "session-405", policyCid: vector.policy.policyCid, recipientDid: vector.principals.recipientDid },
      fetch: (async () => new Response(JSON.stringify({ admitted: true, sessionCid: vector.s0.cid, authorization: vector.s0.authorization }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    };
    await expect(mintPolicySessionV3(input)).resolves.toMatchObject({ cid: vector.s0.cid });
    await expect(mintPolicySessionV3({ ...input, policyRootCid: vector.enforcementRoot.cid, enforcementRootCid: vector.policyRoot.cid })).rejects.toThrow("ordered proofs");
    await expect(mintPolicySessionV3({ ...input, requestedCapabilities: vector.policy.value.capabilityCeiling.slice(0, 1) })).rejects.toThrow("signed binding");
  });

  test("verifies the exact revocation referenced by a revoked checkpoint", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const revocation = vector.revocation.value as Record<string, unknown>;
    const checkpoint = {
      targetRole: revocation.targetRole,
      ownerDid: revocation.ownerDid,
      nodeAudience: revocation.nodeAudience,
      revokedAt: revocation.revokedAt,
      revocationCid: vector.revocation.signatureDigestHex,
    };
    expect(verifyPolicyRootRevocationV3({ rootCid: revocation.targetCid as string, checkpoint, revocation, expectedEnforcerDid: vector.principals.enforcerDid })).toBe(true);
    expect(verifyPolicyRootRevocationV3({ rootCid: revocation.targetCid as string, checkpoint, revocation: { ...revocation, reason: "substituted" }, expectedEnforcerDid: vector.principals.enforcerDid })).toBe(false);
  });

  test("derives policy IDs from the additive v1 digest", () => {
    const unsigned = {
      schema: "xyz.tinycloud.policy/policy/v1" as const,
      ownerDid: "did:key:zowner",
      createdAt: "2026-07-31T00:00:00Z",
      contentSource: {
        shareId: "share-1",
        kvResource: "tinycloud://space/kv/docs/a",
        selector: "exact" as const,
        encryptionNetwork: "urn:tinycloud:encryption:did:key:zowner:default",
        encryptedSymmetricKeyDigestHex: "a".repeat(64),
        keyVersion: 1,
        mode: "immutable" as const,
        initialCiphertextDigestHex: "b".repeat(64),
      },
      capabilityCeiling: [kv],
    };
    const digest = policyDigestHex(unsigned);
    expect(policyIdForDigestHex(digest)).toBe(
      "pol_cj523vzxd2ly7y6utaqgmc6e6xj5rwnlyvlrcjdouasgp6fkc5jq",
    );
  });

  test("verifies exact compact Authorization bytes, ordered proofs, signature, and CID", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const session = parsePolicySessionUcan(vector.s0.authorization, [
      vector.policyRoot.cid,
      vector.enforcementRoot.cid,
    ]);
    expect(session.cid).toBe(vector.s0.cid);
    expect(session.prf).toEqual([vector.policyRoot.cid, vector.enforcementRoot.cid]);
    expect(session.fact.contentSourceDigestHex).toBe(
      vector.projections.contentSourceDigestHex,
    );
    expect(() =>
      parsePolicySessionUcan(vector.s0.authorization, [
        vector.enforcementRoot.cid,
        vector.policyRoot.cid,
      ]),
    ).toThrow();
    const mutated = `${vector.s0.authorization.slice(0, -1)}${vector.s0.authorization.endsWith("A") ? "B" : "A"}`;
    expect(() => parsePolicySessionUcan(mutated)).toThrow();

    const s1 = parseCompactUcanAuthorization(vector.s1.authorization);
    const descendant = createCompactPolicyDescendant({
      parentAuthorization: vector.s0.authorization,
      parentCid: vector.s0.cid,
      issuerDid: vector.principals.recipientDid,
      audienceDid: s1.payload.aud,
      attenuation: s1.payload.att,
      privateKey: new Uint8Array(32).fill(9),
      now: s1.payload.nbf,
      expiresAt: s1.payload.exp,
      nonce: s1.payload.nnc,
    });
    expect(descendant.authorization).toBe(vector.s1.authorization);
    expect(descendant.cid).toBe(vector.s1.cid);

    const invocation = createCompactPolicyInvocation({
      sessionAuthorization: vector.s0.authorization,
      sessionCid: vector.s0.cid,
      recipientDid: vector.principals.recipientDid,
      audienceDid: vector.principals.nodeDid,
      resource: vector.policy.value.contentSource.kvResource,
      action: "tinycloud.kv/get",
      caveat: { type: "xyz.tinycloud.resource/selector", kind: "exact", value: vector.policy.value.contentSource.kvResource },
      privateKey: new Uint8Array(32).fill(9),
      now: session.nbf + 1,
      nonce: "fresh-invocation-405",
    });
    expect(invocation.payload.prf).toEqual([vector.s0.cid]);
    expect(invocation.authorization).not.toBe(vector.s0.authorization);
  });
});
