/**
 * TinyCloud SDK Delegations Module
 *
 * This module provides delegation and sharing link functionality
 * for the TinyCloud SDK. It extracts and improves upon the delegation
 * functionality previously in ITinyCloudStorage.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   DelegationManager,
 *   SharingService,
 *   Delegation,
 *   CreateDelegationParams,
 * } from "@tinycloud/sdk-core/delegations";
 *
 * // Create delegation manager
 * const delegations = new DelegationManager({
 *   hosts: ["https://node.tinycloud.xyz"],
 *   session,
 *   invoke,
 * });
 *
 * // Create a delegation
 * const result = await delegations.create({
 *   delegateDID: "did:pkh:eip155:1:0x...",
 *   path: "shared/",
 *   actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
 * });
 * ```
 */

// Types
export {
  // Result pattern
  Result,
  DelegationError,
  DelegationErrorCodes,
  DelegationErrorCode,

  // Delegation types
  Delegation,
  DelegationStatus,
  DelegationRevocationReceipt,
  AccountDelegationResource,
  AccountDelegationRecord,
  AccountDelegationPage,
  AccountDelegationQueryOptions,
  CreateDelegationParams,
  DelegationChain,
  DelegationApiResponse,

  // Configuration types
  DelegationManagerConfig,
  KeyProvider,

  // v2 types for CapabilityKeyRegistry
  JWK,
  KeyType,
  KeyInfo,
  CapabilityEntry,
  DelegationRecord,
  DelegationChainV2,
  DelegationDirection,
  DelegationFilters,
  SpaceOwnership,
  SpaceInfo,
  ShareSchema,
  ShareLink,
  ShareLinkData,
  IngestOptions,
  GenerateShareParams,

  // WASM delegation types
  CreateDelegationWasmParams,
  CreateDelegationWasmResult,
  DelegatedResource,
} from "./types";

// Classes
export { DelegationManager } from "./DelegationManager";

// v2 SharingService
export {
  SharingService,
  createSharingService,
  ISharingService,
  SharingServiceConfig,
  EncodedShareData,
  ReceiveOptions,
  ShareAccess,
  DelegateReceivedShareParams,
  DelegatedShareAccess,
} from "./SharingService";

export { ShareRecipientClient } from "./ShareRecipientClient";
export { delegatePortablePolicySession, importPortableDelegation, parsePortableDelegation, serializePortableDelegation } from "./portable";
export type { PortableDelegation as SharePortableDelegation, PortableDelegationImportReceipt } from "./portable";
export { MemoryShareCache } from "./ShareCache";
export type { ShareCache, ShareCacheEntry, ShareCacheKey, ShareCacheMetadata } from "./ShareCache";
export {
  createShareArtifact,
  createShareArtifactAsync,
  createSharePolicy,
  computeShareCid,
  decryptShareBytesAsync,
  encodeInlineShareUrl,
  encodeShareArtifact,
  encodeShareUrl,
  encryptShareBytes,
  encryptShareBytesAsync,
  intersectShareCapabilities,
  isV2ShareLink,
  normalizeShareActions,
  normalizeShareRecipientTarget,
  normalizeShareResource,
  parseShareArtifact,
  parseShareUrl,
  shareCapabilityAllows,
  signShareEnvelope,
  verifyShareCid,
  verifyShareEnvelope,
  ShareEnvelopeError,
  MAX_SHARE_CONTENT_BYTES,
  MAX_SEALED_SHARE_CONTENT_BYTES,
  MAX_SHARE_ARTIFACT_BYTES,
} from "./share-envelope";
export type {
  ShareAction,
  ShareArtifactInput,
  ShareArtifactResult,
  ShareArtifactV2,
  ShareCapabilityLike,
  ShareContentMetadata,
  ShareEnvelopeV2,
  ShareLinkLocation,
  SharePolicy,
  ShareRecipientTarget,
  ShareResource,
  VerifyShareEnvelopeOptions,
} from "./share-envelope";

export {
  createDelegatedShareKey,
  restoreDelegatedShareKey,
  createPolicyEnforcementDelegation,
  canonicalOwnerSharePolicy,
  computeOwnerShareRegistrationCid,
  validateOwnerSharePolicyRegistration,
  validateOwnerSharePolicyRegistrationBytes,
  MAX_CONTENT_BYTES,
} from "./owner-policy";
export type {
  OwnerDelegationReceipt,
  OwnerDelegationPermission,
  CreateOwnerDelegationParams,
  OwnerShareAction,
  OwnerShareDecryption,
  OwnerShareMatcher,
  OwnerSharePolicyV2,
  DelegatedShareKey,
  SignedDelegation,
  RegisterOwnerSharePolicyParams,
  OwnerSharePolicyRegistration,
  OwnerSharePolicyRegistrationReceipt,
} from "./owner-policy";

