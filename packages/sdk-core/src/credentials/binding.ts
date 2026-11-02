import { jcsCanonicalize } from "../policy/jcs";
import { CredentialError } from "./errors";
import { ACCOUNT_HOLDER_BINDING_DOMAIN, CREDENTIAL_ACQUISITION_PROTOCOL, HOLDER_BINDING_DOMAIN, type CredentialHolderBinding, type TicketHolderBinding } from "./types";

const OPAQUE = /^[A-Za-z0-9_-]{16,128}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
/** The held binding's `jti` becomes the credential's `jti`: a lowercase v4 urn:uuid. */
const JTI_V4 = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT_CREDENTIAL_LIFETIME_SECONDS = 31_536_000;

export function createHolderBinding(input: Omit<TicketHolderBinding, "type" | "protocol">): CredentialHolderBinding {
  return validateCredentialHolderBinding({ type: HOLDER_BINDING_DOMAIN, protocol: CREDENTIAL_ACQUISITION_PROTOCOL, ...input });
}

/** Rejects unknown binding fields before any active-session signing operation. */
export function validateCredentialHolderBinding(value: unknown): CredentialHolderBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding is invalid");
  const raw = value as Record<string, unknown>;
  // Two explicit shapes keyed on `type`: the ticket's 19 fields, or the account's 20 (adds credentialLifetimeSeconds).
  const account = raw.type === ACCOUNT_HOLDER_BINDING_DOMAIN;
  const fields = ["type", "protocol", "requestId", "profile", "profileVersion", "descriptorDigest", "requirementDigest", "issuer", "issuerKid", "holderDid", "normalizedClaimsDigest", "challengeNonce", "audience", "openerOrigin", "completionOrigin", "completionContext", "jti", "issuedAt", "expiresAt", ...(account ? ["credentialLifetimeSeconds"] : [])].sort();
  const actual = Object.keys(raw).sort();
  if (actual.length !== fields.length || actual.some((key, index) => key !== fields[index]) || (!account && raw.type !== HOLDER_BINDING_DOMAIN) || (account && raw.credentialLifetimeSeconds !== ACCOUNT_CREDENTIAL_LIFETIME_SECONDS) || raw.protocol !== CREDENTIAL_ACQUISITION_PROTOCOL || raw.profileVersion !== 1) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding version is unsupported");
  for (const name of ["requestId", "profile", "descriptorDigest", "requirementDigest", "issuer", "issuerKid", "holderDid", "normalizedClaimsDigest", "challengeNonce", "audience", "openerOrigin", "completionOrigin", "completionContext", "jti", "issuedAt", "expiresAt"]) if (typeof raw[name] !== "string" || (raw[name] as string).length === 0) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding field is invalid");
  for (const name of ["descriptorDigest", "requirementDigest", "normalizedClaimsDigest"]) if (!DIGEST.test(raw[name] as string)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding digest is invalid");
  for (const name of ["requestId", "challengeNonce"]) if (!OPAQUE.test(raw[name] as string)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding nonce is invalid");
  if (!(account ? JTI_V4 : OPAQUE).test(raw.jti as string)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding nonce is invalid");
  for (const name of ["openerOrigin", "completionOrigin"]) { let url: URL; try { url = new URL(raw[name] as string); } catch { throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding origin is invalid"); } if (url.origin !== raw[name] || url.protocol !== "https:") throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding origin is invalid"); }
  const issued = Date.parse(raw.issuedAt as string); const expires = Date.parse(raw.expiresAt as string);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new CredentialError("REQUEST_EXPIRED", "Holder binding validity is invalid");
  return Object.freeze(raw as unknown as CredentialHolderBinding);
}

export function holderBindingCanonicalBytes(binding: CredentialHolderBinding): Uint8Array {
  return new TextEncoder().encode(jcsCanonicalize(validateCredentialHolderBinding(binding)));
}

export function holderBindingSigningBytes(binding: CredentialHolderBinding): Uint8Array {
  const valid = validateCredentialHolderBinding(binding);
  // The signing domain is the binding's own type: holder-binding/v1 for a ticket, account-binding/v1 for held.
  return new TextEncoder().encode(`${valid.type}\0${jcsCanonicalize(valid)}`);
}
