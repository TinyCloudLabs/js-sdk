export const CREDENTIAL_ACQUISITION_PROTOCOL = "tinycloud.credentials/acquisition/v1" as const;
export const HOLDER_BINDING_DOMAIN = "tinycloud.credentials/holder-binding/v1" as const;
export const CREDENTIAL_CONTRACT_VERSION = 1 as const;
export const CREDENTIAL_STEP_REGISTRY_VERSION = 1 as const;
export const CREDENTIAL_FORMAT = "vc+sd-jwt" as const;

export type CredentialStepType = "collect_input" | "mailbox_otp" | "holder_signature";
export type CredentialEndpointId =
  | "create_request"
  | "request_state"
  | "create_challenge"
  | "submit_proof"
  | "holder_binding"
  | "submit_holder_signature"
  | "issue"
  | "result"
  | "issuer_metadata"
  | "credential_status"
  | "interaction";

export interface CredentialClaimDescriptor {
  readonly id: string;
  readonly matching: "exact";
  readonly required: boolean;
}

export interface CredentialInputDescriptor {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly prefill: "allowed" | "forbidden";
  readonly schema: {
    readonly type: "string";
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly format?: "email";
  };
  readonly accessibility: {
    readonly label: string;
    readonly description?: string;
  };
}

export interface CredentialStepDescriptor {
  readonly id: string;
  readonly type: CredentialStepType;
  readonly version: 1;
  readonly endpoint: CredentialEndpointId;
  readonly title: string;
  readonly description: string;
}

export interface CredentialFlowDescriptor {
  readonly type: "OpenCredentialsFlowDescriptor";
  readonly protocol: typeof CREDENTIAL_ACQUISITION_PROTOCOL;
  readonly version: 1;
  readonly stepRegistryVersion: 1;
  readonly profile: { readonly id: string; readonly version: 1 };
  readonly issuer: { readonly origin: string; readonly did: string };
  readonly credential: {
    readonly type: string;
    readonly version: 1;
    readonly schema: string;
    readonly format: typeof CREDENTIAL_FORMAT;
  };
  readonly claims: readonly CredentialClaimDescriptor[];
  readonly inputs: readonly CredentialInputDescriptor[];
  readonly steps: readonly CredentialStepDescriptor[];
  readonly holderBinding: {
    readonly required: true;
    readonly domain: typeof HOLDER_BINDING_DOMAIN;
    readonly version: 1;
  };
  readonly endpoints: Readonly<Record<CredentialEndpointId, CredentialEndpointId>>;
  readonly ttlSeconds: number;
  readonly freshnessSeconds: number;
  readonly presentation: {
    readonly title: string;
    readonly description: string;
    readonly consent: string;
    readonly progressLabel: string;
    readonly successLabel: string;
    readonly recoveryLabel: string;
  };
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
  readonly type: "TinyCloudCredentialHolderBinding";
  readonly protocol: typeof CREDENTIAL_ACQUISITION_PROTOCOL;
  readonly version: 1;
  readonly signingDomain: typeof HOLDER_BINDING_DOMAIN;
  readonly signingDomainVersion: 1;
  readonly requestId: string;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly profile: { readonly id: string; readonly version: 1 };
  readonly issuerDid: string;
  readonly issuerKid: string;
  readonly holderDid: string;
  readonly claimsDigest: string;
  readonly challengeNonce: string;
  readonly openerOrigin: string;
  readonly audience: string;
  readonly completionContextDigest: string;
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
  readonly status: { readonly method: "issuer"; readonly reference: string };
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
  readonly status: { readonly method: "issuer"; readonly reference: string };
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

export type CredentialUxState =
  | "idle"
  | "checking"
  | "collecting"
  | "proving"
  | "signing"
  | "verifying"
  | "saving"
  | "success"
  | "recovery"
  | "canceled";

export interface CredentialProgressEvent {
  readonly state: CredentialUxState;
  readonly stepId?: string;
  readonly correlationId?: string;
}
