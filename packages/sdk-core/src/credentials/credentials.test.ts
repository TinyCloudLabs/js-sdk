import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalDigest, encodeBase64Url, sha256Base64Url } from "./digest";
import { CredentialError } from "./errors";
import { validateCredentialFlowDescriptor } from "./descriptor";
import { verifyIssuedCredential } from "./verification";
import type { CredentialFlowDescriptor, CredentialIssuerMetadata, CredentialRequirement, IssuedCredentialEnvelope } from "./types";

const HOLDER = "did:key:z6MkActiveSessionHolder";
const ISSUER = "did:web:issuer.credentials.test";
const ORIGIN = "https://issuer.credentials.test";
const KID = `${ISSUER}#key-1`;

function descriptor(profile = "tinycloud.dev.synthetic-handle", credentialType = "opencredentials.synthetic-handle", steps: CredentialFlowDescriptor["steps"] = [
  { id: "handle", type: "collect_input", version: 1, endpoint: "submit_proof", title: "Choose handle", description: "Enter a handle" },
  { id: "bind", type: "holder_signature", version: 1, endpoint: "holder_binding", title: "Bind holder", description: "Sign the exact request" },
]): CredentialFlowDescriptor {
  return {
    type: "OpenCredentialsFlowDescriptor", protocol: "tinycloud.credentials/acquisition/v1", version: 1, stepRegistryVersion: 1,
    profile: { id: profile, version: 1 }, issuer: { origin: ORIGIN, did: ISSUER }, credential: { type: credentialType, version: 1, schema: `urn:${credentialType}:v1`, format: "vc+sd-jwt" },
    claims: [{ id: "handle", matching: "exact", required: true }], inputs: [{ id: "handle", label: "Handle", required: true, prefill: "allowed", schema: { type: "string", minLength: 2, maxLength: 32, pattern: "^[a-z0-9-]+$" }, accessibility: { label: "Handle", description: "Public handle" } }], steps,
    holderBinding: { required: true, domain: "tinycloud.credentials/holder-binding/v1", version: 1 },
    endpoints: { create_request: "create_request", request_state: "request_state", create_challenge: "create_challenge", submit_proof: "submit_proof", holder_binding: "holder_binding", submit_holder_signature: "submit_holder_signature", issue: "issue", result: "result", issuer_metadata: "issuer_metadata", credential_status: "credential_status", interaction: "interaction" },
    ttlSeconds: 600, freshnessSeconds: 3600, presentation: { title: "Prove a handle", description: "Acquire a holder-bound handle", consent: "Issue this credential", progressLabel: "Working", successLabel: "Saved", recoveryLabel: "Try again" },
  };
}

describe("credential descriptor protocol", () => {
  test("accepts email and synthetic profiles through the same finite vocabulary", () => {
    const synthetic = validateCredentialFlowDescriptor(descriptor());
    const email = validateCredentialFlowDescriptor(descriptor("tinycloud.email-proof", "opencredentials.email", [
      { id: "address", type: "collect_input", version: 1, endpoint: "submit_proof", title: "Email", description: "Enter email" },
      { id: "otp", type: "mailbox_otp", version: 1, endpoint: "submit_proof", title: "Code", description: "Enter code" },
      { id: "bind", type: "holder_signature", version: 1, endpoint: "holder_binding", title: "Bind", description: "Sign" },
    ]));
    expect(synthetic.steps.map((step) => step.type)).toEqual(["collect_input", "holder_signature"]);
    expect(email.steps.map((step) => step.type)).toEqual(["collect_input", "mailbox_otp", "holder_signature"]);
  });

  test("fails closed on unknown step and profile versions with a typed error", () => {
    const unknownStep = structuredClone(descriptor()) as any; unknownStep.steps[0].type = "execute_script";
    expect(() => validateCredentialFlowDescriptor(unknownStep)).toThrow(CredentialError);
    try { validateCredentialFlowDescriptor(unknownStep); } catch (error) { expect((error as CredentialError).code).toBe("UNSUPPORTED_PROFILE"); }
    const unknownVersion = structuredClone(descriptor()) as any; unknownVersion.profile.version = 2;
    try { validateCredentialFlowDescriptor(unknownVersion); } catch (error) { expect((error as CredentialError).code).toBe("UNSUPPORTED_PROFILE"); }
  });
});

