/**
 * Recipient-DID share envelope v2 wire types.
 *
 * These types mirror the normative `@tinycloud/share-envelope` contract. The
 * share-envelope package remains the schema/semantic verifier; this module
 * only gives the SDK's fixed-purpose signer and native WASM boundary one
 * dependency-free transport vocabulary.
 */

export const RECIPIENT_DID_SHARE_ENVELOPE_V2_DOMAIN =
  "xyz.tinycloud.share/envelope/v2\0";

export interface RecipientDidCacaoArtifactV2 {
  readonly kind: "cacao";
  readonly cid: string;
  readonly encoding: "dag-cbor-base64url-pad";
  readonly value: string;
}

export interface RecipientDidUcanArtifactV2 {
  readonly kind: "ucan";
  readonly cid: string;
  readonly encoding: "jwt";
  readonly value: string;
}

export type RecipientDidDelegationArtifactV2 =
  | RecipientDidCacaoArtifactV2
  | RecipientDidUcanArtifactV2;

export interface RecipientDidDelegationRoutingV2 {
  readonly origin: string;
  readonly nodeAudience: string;
}

export interface RecipientDidDelegationBundleV2 {
  readonly format: "tinycloud-recipient-delegation-v2";
  readonly routing: RecipientDidDelegationRoutingV2;
  readonly grant: RecipientDidUcanArtifactV2;
  /** Authority order: owner Cacao followed by any intermediate UCANs. */
  readonly issuerProofs: readonly RecipientDidDelegationArtifactV2[];
}

export interface RecipientDidShareDisplayV2 {
  readonly senderName?: string;
  readonly filename?: string;
  readonly recipientHint?: string;
  readonly mode?: "document" | "source" | "folder";
}

export interface RecipientDidShareTargetV2 {
  readonly origin: string;
  readonly nodeAudience: string;
  readonly spaceId: string;
  readonly resource: {
    readonly kind: "exact";
    readonly path: string;
  };
  readonly actions: readonly string[];
}

export interface RecipientDidShareEnvelopeV2SigningPayload {
  readonly version: 2;
  readonly shareId: string;
  readonly delegation: RecipientDidDelegationBundleV2;
  readonly authorizationTarget: {
    readonly kind: "recipientDid";
    readonly did: string;
  };
  readonly target: RecipientDidShareTargetV2;
  readonly display: RecipientDidShareDisplayV2;
  readonly expiry: string;
  readonly signature: {
    readonly signerDid: string;
    readonly algorithm: "Ed25519";
  };
}

export interface RecipientDidShareEnvelopeV2 extends Omit<
  RecipientDidShareEnvelopeV2SigningPayload,
  "signature"
> {
  readonly signature: RecipientDidShareEnvelopeV2SigningPayload["signature"] & {
    readonly value: string;
  };
}

/**
 * Successful output of the native, atomic authority verifier.
 *
 * A conforming implementation verifies the complete bundle together. It must
 * not synthesize this result from per-artifact parsing or adjacency checks.
 */
export interface NativeVerifiedRecipientDidDelegationBundleV2 {
  readonly verification: "tinycloud-native-authority-v1";
  readonly ownerDid: string;
  readonly sessionPrincipalDid: string;
  readonly sessionVerificationMethod: string;
  readonly recipientDid: string;
  readonly grantCid: string;
  readonly proofCids: readonly string[];
  readonly scope: {
    readonly spaceId: string;
    readonly resource: {
      readonly kind: "exact";
      readonly path: string;
    };
    readonly actions: readonly string[];
  };
  readonly notBefore?: string;
  readonly expiry: string;
}
