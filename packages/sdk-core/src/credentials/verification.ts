import { ed25519 } from "@noble/curves/ed25519";
import { canonicalDigest, decodeBase64Url, sha256Base64Url } from "./digest";
import { CredentialError } from "./errors";
import { credentialMatchesRequirement } from "./requirement";
import { CREDENTIAL_ACQUISITION_PROTOCOL, CREDENTIAL_FORMAT, HOLDER_BINDING_DOMAIN, type CredentialFlowDescriptor, type CredentialIssuerMetadata, type CredentialRequirement, type IssuedCredentialEnvelope, type VerifiedCredential } from "./types";

function jsonPart(value: string, label: string): Record<string, unknown> {
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value))); } catch { throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`);
  return parsed as Record<string, unknown>;
}
function iso(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`); return new Date(value).toISOString(); }
function exact(value: unknown, keys: readonly string[]): boolean { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }

function metadataKey(metadata: CredentialIssuerMetadata, descriptor: CredentialFlowDescriptor, now: Date, kid: string): Uint8Array {
  if (!exact(metadata, ["type", "version", "origin", "issuerDid", "keys", "cache"]) || metadata.type !== "OpenCredentialsIssuerMetadata" || metadata.version !== 1 || metadata.origin !== descriptor.issuer.origin || metadata.issuerDid !== descriptor.issuer.did || !Array.isArray(metadata.keys) || metadata.keys.length === 0 || !exact(metadata.cache, ["maxAgeSeconds", "etag"]) || !Number.isSafeInteger(metadata.cache.maxAgeSeconds) || metadata.cache.maxAgeSeconds < 1 || typeof metadata.cache.etag !== "string" || metadata.cache.etag.length === 0) throw new CredentialError("VERIFICATION_FAILED", "Issuer metadata is invalid");
  for (const candidate of metadata.keys) { const fields = candidate.retiredAt === undefined ? ["kid", "alg", "jwk", "validFrom", "validUntil"] : ["kid", "alg", "jwk", "validFrom", "validUntil", "retiredAt"]; if (!exact(candidate, fields) || !exact(candidate.jwk, ["kty", "crv", "x"]) || !Number.isFinite(Date.parse(candidate.validFrom)) || !Number.isFinite(Date.parse(candidate.validUntil)) || Date.parse(candidate.validUntil) <= Date.parse(candidate.validFrom)) throw new CredentialError("VERIFICATION_FAILED", "Issuer metadata key is invalid"); }
  const key = metadata.keys.find((candidate) => candidate.kid === kid);
  if (!key || key.alg !== "EdDSA" || key.jwk.kty !== "OKP" || key.jwk.crv !== "Ed25519" || key.retiredAt !== undefined || now < new Date(key.validFrom) || now >= new Date(key.validUntil)) throw new CredentialError("VERIFICATION_FAILED", "Issuer key is unknown, retired, or outside its validity window");
  const bytes = decodeBase64Url(key.jwk.x); if (bytes.length !== 32) throw new CredentialError("VERIFICATION_FAILED", "Issuer key is invalid"); return bytes;
}

