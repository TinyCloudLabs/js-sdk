import { ed25519 } from "@noble/curves/ed25519";
import { canonicalDigest, decodeBase64Url, sha256Base64Url } from "./digest";
import { CredentialError } from "./errors";
import { credentialMatchesRequirement } from "./requirement";
import { CREDENTIAL_ACQUISITION_PROTOCOL, CREDENTIAL_FORMAT, type CredentialFlowDescriptor, type CredentialIssuerMetadata, type CredentialRequirement, type IssuedCredentialEnvelope, type VerifiedCredential } from "./types";

function jsonPart(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value))); } catch { throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`);
  return parsed as Record<string, unknown>;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`);
  return new Date(value).toISOString();
}

function validateMetadata(metadata: CredentialIssuerMetadata, descriptor: CredentialFlowDescriptor, now: Date) {
  const exact = (value: unknown, keys: readonly string[]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort(); const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  };
  if (!exact(metadata, ["type", "version", "origin", "issuerDid", "keys", "cache"]) || metadata.type !== "OpenCredentialsIssuerMetadata" || metadata.version !== 1 || metadata.origin !== descriptor.issuer.origin || metadata.issuerDid !== descriptor.issuer.did || !Array.isArray(metadata.keys) || metadata.keys.length === 0 || typeof metadata.cache !== "object" || !exact(metadata.cache, ["maxAgeSeconds", "etag"]) || !Number.isSafeInteger(metadata.cache.maxAgeSeconds) || metadata.cache.maxAgeSeconds < 1 || typeof metadata.cache.etag !== "string" || metadata.cache.etag.length === 0) throw new CredentialError("VERIFICATION_FAILED", "Issuer metadata is invalid");
  for (const candidate of metadata.keys) {
    const expectedKeys = candidate.retiredAt === undefined ? ["kid", "alg", "jwk", "validFrom", "validUntil"] : ["kid", "alg", "jwk", "validFrom", "validUntil", "retiredAt"];
    if (!exact(candidate, expectedKeys) || !exact(candidate.jwk, ["kty", "crv", "x"]) || !Number.isFinite(Date.parse(candidate.validFrom)) || !Number.isFinite(Date.parse(candidate.validUntil)) || Date.parse(candidate.validUntil) <= Date.parse(candidate.validFrom)) throw new CredentialError("VERIFICATION_FAILED", "Issuer metadata key is invalid");
  }
  return (kid: string) => {
    const key = metadata.keys.find((candidate) => candidate.kid === kid);
    if (!key || key.alg !== "EdDSA" || key.jwk.kty !== "OKP" || key.jwk.crv !== "Ed25519" || key.retiredAt !== undefined || now < new Date(key.validFrom) || now >= new Date(key.validUntil)) throw new CredentialError("VERIFICATION_FAILED", "Issuer key is unknown, retired, or outside its validity window");
    const bytes = decodeBase64Url(key.jwk.x);
    if (bytes.length !== 32) throw new CredentialError("VERIFICATION_FAILED", "Issuer key is invalid");
    return bytes;
  };
}

