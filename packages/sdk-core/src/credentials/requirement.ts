import { canonicalDigest } from "./digest";
import { CredentialError } from "./errors";
import type { CredentialFlowDescriptor, CredentialRequirement, StoredCredentialRecord, VerifiedCredential } from "./types";

const ID = /^[a-z0-9][a-z0-9._-]{0,127}(?:\/v1)?$/;
export const EMAIL_CREDENTIAL_MAX_AGE_SECONDS = 3600 as const;

export function createEmailCredentialRequirement(input: {
  readonly email: string;
  readonly profile: CredentialRequirement["profile"];
  readonly credentialType: CredentialRequirement["credentialType"];
}): CredentialRequirement {
  return validateCredentialRequirement({
    type: "TinyCloudCredentialRequirement",
    version: 1,
    profile: input.profile,
    credentialType: input.credentialType,
    claims: { email: input.email },
    maxAgeSeconds: EMAIL_CREDENTIAL_MAX_AGE_SECONDS,
  });
}

export function validateCredentialRequirement(value: unknown): CredentialRequirement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential requirement is invalid");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["type", "version", "profile", "credentialType", "claims", "maxAgeSeconds"].includes(key)) || raw.type !== "TinyCloudCredentialRequirement" || raw.version !== 1) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential requirement version is unsupported");
  const pair = (candidate: unknown, label: string) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new CredentialError("UNSUPPORTED_PROFILE", `${label} is invalid`);
    const item = candidate as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || typeof item.id !== "string" || !ID.test(item.id) || item.version !== 1) throw new CredentialError("UNSUPPORTED_PROFILE", `${label} version is unsupported`);
    return { id: item.id, version: 1 as const };
  };
  if (typeof raw.claims !== "object" || raw.claims === null || Array.isArray(raw.claims)) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential claims are invalid");
  const claims: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.claims as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ID.test(key) || typeof value !== "string" || value.length === 0 || value.length > 4096) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential claim is invalid");
    claims[key] = value;
  }
  if (raw.maxAgeSeconds !== undefined && (!Number.isSafeInteger(raw.maxAgeSeconds) || (raw.maxAgeSeconds as number) < 1)) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential freshness is invalid");
  return Object.freeze({ type: "TinyCloudCredentialRequirement", version: 1, profile: pair(raw.profile, "profile"), credentialType: pair(raw.credentialType, "credentialType"), claims: Object.freeze(claims), ...(raw.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: raw.maxAgeSeconds as number }) });
}

export async function credentialRequirementDigest(requirement: CredentialRequirement): Promise<string> {
  return canonicalDigest(validateCredentialRequirement(requirement));
}

export function descriptorSatisfiesRequirement(descriptor: CredentialFlowDescriptor, requirement: CredentialRequirement): boolean {
  const requested = validateCredentialRequirement(requirement);
  if (descriptor.profile !== requested.profile.id || descriptor.profileVersion !== requested.profile.version || descriptor.format.vct !== requested.credentialType.id || requested.credentialType.version !== 1) return false;
  const declared = new Map(descriptor.claims.map((claim) => [claim.name, claim]));
  return Object.keys(requested.claims).every((id) => declared.get(id)?.matching === "normalized_exact");
}

function matches(requirement: CredentialRequirement, candidate: Pick<StoredCredentialRecord | VerifiedCredential, "profile" | "credentialType" | "claims" | "holderDid" | "expiresAt" | "issuedAt">, holderDid: string, now: Date): boolean {
  if (candidate.holderDid !== holderDid || candidate.profile.id !== requirement.profile.id || candidate.profile.version !== requirement.profile.version || candidate.credentialType.id !== requirement.credentialType.id || candidate.credentialType.version !== requirement.credentialType.version) return false;
  if (new Date(candidate.expiresAt).getTime() <= now.getTime()) return false;
  if (requirement.maxAgeSeconds !== undefined && now.getTime() - new Date(candidate.issuedAt).getTime() > requirement.maxAgeSeconds * 1000) return false;
  return Object.entries(requirement.claims).every(([key, value]) => candidate.claims[key] === value);
}

export function credentialMatchesRequirement(requirement: CredentialRequirement, candidate: Pick<StoredCredentialRecord | VerifiedCredential, "profile" | "credentialType" | "claims" | "holderDid" | "expiresAt" | "issuedAt">, holderDid: string, now = new Date()): boolean {
  return matches(validateCredentialRequirement(requirement), candidate, holderDid, now);
}
