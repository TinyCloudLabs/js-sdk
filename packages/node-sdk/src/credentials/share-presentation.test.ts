import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import {
  issuedCredentialEnvelopeFromVerified,
  jcsCanonicalize,
  policyCidFromCanonicalBytes,
  policyIdForDigestHex,
  policyV2DigestHex,
  POLICY_V2_SCHEMA,
  sha256Base64Url,
  signPolicyCredentialPresentationV4,
  type CredentialRequirement,
  type UnsignedPolicyCredentialPresentationV4,
  type UnsignedUnifiedPolicyV2,
  type UnifiedPolicyV2,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import { createEd25519HolderSigner, type EmailProofResult, type HolderSigner } from "./email-proof";
import {
  buildSharePresentation,
  SharePresentationError,
  type BuildSharePresentationInput,
  type SharePresentationChallenge,
} from "./share-presentation";

// Shared fixtures from sdk-core: the golden V4 presentation and the credential requirement vector.
const golden = (await Bun.file(
  `${import.meta.dir}/../../../sdk-core/test-vectors/policy-presentation-v4.json`,
).json()) as {
  holderDid: string;
  holderSeedBase64Url: string;
  unsigned: UnsignedPolicyCredentialPresentationV4;
  signatureBase64Url: string;
};
const requirementVector = (await Bun.file(
  `${import.meta.dir}/../../../sdk-core/test-fixtures/policy-engine-vectors/unified-policy/credential-requirement.json`,
).json()) as {
  sdkRequirement: CredentialRequirement;
  policyProjection: UnifiedPolicyV2["credentialRequirement"];
};

const seed = Uint8Array.from(Buffer.from(golden.holderSeedBase64Url, "base64url"));
const holderDid = golden.holderDid;
const holderSign = async (bytes: Uint8Array) => ed25519.sign(bytes, seed);
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const soon = () => new Date(Date.now() + 30_000).toISOString();

const capability = {
  kind: "kv" as const,
  resource: "tinycloud://space/kv/docs/a",
  selector: "exact" as const,
  actions: ["tinycloud.kv/get"] as const,
};

/** Policy/v2 with a valid policyId for the given unsigned body. */
function policyFor(unsigned: UnsignedUnifiedPolicyV2): UnifiedPolicyV2 {
  return {
    ...unsigned,
    policyId: policyIdForDigestHex(policyV2DigestHex(unsigned)),
    signature: { suite: "Ed25519", signerDid: unsigned.ownerDid, value: "signature" },
  };
}

function cidOf(value: unknown): string {
  return policyCidFromCanonicalBytes(new TextEncoder().encode(jcsCanonicalize(value)));
}

interface Fixture {
  readonly input: BuildSharePresentationInput;
  readonly policy: UnifiedPolicyV2;
  readonly policyCid: string;
  readonly result: EmailProofResult;
  readonly challenge: SharePresentationChallenge;
  readonly holderSigner: HolderSigner;
}

async function fixture(): Promise<Fixture> {
  const unsigned: UnsignedUnifiedPolicyV2 = {
    schema: POLICY_V2_SCHEMA,
    ownerDid: "did:key:zOwner",
    createdAt: "2026-10-04T00:00:00Z",
    contentSource: {
      shareId: "share",
      kvResource: capability.resource,
      selector: "exact",
      encryptionNetwork: "urn:tinycloud:encryption:did:key:zOwner:default",
      encryptedSymmetricKeyDigestHex: "a".repeat(64),
      keyVersion: 1,
      mode: "immutable",
    },
    capabilityCeiling: [capability],
    credentialRequirement: requirementVector.policyProjection,
  };
  const policy = policyFor(unsigned);
  const policyCid = cidOf(policy);
  const credentialText = "header.payload.signature";
  const verified: VerifiedCredential = {
    type: "OpenCredentialsIssuedCredential",
    version: 1,
    protocol: "tinycloud.credentials/acquisition/v1",
    format: "vc+sd-jwt",
    profile: requirementVector.policyProjection.profile,
    credentialType: requirementVector.policyProjection.credentialType,
    schema: "test",
    issuerDid: requirementVector.policyProjection.issuerDid,
    issuerKid: requirementVector.policyProjection.issuerKid,
    subjectDid: holderDid,
    holderDid,
    claims: { email: "alice@example.test" },
    claimsDigest: requirementVector.policyProjection.requirementDigest,
    descriptorDigest: requirementVector.policyProjection.descriptorDigest,
    credentialId: "credential",
    issuedAt: "2026-10-04T00:00:00Z",
    notBefore: "2026-10-04T00:00:00Z",
    expiresAt: future(),
    status: { method: "none", freshnessSeconds: 3600 },
    credential: credentialText,
    credentialDigest: await sha256Base64Url(credentialText),
    verifiedAt: "2026-10-04T00:00:00Z",
    statusCheckedAt: "2026-10-04T00:00:00Z",
  };
  const result: EmailProofResult = {
    envelope: issuedCredentialEnvelopeFromVerified(verified),
    verified,
    credentialId: "credential",
    issuedAt: verified.issuedAt,
    expiresAt: verified.expiresAt,
  };
  const challenge: SharePresentationChallenge = {
    challengeId: "challenge-id-0000001",
    nonce: "nonce-0000000000000001",
    policyCid,
    recipientDid: holderDid,
    nodeAudience: "did:key:zNode",
    action: "tinycloud.kv/get",
    expiresAt: soon(),
  };
  const holderSigner = createEd25519HolderSigner(holderDid, holderSign);
  return {
    policy,
    policyCid,
    result,
    challenge,
    holderSigner,
    input: {
      holderSigner,
      result,
      requirement: requirementVector.sdkRequirement,
      challenge,
      policy,
      expectedNodeAudience: "did:key:zNode",
      expectedAction: "tinycloud.kv/get",
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<SharePresentationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SharePresentationError);
  return error as SharePresentationError;
}

/** Holder signer that counts calls, to prove a rejection happens before any signing. */
function countingSigner(f: Fixture): { holderSigner: HolderSigner; calls: { n: number } } {
  const calls = { n: 0 };
  const holderSigner: HolderSigner = {
    ...f.holderSigner,
    sign: async (bytes) => {
      calls.n += 1;
      return holderSign(bytes);
    },
  };
  return { holderSigner, calls };
}

describe("buildSharePresentation golden and differential", () => {
  test("the sdk-core primitive reproduces the golden V4 signature for the shared vector", async () => {
    const signed = await signPolicyCredentialPresentationV4(golden.unsigned, holderSign);
    expect(signed.signature.value).toBe(golden.signatureBase64Url);
    expect(signed.signature.signerDid).toBe(holderDid);
  });

  test("output presentation carries the bound challenge, policy, requirement, and credential digests", async () => {
    const f = await fixture();
    const material = await buildSharePresentation(f.input);
    const p = material.presentation;
    expect(p.schema).toBe("xyz.tinycloud.policy/presentation/v4");
    expect(p.challengeId).toBe(f.challenge.challengeId);
    expect(p.nonce).toBe(f.challenge.nonce);
    expect(p.policyCid).toBe(f.policyCid);
    expect(p.nodeAudience).toBe(f.challenge.nodeAudience);
    expect(p.holderDid).toBe(holderDid);
    expect(p.subjectDid).toBe(holderDid);
    expect(p.credentialDigest).toBe(f.result.verified.credentialDigest);
    expect(p.requirementDigest).toBe(f.policy.credentialRequirement.requirementDigest);
    expect(p.descriptorDigest).toBe(f.policy.credentialRequirement.descriptorDigest);
    expect(p.requestedCapabilities).toEqual(f.policy.capabilityCeiling);
    expect(p.signature.signerDid).toBe(holderDid);
  });

  test("material exposes the credential string, digest, envelope, and requirement unchanged", async () => {
    const f = await fixture();
    const material = await buildSharePresentation(f.input);
    expect(material.holderDid).toBe(holderDid);
    expect(material.credential).toBe(f.result.envelope.credential);
    expect(material.credentialDigest).toBe(await sha256Base64Url(material.credential));
    expect(material.credential).toBe(f.result.verified.credential);
    expect(material.credentialDigest).toBe(f.result.verified.credentialDigest);
    expect(material.credentialEnvelope).toBe(f.result.envelope);
    expect(material.requirement).toBe(requirementVector.sdkRequirement);
  });

  test("differential: stripping the signature and re-signing with the sdk-core primitive yields the same signature", async () => {
    const f = await fixture();
    const material = await buildSharePresentation(f.input);
    const { signature, ...unsigned } = material.presentation;
    const resigned = await signPolicyCredentialPresentationV4(unsigned, holderSign);
    expect(resigned.signature.value).toBe(signature.value);
    expect(resigned.signature.signerDid).toBe(signature.signerDid);
  });

  test("the holder signer receives exactly the 32-byte V4 digest", async () => {
    const f = await fixture();
    const seen: number[] = [];
    const recording: HolderSigner = {
      ...f.holderSigner,
      sign: async (bytes) => {
        seen.push(bytes.length);
        return holderSign(bytes);
      },
    };
    await buildSharePresentation({ ...f.input, holderSigner: recording });
    expect(seen).toEqual([32]);
  });

  test("material.sign is a raw holder signature over exactly the bytes given", async () => {
    const f = await fixture();
    const material = await buildSharePresentation(f.input);
    const publicKey = ed25519.getPublicKey(seed);
    const digest = Uint8Array.from({ length: 32 }, (_, i) => i);
    const binding = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
    expect(typeof material.sign).toBe("function");
    expect(ed25519.verify(await material.sign(digest), digest, publicKey)).toBe(true);
    const bindingSig = await material.sign(binding);
    expect(ed25519.verify(bindingSig, binding, publicKey)).toBe(true);
    expect(ed25519.verify(bindingSig, digest, publicKey)).toBe(false);
  });

  test("material never serialises or inspects the holder seed", async () => {
    const f = await fixture();
    const material = await buildSharePresentation(f.input);
    expect(JSON.stringify(material)).not.toContain(golden.holderSeedBase64Url);
    expect(Bun.inspect(material)).not.toContain(golden.holderSeedBase64Url);
    expect(Object.keys(material)).not.toContain("holderSigner");
  });
});

describe("buildSharePresentation fail-closed rejections (one per code)", () => {
  test("CHALLENGE_EXPIRED when the challenge expiry is in the past", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, expiresAt: new Date(Date.now() - 1000).toISOString() },
    }));
    expect(error.code).toBe("CHALLENGE_EXPIRED");
  });

  test("RECIPIENT_MISMATCH when the challenge recipient is not the credential holder", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, recipientDid: "did:key:zAttacker" },
    }));
    expect(error.code).toBe("RECIPIENT_MISMATCH");
  });

  test("HOLDER_MISMATCH when the holder signer DID differs from the credential holder", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner: { ...f.holderSigner, did: "did:key:zOtherHolder" },
    }));
    expect(error.code).toBe("HOLDER_MISMATCH");
  });

  test("CREDENTIAL_MISMATCH when the envelope credential is not the verified credential", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      result: { ...f.result, envelope: { ...f.result.envelope, credential: "other.payload.sig" } },
    }));
    expect(error.code).toBe("CREDENTIAL_MISMATCH");
  });

  test("POLICY_INVALID when the policy fails Policy/v2 validation", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      policy: { ...f.policy, schema: "xyz.tinycloud.policy/v0" },
    }));
    expect(error.code).toBe("POLICY_INVALID");
  });

  test("POLICY_CID_MISMATCH when the policy does not hash to the challenge policy CID", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, policyCid: cidOf({ other: true }) },
    }));
    expect(error.code).toBe("POLICY_CID_MISMATCH");
  });

  test("REQUIREMENT_MISMATCH when the requirement digest differs from the policy commitment", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      requirement: { ...requirementVector.sdkRequirement, claims: { email: "mallory@example.test" } } as CredentialRequirement,
    }));
    expect(error.code).toBe("REQUIREMENT_MISMATCH");
  });

  test("REQUIREMENT_MISMATCH when the requirement is malformed and cannot be digested", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      requirement: {} as CredentialRequirement,
    }));
    expect(error.code).toBe("REQUIREMENT_MISMATCH");
  });

  test("CHALLENGE_AUDIENCE_MISMATCH when the relay names a node other than the expected audience; nothing is signed", async () => {
    const f = await fixture();
    const { holderSigner, calls } = countingSigner(f);
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner,
      challenge: { ...f.challenge, nodeAudience: "did:key:zRelay" },
    }));
    expect(error.code).toBe("CHALLENGE_AUDIENCE_MISMATCH");
    expect(calls.n).toBe(0);
  });

  test("CHALLENGE_AUDIENCE_MISMATCH when the expected audience is empty, even if the challenge audience is also empty", async () => {
    const f = await fixture();
    const { holderSigner, calls } = countingSigner(f);
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner,
      expectedNodeAudience: "",
      challenge: { ...f.challenge, nodeAudience: "" },
    }));
    expect(error.code).toBe("CHALLENGE_AUDIENCE_MISMATCH");
    expect(calls.n).toBe(0);
  });

  test("CHALLENGE_AUDIENCE_MISMATCH when expectedNodeAudience is missing at runtime", async () => {
    const f = await fixture();
    const { holderSigner, calls } = countingSigner(f);
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner,
      expectedNodeAudience: undefined as unknown as string,
    }));
    expect(error.code).toBe("CHALLENGE_AUDIENCE_MISMATCH");
    expect(calls.n).toBe(0);
  });

  test("CHALLENGE_ACTION_MISMATCH when the relay names a different action; nothing is signed", async () => {
    const f = await fixture();
    const { holderSigner, calls } = countingSigner(f);
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner,
      challenge: { ...f.challenge, action: "tinycloud.kv/put" },
    }));
    expect(error.code).toBe("CHALLENGE_ACTION_MISMATCH");
    expect(calls.n).toBe(0);
  });

  test("CHALLENGE_ACTION_MISMATCH when the challenge carries no action", async () => {
    const f = await fixture();
    const { holderSigner, calls } = countingSigner(f);
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner,
      challenge: { ...f.challenge, action: undefined as unknown as string },
    }));
    expect(error.code).toBe("CHALLENGE_ACTION_MISMATCH");
    expect(calls.n).toBe(0);
  });

  test("CHALLENGE_ACTION_MISMATCH when expectedAction is missing at runtime", async () => {
    const f = await fixture();
    const { holderSigner, calls } = countingSigner(f);
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner,
      expectedAction: undefined as unknown as string,
    }));
    expect(error.code).toBe("CHALLENGE_ACTION_MISMATCH");
    expect(calls.n).toBe(0);
  });

  test("expectedNodeAudience and expectedAction are required by the type (checked by tsc, not by runtime)", () => {
    const withoutAudience = (f: Fixture) => {
      const rest: Omit<BuildSharePresentationInput, "expectedNodeAudience"> = f.input;
      // @ts-expect-error expectedNodeAudience is required
      return buildSharePresentation(rest);
    };
    const withoutAction = (f: Fixture) => {
      const rest: Omit<BuildSharePresentationInput, "expectedAction"> = f.input;
      // @ts-expect-error expectedAction is required
      return buildSharePresentation(rest);
    };
    expect(typeof withoutAudience).toBe("function");
    expect(typeof withoutAction).toBe("function");
  });

  test("CHALLENGE_WINDOW_TOO_LONG when the challenge expires 61 s out; nothing is signed", async () => {
    const f = await fixture();
    const { holderSigner, calls } = countingSigner(f);
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      holderSigner,
      challenge: { ...f.challenge, expiresAt: new Date(Date.now() + 61_000).toISOString() },
    }));
    expect(error.code).toBe("CHALLENGE_WINDOW_TOO_LONG");
    expect(calls.n).toBe(0);
  });

  test("a challenge expiring 59 s out is accepted and its challengeId is bound", async () => {
    const f = await fixture();
    const material = await buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, expiresAt: new Date(Date.now() + 59_000).toISOString() },
    });
    expect(material.presentation.challengeId).toBe(f.challenge.challengeId);
  });

  test("CHALLENGE_IDENTIFIER_INVALID when challengeId or nonce is empty or under 16 characters; nothing is signed", async () => {
    const f = await fixture();
    const variants: SharePresentationChallenge[] = [
      { ...f.challenge, challengeId: "short-id" },
      { ...f.challenge, nonce: "short" },
      { ...f.challenge, nonce: "" },
    ];
    for (const challenge of variants) {
      const { holderSigner, calls } = countingSigner(f);
      const error = await rejectionOf(buildSharePresentation({ ...f.input, holderSigner, challenge }));
      expect(error.code).toBe("CHALLENGE_IDENTIFIER_INVALID");
      expect(calls.n).toBe(0);
    }
  });

  test("challengeId and nonce of exactly 16 characters are accepted and bound into the presentation", async () => {
    const f = await fixture();
    const material = await buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, challengeId: "0123456789abcdef", nonce: "fedcba9876543210" },
    });
    expect(material.presentation.challengeId).toBe("0123456789abcdef");
    expect(material.presentation.nonce).toBe("fedcba9876543210");
  });
});