/** Independently verifies issuer signature, disclosures and every acquisition binding before storage. */
export async function verifyIssuedCredential(input: {
  readonly envelope: IssuedCredentialEnvelope;
  readonly descriptor: CredentialFlowDescriptor;
  readonly descriptorDigest: string;
  readonly requirement: CredentialRequirement;
  readonly holderDid: string;
  readonly issuerMetadata: CredentialIssuerMetadata;
  readonly now?: Date;
  readonly checkStatus: (status: IssuedCredentialEnvelope["status"], signal?: AbortSignal) => Promise<boolean>;
  readonly signal?: AbortSignal;
}): Promise<VerifiedCredential> {
  const { envelope, descriptor, requirement, holderDid } = input;
  const now = input.now ?? new Date();
  if (envelope.type !== "OpenCredentialsIssuedCredential" || envelope.version !== 1 || envelope.protocol !== CREDENTIAL_ACQUISITION_PROTOCOL || envelope.format !== CREDENTIAL_FORMAT || envelope.descriptorDigest !== input.descriptorDigest || envelope.profile.id !== descriptor.profile.id || envelope.profile.version !== descriptor.profile.version || envelope.credentialType.id !== descriptor.credential.type || envelope.credentialType.version !== descriptor.credential.version || envelope.schema !== descriptor.credential.schema || envelope.issuerDid !== descriptor.issuer.did || envelope.subjectDid !== holderDid || envelope.holderDid !== holderDid) throw new CredentialError("HOLDER_MISMATCH", "Issued credential binding does not match the active session");
  if (envelope.status.method !== "issuer" || !/^urn:opencredentials:status:[A-Za-z0-9_-]{16,128}$/.test(envelope.status.reference)) throw new CredentialError("VERIFICATION_FAILED", "Credential status contract is invalid");
  const parts = envelope.credential.split("~"); const jwt = parts.shift() ?? ""; const jwtParts = jwt.split(".");
  if (jwtParts.length !== 3) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT is invalid");
  const header = jsonPart(jwtParts[0]!, "SD-JWT header"); const payload = jsonPart(jwtParts[1]!, "SD-JWT payload");
  if (header.alg !== "EdDSA" || header.typ !== "vc+sd-jwt" || typeof header.kid !== "string" || header.kid !== envelope.issuerKid) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT header is unsupported");
  const key = validateMetadata(input.issuerMetadata, descriptor, now)(header.kid);
  const signature = decodeBase64Url(jwtParts[2]!);
  if (signature.length !== 64 || !ed25519.verify(signature, new TextEncoder().encode(`${jwtParts[0]}.${jwtParts[1]}`), key)) throw new CredentialError("VERIFICATION_FAILED", "Issuer signature is invalid");
  const expectedPayload: Record<string, unknown> = { protocol: CREDENTIAL_ACQUISITION_PROTOCOL, profile: envelope.profile, credential_type: envelope.credentialType, schema: envelope.schema, iss: envelope.issuerDid, sub: envelope.subjectDid, holder: envelope.holderDid, descriptor_digest: envelope.descriptorDigest, claims_digest: envelope.claimsDigest, jti: envelope.credentialId, status: envelope.status };
  for (const [name, value] of Object.entries(expectedPayload)) if (JSON.stringify(payload[name]) !== JSON.stringify(value)) throw new CredentialError("VERIFICATION_FAILED", `SD-JWT ${name} binding is invalid`);
  if (payload._sd_alg !== "sha-256" || !Array.isArray(payload._sd) || payload._sd.some((value) => typeof value !== "string")) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure registry is invalid");
  const claims: Record<string, string> = {};
  for (const disclosure of parts.filter(Boolean)) {
    const digest = await sha256Base64Url(disclosure);
    if (!(payload._sd as string[]).includes(digest)) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure is not signed");
    let item: unknown; try { item = JSON.parse(new TextDecoder().decode(decodeBase64Url(disclosure))); } catch { throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure is invalid"); }
    if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== "string" || typeof item[1] !== "string" || typeof item[2] !== "string" || Object.prototype.hasOwnProperty.call(claims, item[1])) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure is invalid");
    claims[item[1]] = item[2];
  }
  if (await canonicalDigest(claims) !== envelope.claimsDigest || await canonicalDigest(envelope.claims) !== envelope.claimsDigest) throw new CredentialError("VERIFICATION_FAILED", "Credential claims digest is invalid");
  const issuedAt = iso(envelope.issuedAt, "issuedAt"); const notBefore = iso(envelope.notBefore, "notBefore"); const expiresAt = iso(envelope.expiresAt, "expiresAt");
  if (payload.iat !== Math.floor(Date.parse(issuedAt) / 1000) || payload.nbf !== Math.floor(Date.parse(notBefore) / 1000) || payload.exp !== Math.floor(Date.parse(expiresAt) / 1000) || now < new Date(notBefore) || now >= new Date(expiresAt)) throw new CredentialError("REQUEST_EXPIRED", "Credential validity window is invalid");
  if (!credentialMatchesRequirement(requirement, envelope, holderDid, now)) throw new CredentialError("VERIFICATION_FAILED", "Credential does not satisfy the requirement");
  if (!(await input.checkStatus(envelope.status, input.signal))) throw new CredentialError("VERIFICATION_FAILED", "Credential status is not valid");
  const credentialDigest = await sha256Base64Url(envelope.credential);
  return Object.freeze({ ...envelope, claims: Object.freeze({ ...claims }), issuedAt, notBefore, expiresAt, verifiedAt: now.toISOString(), credentialDigest, statusCheckedAt: now.toISOString() });
}
