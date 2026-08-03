import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { holderBindingCanonicalBytes, holderBindingSigningBytes, validateCredentialHolderBinding } from "./binding";
import { validateCredentialFlowDescriptor } from "./descriptor";
import { canonicalDigest, encodeBase64Url, sha256Base64Url } from "./digest";
import type { CredentialFlowDescriptor, CredentialIssuerMetadata, CredentialRequirement, IssuedCredentialEnvelope } from "./types";
import { verifyIssuedCredential } from "./verification";

const fixtures = new URL("../../test-fixtures/opencredentials-v1/", import.meta.url).pathname;
const descriptors = await Bun.file(`${fixtures}/golden-descriptor-digests.json`).json() as { vectors: { name: string; descriptor: unknown; digest: string }[] };
const bindingVector = await Bun.file(`${fixtures}/golden-holder-binding.json`).json() as { binding: unknown; canonical: string; digest: string };

describe("OpenCredentials canonical contract", () => {
  test("validates both Rust-owned descriptors and reproduces their digests", async () => {
    for (const vector of descriptors.vectors) expect(await canonicalDigest(validateCredentialFlowDescriptor(vector.descriptor))).toBe(vector.digest);
  });
  test("fails closed for unknown protocol and primitive versions", () => {
    const descriptor = structuredClone(descriptors.vectors[0]!.descriptor) as any;
    descriptor.protocol = "tinycloud.credentials/acquisition/v0";
    expect(() => validateCredentialFlowDescriptor(descriptor)).toThrow();
    descriptor.protocol = "tinycloud.credentials/acquisition/v1"; descriptor.steps[0].version = 2;
    expect(() => validateCredentialFlowDescriptor(descriptor)).toThrow();
  });
  test("reproduces canonical holder-binding bytes, digest, and signing domain", async () => {
    const binding = validateCredentialHolderBinding(bindingVector.binding);
    expect(new TextDecoder().decode(holderBindingCanonicalBytes(binding))).toBe(bindingVector.canonical);
    expect(await canonicalDigest(binding)).toBe(bindingVector.digest);
    expect(new TextDecoder().decode(holderBindingSigningBytes(binding))).toBe(`tinycloud.credentials/holder-binding/v1\0${bindingVector.canonical}`);
  });
});

test("independently verifies the Rust server SD-JWT shape and rejects retired keys", async () => {
  const descriptor = validateCredentialFlowDescriptor(descriptors.vectors[1]!.descriptor) as CredentialFlowDescriptor;
  const now = new Date("2030-01-01T00:00:00.000Z"); const holderDid = "did:key:z6MkActive"; const claims = { handle: "alice" };
  const requirement: CredentialRequirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: descriptor.profile, version: 1 }, credentialType: { id: descriptor.format.vct, version: 1 }, claims };
  const descriptorDigest = await canonicalDigest(descriptor); const disclosure = encodeBase64Url(new TextEncoder().encode(JSON.stringify(["salt", "handle", "alice"])));
  const payload = { iss: descriptor.issuer.did, sub: holderDid, iat: 1893455990, nbf: 1893455990, exp: 1893456600, jti: "credential-123", vct: descriptor.format.vct, profile: descriptor.profile, profileVersion: 1, descriptorDigest, holderBinding: { did: holderDid, signingDomain: "tinycloud.credentials/holder-binding/v1" }, _sd_alg: "sha-256", _sd: [await sha256Base64Url(disclosure)] };
  const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1); const publicKey = ed25519.getPublicKey(seed);
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "vc+sd-jwt", kid: descriptor.issuer.kid }))); const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload))); const signingInput = `${header}.${body}`;
  const credential = `${signingInput}.${encodeBase64Url(ed25519.sign(new TextEncoder().encode(signingInput), seed))}~${disclosure}~`;
  const envelope: IssuedCredentialEnvelope = { type: "OpenCredentialsIssuedCredential", version: 1, protocol: descriptor.protocol, profile: { id: descriptor.profile, version: 1 }, credentialType: { id: descriptor.format.vct, version: 1 }, schema: descriptor.format.vct, format: "vc+sd-jwt", issuerDid: descriptor.issuer.did, issuerKid: descriptor.issuer.kid, subjectDid: holderDid, holderDid, claims, claimsDigest: await canonicalDigest(claims), descriptorDigest, credentialId: payload.jti, issuedAt: new Date(payload.iat * 1000).toISOString(), notBefore: new Date(payload.nbf * 1000).toISOString(), expiresAt: new Date(payload.exp * 1000).toISOString(), status: { method: "none", freshnessSeconds: 300 }, credential };
  const metadata: CredentialIssuerMetadata = { type: "OpenCredentialsIssuerMetadata", version: 1, origin: descriptor.issuer.origin, issuerDid: descriptor.issuer.did, keys: [{ kid: descriptor.issuer.kid, alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: encodeBase64Url(publicKey) }, validFrom: "2029-01-01T00:00:00Z", validUntil: "2031-01-01T00:00:00Z" }], cache: { maxAgeSeconds: 300, etag: "\"key-1\"" } };
  expect((await verifyIssuedCredential({ envelope, descriptor, descriptorDigest, requirement, holderDid, issuerMetadata: metadata, now, checkStatus: async () => true })).claims).toEqual(claims);
  await expect(verifyIssuedCredential({ envelope, descriptor, descriptorDigest, requirement, holderDid, issuerMetadata: { ...metadata, keys: [{ ...metadata.keys[0]!, retiredAt: "2029-12-01T00:00:00Z" }] }, now, checkStatus: async () => true })).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
});