describe("buildSharePresentation malicious-relay set", () => {
  test("relay swaps the policy for a widened policy with a valid policyId: rejected at CID binding", async () => {
    const f = await fixture();
    const widenedUnsigned: UnsignedUnifiedPolicyV2 = {
      ...f.policy,
      capabilityCeiling: [{ ...capability, resource: "tinycloud://space/kv/docs/secret" }],
    };
    const { policyId: _p, signature: _s, ...unsigned } = widenedUnsigned as UnifiedPolicyV2;
    const widened = policyFor(unsigned);
    const error = await rejectionOf(buildSharePresentation({ ...f.input, policy: widened }));
    expect(error.code).toBe("POLICY_CID_MISMATCH");
  });

  test("relay returns a challenge whose recipient is the relay's own DID", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, recipientDid: "did:key:zRelay" },
    }));
    expect(error.code).toBe("RECIPIENT_MISMATCH");
  });

  test("relay returns a challenge that is already expired", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, expiresAt: "2001-01-01T00:00:00Z" },
    }));
    expect(error.code).toBe("CHALLENGE_EXPIRED");
  });

  test("relay returns a challenge with an unparseable expiry: fails closed as expired", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      challenge: { ...f.challenge, expiresAt: "not-a-date" },
    }));
    expect(error.code).toBe("CHALLENGE_EXPIRED");
  });

  test("tampered verified credential digest is rejected by the builder", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({
      ...f.input,
      result: { ...f.result, verified: { ...f.result.verified, credentialDigest: "A".repeat(43) } },
    }));
    expect(error.code).toBe("PRESENTATION_REJECTED");
  });

  test("a policy with a null body is POLICY_INVALID, not a thrown TypeError", async () => {
    const f = await fixture();
    const error = await rejectionOf(buildSharePresentation({ ...f.input, policy: null }));
    expect(error.code).toBe("POLICY_INVALID");
  });
});

describe("buildSharePresentation redaction", () => {
  test("typed error messages never contain DIDs, the credential, or the claim email", async () => {
    const f = await fixture();
    const cases: Array<() => Promise<unknown>> = [
      () => buildSharePresentation({ ...f.input, challenge: { ...f.challenge, recipientDid: "did:key:zAttacker" } }),
      () => buildSharePresentation({ ...f.input, holderSigner: { ...f.holderSigner, did: "did:key:zOtherHolder" } }),
      () => buildSharePresentation({ ...f.input, challenge: { ...f.challenge, nodeAudience: "" } }),
      () => buildSharePresentation({ ...f.input, challenge: { ...f.challenge, policyCid: cidOf({ x: 1 }) } }),
    ];
    for (const run of cases) {
      const error = await rejectionOf(run());
      const text = `${error.name} ${error.code} ${error.message}`;
      for (const secret of [holderDid, "did:key:zAttacker", "did:key:zOtherHolder", f.result.verified.credential, "alice@example.test"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
