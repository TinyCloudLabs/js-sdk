import { canonicalDigest, CredentialError, type CredentialFlowDescriptor, type CredentialHolderBinding, type CredentialRequirement } from "@tinycloud/sdk-core";

/** The witness's request window: the signed binding runs from request creation to creation + 600 s. */
const REQUEST_TTL_MS = 600_000;

/** What the SDK itself computed for this request. The witness's binding must equal all of it before the wallet is called. */
export interface HeldBindingExpectation {
  readonly descriptor: CredentialFlowDescriptor;
  readonly requirement: CredentialRequirement;
  readonly requestId: string;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly holderDid: string;
  readonly openerOrigin: string;
  /** The nonce this client's transport stored from the challenge, or undefined if none was stored. */
  readonly challengeNonce: string | undefined;
  /** `expiresAt` of the R1 create response (ISO), or undefined if none was kept. */
  readonly serverExpiresAt: string | undefined;
}

const substituted = (): CredentialError => new CredentialError("REQUEST_SUBSTITUTED", "Holder binding was substituted");

/**
 * Refuses (REQUEST_SUBSTITUTED) unless the held account binding is exactly what this client asked for: the domain comes from the
 * pinned descriptor, never from the response. The field shape, `protocol`, `profileVersion`, the 365-day lifetime and the `urn:uuid`
 * `jti` were already checked by `validateCredentialHolderBinding`. The `jti` itself cannot be known in advance; it is kept by the
 * caller and compared with the credential's after issuance.
 */
export async function assertHeldBinding(binding: CredentialHolderBinding, expected: HeldBindingExpectation): Promise<void> {
  const { descriptor } = expected;
  if (
    descriptor.holderBinding.alg !== "EIP191" ||
    binding.type !== descriptor.holderBinding.domain ||
    binding.requestId !== expected.requestId ||
    binding.descriptorDigest !== expected.descriptorDigest ||
    binding.requirementDigest !== expected.requirementDigest ||
    binding.holderDid !== expected.holderDid ||
    binding.issuer !== descriptor.issuer.did ||
    binding.issuerKid !== descriptor.issuer.kid ||
    binding.profile !== descriptor.profile ||
    binding.openerOrigin !== expected.openerOrigin ||
    binding.completionOrigin !== expected.openerOrigin ||
    binding.audience !== "tinycloud://credentials" ||
    binding.completionContext !== "sdk-acquisition"
  ) throw substituted();
  if (expected.challengeNonce === undefined || binding.challengeNonce !== expected.challengeNonce) throw substituted();
  if (binding.normalizedClaimsDigest !== await canonicalDigest(expected.requirement.claims)) throw substituted();
  const expires = Date.parse(binding.expiresAt);
  if (expected.serverExpiresAt === undefined || expires !== Date.parse(expected.serverExpiresAt) || Date.parse(binding.issuedAt) !== expires - REQUEST_TTL_MS) throw substituted();
}