test("independently verifies EdDSA SD-JWT signature, disclosures, holder, versions, validity and status", async () => {
  const flow = validateCredentialFlowDescriptor(descriptor()); const descriptorDigest = await canonicalDigest(flow);
  const requirement: CredentialRequirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: flow.profile, credentialType: { id: flow.credential.type, version: 1 }, claims: { handle: "alice" } };
  const claims = { handle: "alice" }; const claimsDigest = await canonicalDigest(claims);
  const disclosure = encodeBase64Url(new TextEncoder().encode(JSON.stringify(["fixed-salt", "handle", "alice"])));
  const now = new Date("2030-01-01T00:00:00.000Z");
  const payload = { protocol: flow.protocol, profile: flow.profile, credential_type: requirement.credentialType, schema: flow.credential.schema, iss: ISSUER, sub: HOLDER, holder: HOLDER, descriptor_digest: descriptorDigest, claims_digest: claimsDigest, jti: "credential-123", status: { method: "issuer", reference: "urn:opencredentials:status:abcdefghijklmnop" }, iat: Math.floor(now.getTime() / 1000) - 10, nbf: Math.floor(now.getTime() / 1000) - 10, exp: Math.floor(now.getTime() / 1000) + 600, _sd_alg: "sha-256", _sd: [await sha256Base64Url(disclosure)] };
  const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1); const publicKey = ed25519.getPublicKey(seed);
  const headerPart = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "vc+sd-jwt", kid: KID })));
  const payloadPart = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerPart}.${payloadPart}`; const jwt = `${signingInput}.${encodeBase64Url(ed25519.sign(new TextEncoder().encode(signingInput), seed))}~${disclosure}~`;
  const envelope: IssuedCredentialEnvelope = { type: "OpenCredentialsIssuedCredential", version: 1, protocol: flow.protocol, profile: flow.profile, credentialType: requirement.credentialType, schema: flow.credential.schema, format: "vc+sd-jwt", issuerDid: ISSUER, issuerKid: KID, subjectDid: HOLDER, holderDid: HOLDER, claims, claimsDigest, descriptorDigest, credentialId: "credential-123", issuedAt: new Date(payload.iat * 1000).toISOString(), notBefore: new Date(payload.nbf * 1000).toISOString(), expiresAt: new Date(payload.exp * 1000).toISOString(), status: payload.status as IssuedCredentialEnvelope["status"], credential: jwt };
  const metadata: CredentialIssuerMetadata = { type: "OpenCredentialsIssuerMetadata", version: 1, origin: ORIGIN, issuerDid: ISSUER, keys: [{ kid: KID, alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: encodeBase64Url(publicKey) }, validFrom: "2029-01-01T00:00:00.000Z", validUntil: "2031-01-01T00:00:00.000Z" }], cache: { maxAgeSeconds: 300, etag: '"key-1"' } };
  const verified = await verifyIssuedCredential({ envelope, descriptor: flow, descriptorDigest, requirement, holderDid: HOLDER, issuerMetadata: metadata, now, checkStatus: async () => true });
  expect(verified.holderDid).toBe(HOLDER); expect(verified.claims).toEqual(claims); expect(verified.credentialDigest).toHaveLength(43);
  await expect(verifyIssuedCredential({ envelope: { ...envelope, holderDid: "did:key:other" }, descriptor: flow, descriptorDigest, requirement, holderDid: HOLDER, issuerMetadata: metadata, now, checkStatus: async () => true })).rejects.toMatchObject({ code: "HOLDER_MISMATCH" });
  await expect(verifyIssuedCredential({ envelope, descriptor: flow, descriptorDigest, requirement, holderDid: HOLDER, issuerMetadata: { ...metadata, keys: [{ ...metadata.keys[0]!, retiredAt: "2029-12-01T00:00:00.000Z" }] }, now, checkStatus: async () => true })).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
});
