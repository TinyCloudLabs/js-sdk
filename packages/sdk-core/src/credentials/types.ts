export const CREDENTIAL_ACQUISITION_PROTOCOL = "tinycloud.credentials/acquisition/v1" as const;
export const HOLDER_BINDING_DOMAIN = "tinycloud.credentials/holder-binding/v1" as const;
export const CREDENTIAL_CONTRACT_VERSION = 1 as const;
export const CREDENTIAL_STEP_REGISTRY_VERSION = 1 as const;
export const CREDENTIAL_FORMAT = "vc+sd-jwt" as const;

export type CredentialStepType = "collect_input" | "mailbox_otp" | "holder_signature";
export type CredentialEndpointId = "request" | "state" | "challenge" | "proof" | "holder_binding" | "holder_signature" | "issue" | "result";

export interface CredentialClaimDescriptor {
  readonly name: string;
  readonly matching: "normalized_exact";
  readonly selectiveDisclosure: boolean;
}

export interface CredentialInputDescriptor {
  readonly id: string;
  readonly label: string;
  readonly schema: {
    readonly type: "string";
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly format?: "email";
  };
  readonly prefill: "privacy_hint_only";
  readonly autocomplete: "off";
}

export interface CredentialStepDescriptor {
  readonly type: CredentialStepType;
  readonly version: 1;
}

/** The canonical TC-462 descriptor. Its bytes are hashed without normalization. */
export interface CredentialFlowDescriptor {
  readonly type: "tinycloud.credentials/descriptor/v1";
  readonly contractVersion: 1;
  readonly protocol: typeof CREDENTIAL_ACQUISITION_PROTOCOL;
  readonly profile: string;
  readonly profileVersion: 1;
  readonly display: { readonly title: string; readonly description: string; readonly consent: string; readonly securityTextLocked: true };
  readonly accessibility: { readonly progressLabel: string; readonly errorLiveRegion: "assertive" };
  readonly theme: { readonly tokenVersion: "tinycloud.credentials/tokens/v1"; readonly allowed: readonly ("accentColor" | "fontFamily" | "borderRadius")[] };
  readonly issuer: { readonly origin: string; readonly did: string; readonly kid: string };
  readonly format: { readonly id: typeof CREDENTIAL_FORMAT; readonly vct: string };
  readonly claims: readonly CredentialClaimDescriptor[];
  readonly subjectRelationship: "holder_is_subject";
  readonly inputs: readonly CredentialInputDescriptor[];
  readonly steps: readonly CredentialStepDescriptor[];
  readonly holderBinding: { readonly required: true; readonly alg: "EdDSA"; readonly domain: typeof HOLDER_BINDING_DOMAIN; readonly version: 1 };
  readonly endpoints: Readonly<Record<"request" | "state" | "challenge" | "proof" | "holderBinding" | "holderSignature" | "issue" | "result", CredentialEndpointId>>;
  readonly lifecycle: { readonly requestTtlSeconds: number; readonly challengeTtlSeconds: number; readonly maxProofAttempts: number; readonly challengeConsumption: "atomic_once"; readonly retry: "bounded" };
  readonly status: { readonly type: "none"; readonly freshnessSeconds: number };
  readonly revocation: { readonly supported: false };
  readonly presentation: { readonly stateVersion: "tinycloud.credentials/ux-states/v1"; readonly states: readonly CredentialUxState[] };
}

export interface CredentialRequirement {
  readonly type: "TinyCloudCredentialRequirement";
  readonly version: 1;
  readonly profile: { readonly id: string; readonly version: 1 };
  readonly credentialType: { readonly id: string; readonly version: 1 };
  readonly claims: Readonly<Record<string, string>>;
  readonly maxAgeSeconds?: number;
}

export interface CredentialHolderBinding {
  readonly type: typeof HOLDER_BINDING_DOMAIN;
  readonly protocol: typeof CREDENTIAL_ACQUISITION_PROTOCOL;
  readonly requestId: string;
  readonly profile: string;
  readonly profileVersion: 1;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly issuer: string;
  readonly issuerKid: string;
  readonly holderDid: string;
  readonly normalizedClaimsDigest: string;
  readonly challengeNonce: string;
  readonly audience: string;
  readonly openerOrigin: string;
  readonly completionOrigin: string;
  readonly completionContext: string;
  readonly jti: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface IssuerVerificationKey {
  readonly kid: string;
  readonly alg: "EdDSA";
  readonly jwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
  readonly validFrom: string;
  readonly validUntil: string;
  readonly retiredAt?: string;
}

export interface CredentialIssuerMetadata {
  readonly type: "OpenCredentialsIssuerMetadata";
  readonly version: 1;
  readonly origin: string;
  readonly issuerDid: string;
  readonly keys: readonly IssuerVerificationKey[];
  readonly cache: { readonly maxAgeSeconds: number; readonly etag: string };
}

export interface IssuedCredentialEnvelope {
  readonly type: "OpenCredentialsIssuedCredential";
  readonly version: 1;
  readonly protocol: typeof CREDENTIAL_ACQUISITION_PROTOCOL;
  readonly profile: { readonly id: string; readonly version: 1 };
  readonly credentialType: { readonly id: string; readonly version: 1 };
  readonly schema: string;
  readonly format: typeof CREDENTIAL_FORMAT;
  readonly issuerDid: string;
  readonly issuerKid: string;
  readonly subjectDid: string;
  readonly holderDid: string;
  readonly claims: Readonly<Record<string, string>>;
  readonly claimsDigest: string;
  readonly descriptorDigest: string;
  readonly credentialId: string;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly status: { readonly method: "none"; readonly freshnessSeconds: number };
  readonly credential: string;
}

export interface VerifiedCredential extends IssuedCredentialEnvelope {
  readonly verifiedAt: string;
  readonly credentialDigest: string;
  readonly statusCheckedAt: string;
}

export interface StoredCredentialRecord {
  readonly type: "TinyCloudStoredCredential";
  readonly version: 1;
  readonly ownerDid: string;
  readonly recordId: string;
  readonly requirementDigest: string;
  readonly descriptorDigest: string;
  readonly profile: { readonly id: string; readonly version: 1 };
  readonly credentialType: { readonly id: string; readonly version: 1 };
  readonly issuerDid: string;
  readonly issuerKid: string;
  readonly holderDid: string;
  readonly claims: Readonly<Record<string, string>>;
  readonly claimsDigest: string;
  readonly credentialDigest: string;
  readonly credential: string;
  readonly schema: string;
  readonly credentialId: string;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly status: { readonly method: "none"; readonly freshnessSeconds: number };
  readonly verifiedAt: string;
  readonly storedAt: string;
}

export interface CredentialStorageReceipt {
  readonly type: "TinyCloudCredentialStorageReceipt";
  readonly version: 1;
  readonly ownerDid: string;
  readonly recordId: string;
  readonly recordDigest: string;
  readonly storedAt: string;
  readonly etag?: string;
}

export type CredentialUxState = "collecting" | "challenging" | "proving" | "signing" | "issuing" | "verifying" | "saving" | "success" | "recovery";

export interface CredentialProgressEvent {
  readonly state: CredentialUxState | "checking";
  readonly stepId?: string;
  readonly correlationId?: string;
}