/** Independently verifies the Rust-owned SD-JWT profile contract before storage. */
export async function verifyIssuedCredential(input: {
  readonly envelope: IssuedCredentialEnvelope; readonly descriptor: CredentialFlowDescriptor; readonly descriptorDigest: string;
  readonly requirement: CredentialRequirement; readonly holderDid: string; readonly issuerMetadata: CredentialIssuerMetadata;
  readonly now?: Date; readonly checkStatus: (status: IssuedCredentialEnvelope["status"], signal?: AbortSignal) => Promise<boolean>; readonly signal?: AbortSignal;
}): Promise<VerifiedCredential> {
  const { envelope, descriptor, requirement, holderDid } = input; const now = input.now ?? new Date();
  if (envelope.type !== "OpenCredentialsIssuedCredential" || envelope.version !== 1 || envelope.protocol !== CREDENTIAL_ACQUISITION_PROTOCOL || envelope.format !== CREDENTIAL_FORMAT || envelope.descriptorDigest !== input.descriptorDigest || envelope.profile.id !== descriptor.profile || envelope.profile.version !== descriptor.profileVersion || envelope.credentialType.id !== descriptor.format.vct || envelope.credentialType.version !== 1 || envelope.schema !== descriptor.format.vct || envelope.issuerDid !== descriptor.issuer.did || envelope.issuerKid !== descriptor.issuer.kid || envelope.subjectDid !== holderDid || envelope.holderDid !== holderDid) throw new CredentialError("HOLDER_MISMATCH", "Issued credential binding does not match the active session");
  if (envelope.status.method !== "none" || envelope.status.freshnessSeconds !== descriptor.status.freshnessSeconds) throw new CredentialError("VERIFICATION_FAILED", "Credential status contract is invalid");
  const parts = envelope.credential.split("~"); const jwt = parts.shift() ?? ""; const jwtParts = jwt.split("."); if (jwtParts.length !== 3) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT is invalid");
  const header = jsonPart(jwtParts[0]!, "SD-JWT header"); const payload = jsonPart(jwtParts[1]!, "SD-JWT payload");
  if (header.alg !== "EdDSA" || header.typ !== "vc+sd-jwt" || header.kid !== envelope.issuerKid) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT header is unsupported");
  const signature = decodeBase64Url(jwtParts[2]!); const key = metadataKey(input.issuerMetadata, descriptor, now, envelope.issuerKid);
  if (signature.length !== 64 || !ed25519.verify(signature, new TextEncoder().encode(`${jwtParts[0]}.${jwtParts[1]}`), key)) throw new CredentialError("VERIFICATION_FAILED", "Issuer signature is invalid");
  if (payload._sd_alg !== "sha-256" || !Array.isArray(payload._sd) || payload._sd.some((value) => typeof value !== "string")) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure registry is invalid");
  const disclosed: Record<string, unknown> = { ...payload };
  for (const disclosure of parts.filter(Boolean)) { const digest = await sha256Base64Url(disclosure); if (!(payload._sd as string[]).includes(digest)) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure is not signed"); let item: unknown; try { item = JSON.parse(new TextDecoder().decode(decodeBase64Url(disclosure))); } catch { throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure is invalid"); } if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== "string" || typeof item[1] !== "string" || Object.prototype.hasOwnProperty.call(disclosed, item[1])) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT disclosure is invalid"); disclosed[item[1]] = item[2]; }
  const binding = disclosed.holderBinding as Record<string, unknown> | undefined;
  if (disclosed.iss !== descriptor.issuer.did || disclosed.sub !== holderDid || disclosed.vct !== descriptor.format.vct || disclosed.profile !== descriptor.profile || disclosed.profileVersion !== 1 || disclosed.descriptorDigest !== input.descriptorDigest || !exact(binding, ["did", "signingDomain"]) || binding!.did !== holderDid || binding!.signingDomain !== HOLDER_BINDING_DOMAIN) throw new CredentialError("VERIFICATION_FAILED", "SD-JWT profile or holder binding is invalid");
  const claims: Record<string, string> = {}; for (const claim of descriptor.claims) { const value = disclosed[claim.name]; if (typeof value !== "string") throw new CredentialError("VERIFICATION_FAILED", "Required credential disclosure is missing"); claims[claim.name] = value; }
  if (await canonicalDigest(claims) !== envelope.claimsDigest || await canonicalDigest(envelope.claims) !== envelope.claimsDigest) throw new CredentialError("VERIFICATION_FAILED", "Credential claims digest is invalid");
  if (disclosed.jti !== envelope.credentialId || typeof disclosed.iat !== "number" || typeof disclosed.nbf !== "number" || typeof disclosed.exp !== "number") throw new CredentialError("VERIFICATION_FAILED", "Credential identity or validity is invalid");
  const issuedAt = iso(envelope.issuedAt, "issuedAt"); const notBefore = iso(envelope.notBefore, "notBefore"); const expiresAt = iso(envelope.expiresAt, "expiresAt");
  if (disclosed.iat !== Math.floor(Date.parse(issuedAt) / 1000) || disclosed.nbf !== Math.floor(Date.parse(notBefore) / 1000) || disclosed.exp !== Math.floor(Date.parse(expiresAt) / 1000) || now < new Date(notBefore) || now >= new Date(expiresAt)) throw new CredentialError("REQUEST_EXPIRED", "Credential validity window is invalid");
  if (!credentialMatchesRequirement(requirement, envelope, holderDid, now)) throw new CredentialError("VERIFICATION_FAILED", "Credential does not satisfy the requirement");
  if (!(await input.checkStatus(envelope.status, input.signal))) throw new CredentialError("VERIFICATION_FAILED", "Credential status is not valid");
  return Object.freeze({ ...envelope, claims: Object.freeze(claims), issuedAt, notBefore, expiresAt, verifiedAt: now.toISOString(), credentialDigest: await sha256Base64Url(envelope.credential), statusCheckedAt: now.toISOString() });
}
