import { jcsCanonicalize } from "../policy/jcs";
import { canonicalDigest } from "./digest";
import { CredentialError } from "./errors";
import { CREDENTIAL_ACQUISITION_PROTOCOL, HOLDER_BINDING_DOMAIN, type CredentialFlowDescriptor, type CredentialHolderBinding, type CredentialRequirement } from "./types";

const OPAQUE = /^[A-Za-z0-9_-]{16,128}$/;

export async function createHolderBinding(input: {
  readonly requestId: string;
  readonly descriptor: CredentialFlowDescriptor;
  readonly descriptorDigest: string;
  readonly requirement: CredentialRequirement;
  readonly requirementDigest: string;
  readonly issuerKid: string;
  readonly holderDid: string;
  readonly claimsDigest: string;
  readonly challengeNonce: string;
  readonly openerOrigin: string;
  readonly audience: string;
  readonly completionContext: unknown;
  readonly jti: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): Promise<CredentialHolderBinding> {
  for (const [name, value] of [["requestId", input.requestId], ["challengeNonce", input.challengeNonce], ["jti", input.jti]] as const) if (!OPAQUE.test(value)) throw new CredentialError("REQUEST_SUBSTITUTED", `${name} is invalid`);
  const issued = Date.parse(input.issuedAt); const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new CredentialError("REQUEST_EXPIRED", "Holder binding validity is invalid");
  const exactOrigin = (value: string, label: string) => {
    let url: URL; try { url = new URL(value); } catch { throw new CredentialError("REQUEST_SUBSTITUTED", `${label} is invalid`); }
    if (url.origin !== value || !["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) throw new CredentialError("REQUEST_SUBSTITUTED", `${label} is invalid`);
    return value;
  };
  return Object.freeze({ type: "TinyCloudCredentialHolderBinding", protocol: CREDENTIAL_ACQUISITION_PROTOCOL, version: 1, signingDomain: HOLDER_BINDING_DOMAIN, signingDomainVersion: 1, requestId: input.requestId, descriptorDigest: input.descriptorDigest, requirementDigest: input.requirementDigest, profile: input.descriptor.profile, issuerDid: input.descriptor.issuer.did, issuerKid: input.issuerKid, holderDid: input.holderDid, claimsDigest: input.claimsDigest, challengeNonce: input.challengeNonce, openerOrigin: exactOrigin(input.openerOrigin, "openerOrigin"), audience: exactOrigin(input.audience, "audience"), completionContextDigest: await canonicalDigest(input.completionContext), jti: input.jti, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString() });
}

/** Rejects unknown binding fields before any active-session signing operation. */
export function validateCredentialHolderBinding(value: unknown): CredentialHolderBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding is invalid");
  const raw = value as Record<string, unknown>;
  const fields = ["type", "protocol", "version", "signingDomain", "signingDomainVersion", "requestId", "descriptorDigest", "requirementDigest", "profile", "issuerDid", "issuerKid", "holderDid", "claimsDigest", "challengeNonce", "openerOrigin", "audience", "completionContextDigest", "jti", "issuedAt", "expiresAt"].sort();
  const actual = Object.keys(raw).sort();
  const profile = raw.profile;
  if (actual.length !== fields.length || actual.some((key, index) => key !== fields[index]) || raw.type !== "TinyCloudCredentialHolderBinding" || raw.protocol !== CREDENTIAL_ACQUISITION_PROTOCOL || raw.version !== 1 || raw.signingDomain !== HOLDER_BINDING_DOMAIN || raw.signingDomainVersion !== 1 || typeof profile !== "object" || profile === null || Array.isArray(profile) || Object.keys(profile).length !== 2 || typeof (profile as Record<string, unknown>).id !== "string" || (profile as Record<string, unknown>).version !== 1) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding version is unsupported");
  for (const name of ["requestId", "descriptorDigest", "requirementDigest", "issuerDid", "issuerKid", "holderDid", "claimsDigest", "challengeNonce", "openerOrigin", "audience", "completionContextDigest", "jti", "issuedAt", "expiresAt"]) if (typeof raw[name] !== "string" || (raw[name] as string).length === 0) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding field is invalid");
  for (const name of ["descriptorDigest", "requirementDigest", "claimsDigest", "completionContextDigest"]) if (!/^[A-Za-z0-9_-]{43}$/.test(raw[name] as string)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding digest is invalid");
  for (const name of ["requestId", "challengeNonce", "jti"]) if (!OPAQUE.test(raw[name] as string)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding nonce is invalid");
  const issued = Date.parse(raw.issuedAt as string); const expires = Date.parse(raw.expiresAt as string);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new CredentialError("REQUEST_EXPIRED", "Holder binding validity is invalid");
  for (const name of ["openerOrigin", "audience"]) { let url: URL; try { url = new URL(raw[name] as string); } catch { throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding origin is invalid"); } if (url.origin !== raw[name]) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding origin is invalid"); }
  return Object.freeze({ ...(raw as unknown as CredentialHolderBinding), profile: Object.freeze({ ...(profile as CredentialHolderBinding["profile"]) }), issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString() });
}

export function holderBindingSigningBytes(binding: CredentialHolderBinding): Uint8Array {
  return new TextEncoder().encode(`${HOLDER_BINDING_DOMAIN}\0${jcsCanonicalize(binding)}`);
}