export {
  SHARE_DELIVERY_AUTHORIZATION_DOMAIN,
  validateShareDeliveryAuthorizationBytes,
  shareDeliveryTrustedKid,
} from "./share-delivery";
export type {
  ShareDeliveryAuthorizationRequest,
  ShareDeliveryAuthorization,
  ShareDeliveryAuthorizationReceipt,
  ValidateShareDeliveryAuthorizationExpected,
} from "./share-delivery";

export {
  MemorySenderShareRecordStorage,
  MemorySenderShareKeyStorage,
  SenderShareStore,
} from "./sender-share-store";

/** Lifecycle and authorization operations are delegated to the canonical
 * headless package so sdk-core cannot grow a second Share verifier. */
export {
  authorizeShare,
  authorizationMethodForTarget,
  notifyShare,
  revokeShare,
  listShares,
  showShare,
  publishTargetShare,
  publishPolicyShare,
  claimShare,
  resumeShareAuthorization,
  isLegacyShareLink,
  receiveLegacyShare,
  migrateShare,
  MemoryEncryptedShareHistoryStorage,
  EncryptedSenderShareHistory,
} from "@tinycloud/share-sdk";
export type {
  ShareAuthorizationMethod,
  ShareAuthorizationRequired,
  ShareAuthorizationDenied,
  ShareAuthorizationReady,
  ShareAuthorizationResult,
  ShareAuthorizationAdapter,
  ShareNotifyState,
  ShareNotifyResult,
  ShareDeliveryAdapter,
  ShareRevocationResult,
  ShareRevocationAdapter,
  ShareHistoryView,
  ShareTarget,
  TargetPublishInput,
  TargetPublishOutcome,
  TargetPublishAdapter,
  SharePolicyPublishAdapter,
  LegacyShareReader,
  LegacyMigrationResult,
  EncryptedShareHistoryStorage,
} from "@tinycloud/share-sdk";
export type {
  SenderShareRecord,
  SenderShareRecordStorage,
  SenderShareKeyStorage,
  SenderShareRevocationScope,
} from "./sender-share-store";
export type {
  ShareAccessV2,
  ShareListResult,
  ShareReadResult,
  ShareRecipientClientOptions,
  ShareNativeInvokeInput,
  ShareNativeInvokeResult,
  ShareNativeInvokeSuccessResult,
  ShareNativeInvokeErrorResult,
  ShareNativeAction,
  ShareWireAction,
  ShareAddressedRecipientMatcher,
  ShareContentSource,
  ShareKvContentSource,
  ShareSqlContentSource,
  ShareExpiryBounds,
  ShareAddressedDelegationRequestV2,
  ShareAddressedDelegationEnvelopeV2,
  ShareAddressedDelegationResponseV2,
  SharePolicySessionWireV1,
  SharePolicySessionV1,
  ShareReadInvocationV1,
  ShareNativeInvokeEnvelopeV1,
  ShareDetachedProof,
  ShareListEntry,
  SharePolicyBinding,
  SharePolicySession,
  ShareRecipientPolicy,
  ShareRecipientResult,
  ShareSaveOptions,
} from "./recipient-types";
export type { ShareNativeResponse } from "./recipient-types.schema";
export { ShareAccessError, ShareConflict } from "./recipient-types";

/**
 * Canonical headless Share foundation. The older SharingService and v2
 * artifact exports above remain compatibility adapters; new consumers should
 * use these package-owned codecs and redacted receive operations so browser
 * and Node callers share one verifier and one result taxonomy.
 */
export {
  inspectShare,
  receiveShare,
  ShareReceiveError,
  toShareErrorInfo,
  verifyBearerEnvelope,
} from "@tinycloud/share-sdk";
export type {
  ShareErrorCode,
  ShareErrorInfo,
  ShareFetchOptions,
  ShareInspection,
  ShareMetadata,
  ShareReceiveResult,
  VerifyBearerEnvelopeOptions,
} from "@tinycloud/share-sdk";
export {
  ShareActionSchema,
  ShareRecipientClientOptionsSchema,
  ShareRecipientPolicySchema,
  ShareRecipientTargetSchema,
  ShareResourceSchema,
  ShareNativeResponseSchema,
  ShareAddressedDelegationRequestV2Schema,
  ShareAddressedDelegationEnvelopeV2Schema,
  ShareAddressedDelegationResponseV2Schema,
} from "./recipient-types.schema";

// SharingService Schemas and Validation
export {
  EncodedShareDataSchema,
  ReceiveOptionsSchema,
  SharingServiceConfigSchema,
  validateEncodedShareData,
  validateReceiveOptions,
  validateSharingServiceConfig,
} from "./SharingService.schema.js";
