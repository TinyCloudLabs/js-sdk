/**
 * @tinycloud/sdk-core
 *
 * Core TinyCloud SDK package providing shared interfaces and the TinyCloud class.
 *
 * This package defines the platform-agnostic interfaces that both web-sdk and node-sdk
 * implement. The main TinyCloud class accepts an IUserAuthorization implementation,
 * allowing it to work in both browser and Node.js environments.
 *
 * @packageDocumentation
 */

// Platform-agnostic client types (canonical definitions)
export {
  ClientSession,
  EnsData,
  SiweConfig,
  ServerHost,
  ClientSessionSchema,
  EnsDataSchema,
  SiweConfigSchema,
  validateClientSession,
  SiweMessage,
} from "./client-types";

// Notification handler
export {
  INotificationHandler,
  SilentNotificationHandler,
} from "./notifications";

// ENS resolver
export { IENSResolver } from "./ens";

// WASM bindings abstraction
export {
  IWasmBindings,
  ISessionManager,
  type PersistedSessionProof,
  type ValidatedPersistedSessionProof,
} from "./wasm";

// Signer interface
export { ISigner, Bytes } from "./signer";

// Identity helpers
export {
  IdentityParseError,
  addressStorageKey,
  canonicalizeAddress,
  canonicalizeDid,
  canonicalizeDidUrl,
  didCacheKey,
  didEquals,
  isEvmAddress,
  makePkhSpaceId,
  parsePkhDid,
  pkhDid,
  principalDid,
  principalDidEquals,
  type CanonicalAddress,
  type DidCacheKeyOptions,
  type DidEqualsOptions,
  type PkhDidParts,
} from "./identity";

export {
  HOLDER_KEY_BINDING_PRESENTATION_SCHEMA,
  LISTEN_SQL_STATEMENT_CATALOG,
  POLICY_ENGINE_CHALLENGE_REQUEST_SCHEMA,
  POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA,
  POLICY_ENGINE_DENIAL_SCHEMA,
  POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES,
  POLICY_ENGINE_RESOLVE_REQUEST_SCHEMA,
  PORTABLE_DELEGATION_SCHEMA,
  REQUESTER_ENGINE_RETRY_ATTEMPTS,
  REQUESTER_ENGINE_RETRY_MAX_DELAY_MS,
  REQUESTER_NEAR_EXPIRY_SECONDS,
  TranscriptRequester,
  TranscriptRequesterError,
  createTranscriptRequester,
  deriveDelegationCid,
  parseNodeNativePortableDelegation,
  type HolderKeyBindingPresentation,
  type ListenSqlStatementName,
  type PolicyEngineGrantPresentationDenialCode,
  type PortableDelegation,
  type RequesterHttpRequest,
  type RequesterHttpResponse,
  type RequesterEndpointResolution,
  type RequesterInvocationCapability,
  type RequesterSigningCapability,
  type RequesterTransport,
  type TranscriptRequesterErrorCode,
  type TranscriptRequesterErrorState,
  type TranscriptRequesterOptions,
  type TranscriptRequesterReadKvResult,
  type TranscriptRequesterReadSqlResult,
} from "./requester";

// Encryption network identity helpers
export {
  canonicalizeNetworkId,
  parseCanonicalNetworkId,
  type CanonicalParsedNetworkId,
} from "./networkId";

// Session storage interface and types
export {
  // Interface
  ISessionStorage,
  // Types (derived from Zod schemas)
  PersistedSessionData,
  PersistedTinyCloudSession,
  TinyCloudSession,
  ValidationError,
  // Validation
  validatePersistedSessionData,
} from "./storage";

// User authorization interface and types
export {
  IUserAuthorization,
  Extension,
  PartialSiweMessage,
  UserAuthorizationConfig,
} from "./userAuthorization";
export type { SignInOptions } from "./userAuthorization";

// Main TinyCloud class
export { TinyCloud, TinyCloudConfig } from "./TinyCloud";

// Account-level app registry, delegation, and materialized index helpers
export { AccountService } from "./account/AccountService";
export type {
  AccountApplication,
  AccountApplicationListOptions,
  AccountDelegation,
  AccountDelegationListOptions,
  AccountDelegationRevokeOptions,
  AccountIndexEnsureResult,
  AccountIndexRebuildResult,
  AccountIndexStatus,
  AccountIndexedReadOptions,
  AccountServiceConfig,
  AccountSpace,
  AccountSpaceListOptions,
  AccountStatus,
} from "./account/AccountService";

// Re-export service types from sdk-services for convenience
export {
  // Context
  ServiceContext,
  type ServiceContextConfig,
  type IServiceContext,
  // Service types
  type IService,
  // KV Service
  KVService,
  PrefixedKVService,
  type IKVService,
  type IPrefixedKVService,
  type KVServiceConfig,
  type KVGetOptions,
  type KVPutOptions,
  type KVListOptions,
  type KVDeleteOptions,
  type KVHeadOptions,
  type KVCreateSignedReadUrlOptions,
  type KVResponse,
  type KVListResponse,
  type KVSignedReadUrlResponse,
  type KVResponseHeaders,
  // Result pattern
  type Result,
  ok,
  err,
  serviceError,
  ErrorCodes,
  type ErrorCode,
  type ServiceError,
  // Session
  type ServiceSession,
  // Platform dependencies
  type InvokeFunction,
  type InvokeAnyFunction,
  type InvokeAnyEntry,
  type FetchFunction,
  type TelemetryConfig,
  type TelemetryEventHandler,
  TinyCloudDebugLogger,
  tinyCloudDebugLogger,
  enableTinyCloudDebug,
  disableTinyCloudDebug,
  getTinyCloudDebugLogs,
  clearTinyCloudDebugLogs,
  installTinyCloudDebugGlobals,
  type TinyCloudDebugEvent,
  type TinyCloudDebugLevel,
  type TinyCloudDebugEnableOptions,
  type TinyCloudDebugTimer,
  // Retry
  type RetryPolicy,
  defaultRetryPolicy,
  // SQL Service
  SQLService,
  DatabaseHandle,
  SQLAction,
  type ISQLService,
  type IDatabaseHandle,
  type SQLServiceConfig,
  type SqlValue,
  type SqlStatement,
  type QueryOptions,
  type ExecuteOptions,
  type BatchOptions,
  type QueryResponse,
  type ExecuteResponse,
  type BatchResponse,
  type SQLActionType,
  // DuckDB Service
  DuckDbService,
  DuckDbDatabaseHandle,
  DuckDbAction,
  type IDuckDbService,
  type IDuckDbDatabaseHandle,
  type DuckDbServiceConfig,
  type DuckDbQueryOptions,
  type DuckDbExecuteOptions,
  type DuckDbBatchOptions,
  type DuckDbOptions,
  type DuckDbValue,
  type DuckDbStatement,
  type DuckDbQueryResponse,
  type DuckDbExecuteResponse,
  type DuckDbBatchResponse,
  type DuckDbActionType,
  type SchemaInfo,
  type TableInfo,
  type ColumnInfo,
  type ViewInfo,
  // Hooks Service
  HooksService,
  type IHooksService,
  type HookServiceName,
  type HookSubscription,
  type HookEvent,
  type HookStreamEvent,
  type HookWebhookScope,
  type HookWebhookRegistration,
  type HookWebhookRecord,
  type HookWebhookListOptions,
  type HookWebhookUnregisterOptions,
  type SubscribeOptions,
  type HooksServiceConfig,
  // Vault Service
  DataVaultService,
  VaultHeaders,
  VaultPublicSpaceKVActions,
  createVaultCrypto,
  type IDataVaultService,
  type VaultCrypto,
  type WasmVaultFunctions,
  type DataVaultConfig,
  type VaultPutOptions,
  type VaultGetOptions,
  type VaultListOptions,
  type VaultGrantOptions,
  type VaultEntry,
  type VaultNetworkReadResult,
  type VaultError,
  // Secrets Service
  SecretsService,
  SECRET_NAME_RE,
  canonicalizeSecretScope,
  resolveSecretListPrefix,
  resolveSecretPath,
  type ISecretsService,
  type SecretPayload,
  type SecretsError,
  type ResolvedSecretPath,
  type SecretScopeOptions,
  // Encryption Service (network-scoped)
  EncryptionService,
  DecryptTransportResponseError,
  parseNetworkId,
  buildNetworkId,
  isNetworkId,
  networkDiscoveryKey,
  NetworkIdError,
  ENCRYPTION_NETWORK_URN_PREFIX,
  NETWORK_NAME_PATTERN,
  canonicalizeEncryptionJson,
  canonicalHashHex,
  hexEncode,
  hexDecode,
  base64Encode as encryptionBase64Encode,
  base64Decode as encryptionBase64Decode,
  utf8Encode as encryptionUtf8Encode,
  utf8Decode as encryptionUtf8Decode,
  encryptToNetwork,
  decryptEnvelopeWithKey,
  validateEnvelope,
  generateRandomReceiverKey,
  deriveSignedReceiverKey,
  buildCanonicalDecryptRequest,
  buildDecryptFacts,
  buildDecryptAttenuation,
  buildDecryptInvocation,
  checkDecryptInvocationInput,
  verifyDecryptResponse,
  canonicalSignedResponse,
  openWrappedKey,
  discoverNetwork,
  ensureNetworkUsableForDecrypt,
  DEFAULT_ENCRYPTION_ALG,
  ENVELOPE_VERSION,
  DEFAULT_KEY_VERSION,
  DECRYPT_FACT_TYPE,
  DECRYPT_RESULT_TYPE,
  DECRYPT_ACTION,
  ENCRYPTION_SERVICE,
  ENCRYPTION_SERVICE_SHORT,
  encryptionError,
  type IEncryptionService,
  type EncryptionServiceConfig,
  type DecryptTransport,
  type EncryptToNetworkOptions,
  type DecryptEnvelopeOptions,
  type ParsedNetworkId,
  type BuildDecryptInvocationInput,
  type BuiltDecryptInvocation,
  type CanonicalJson,
  type DecryptCapabilityProof,
  type DecryptInvocationFact,
  type DecryptInvocationSigner,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type EncryptionError,
  type EncryptionErrorInput,
  type InlineEncryptedEnvelope,
  type NetworkDescriptor,
  type ReceiverKeyPair,
  type ReceiverKeySigner,
  type EncryptToNetworkInput,
  type EncryptToNetworkResult,
  type CanonicalDecryptRequest,
  type BuildCanonicalDecryptRequestInput,
  type BuildDecryptFactsInput,
  type RandomReceiverKeyInput,
  type SignedReceiverKeyInput,
  type VerifyDecryptResponseInput,
  type DiscoverNetworkInput,
  type DiscoveredNetwork,
  type DiscoverySource,
  type NodeDescriptorFetcher,
  type WellKnownDescriptorFetcher,
} from "@tinycloud/sdk-services";

// Space utilities
export {
  SpaceHostResult,
  fetchPeerId,
  submitHostDelegation,
  activateSessionWithHost,
} from "./space";

// Delegations
export {
  // Result pattern (aliased to avoid conflict with sdk-services Result)
  Result as DelegationResult,
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
  CreateDelegationWasmParams,
  CreateDelegationWasmResult,
  DelegatedResource,
  DelegationChain,
  DelegationApiResponse,
  // Configuration types
  DelegationManagerConfig,
  KeyProvider,
  // Classes
  DelegationManager,
  // v2 SharingService
  SharingService,
  createSharingService,
  ISharingService,
  SharingServiceConfig,
  EncodedShareData,
  ReceiveOptions,
  ShareAccess,
  DelegateReceivedShareParams,
  DelegatedShareAccess,
  // v2 types
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
} from "./delegations";

// Authorization (v2 spec)
export {
  // Class
  CapabilityKeyRegistry,
  // Interface
  ICapabilityKeyRegistry,
  // Factory
  createCapabilityKeyRegistry,
  // Types
  StoredDelegationChain,
  // Error codes
  CapabilityKeyRegistryErrorCodes,
  CapabilityKeyRegistryErrorCode,
  // SignStrategy types
  SignRequest,
  SignResponse,
  SignCallback,
  OpenKeySigningStrategyOptions,
  OpenKeySigningRequestBody,
  OpenKeySigningResponseBody,
  OpenKeyCallbackStrategy,
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  EventEmitterStrategy,
  SignStrategy,
  defaultSignStrategy,
  createOpenKeyCallbackSigningStrategy,
  // Space creation handler types
  SpaceCreationContext,
  ISpaceCreationHandler,
  AutoApproveSpaceCreationHandler,
  defaultSpaceCreationHandler,
} from "./authorization";

// Spaces (v2 spec)
export {
  // Space object
  Space,
  ISpace,
  SpaceConfig,
  ISpaceScopedDelegations,
  ISpaceScopedSharing,
  // SpaceService
  SpaceService,
  ISpaceService,
  SpaceServiceConfig,
  SpaceErrorCodes,
  SpaceErrorCode,
  createSpaceService,
  // URI utilities
  parseSpaceUri,
  buildSpaceUri,
  // Public space utility
  makePublicSpaceId,
  // Delegation creation types
  SpaceDelegationParams,
  CreateDelegationFunction,
} from "./spaces";

// Protocol version checking
export {
  ProtocolMismatchError,
  VersionCheckError,
  UnsupportedFeatureError,
  checkNodeInfo,
} from "./version";
export type { NodeInfo } from "./version";

// Manifest types and resolution (capability chain delegation)
export {
  // Types
  type Manifest,
  type ManifestDefaults,
  type ManifestKnowledge,
  type ManifestSecretActions,
  type ComposeManifestOptions,
  type ComposedManifestRequest,
  type ManifestRegistryRecord,
  type PermissionEntry,
  type ResolvedCapabilities,
  type ResolvedDelegate,
  type ResourceCapability,
  type SpaceAbilitiesMap,
  // Errors
  ManifestValidationError,
  // Constants
  ACCOUNT_REGISTRY_PATH,
  ACCOUNT_REGISTRY_SPACE,
  DEFAULT_DEFAULTS,
  DEFAULT_EXPIRY,
  DEFAULT_KNOWLEDGE_ROOT,
  DEFAULT_MANIFEST_SPACE,
  DEFAULT_MANIFEST_VERSION,
  SECRETS_SPACE,
  SERVICE_LONG_TO_SHORT,
  SERVICE_SHORT_TO_LONG,
  VAULT_PERMISSION_SERVICE,
  ENCRYPTION_PERMISSION_SERVICE,
  ENCRYPTION_MANIFEST_SPACE,
  // Types
  type AbilitiesMap,
  // Functions
  applyPrefix,
  composeManifestRequest,
  expandActionShortNames,
  expandPermissionEntries,
  expandPermissionEntry,
  loadManifest,
  manifestAbilitiesUnion,
  normalizeDefaults,
  parseExpiry,
  resolveManifestKnowledgeRoot,
  resolveManifest,
  resourceCapabilitiesToAbilitiesMap,
  resourceCapabilitiesToSpaceAbilitiesMap,
  validateManifest,
} from "./manifest";

export {
  ACCOUNT_INDEX_SCHEMA,
  BOOTSTRAP_ALLOWLIST,
  BOOTSTRAP_DEFAULT_SPACE,
  BOOTSTRAP_ENCRYPTION_NETWORK_NAME,
  BOOTSTRAP_ENCRYPTION_NETWORK_RESOURCE_TEMPLATE,
  BOOTSTRAP_MANIFEST,
  BOOTSTRAP_PERSISTED_APPLICATION_MANIFESTS,
  BOOTSTRAP_PUBLIC_SPACE,
  BOOTSTRAP_SESSION_REQUESTS,
  BOOTSTRAP_SPACE_MANIFESTS,
  BOOTSTRAP_SPACE_NAMES,
  SECRET_RECORDS_SCHEMA,
  TINYCLOUD_ACCOUNT_SPACE_MANIFEST,
  TINYCLOUD_APPLICATIONS_SPACE_MANIFEST,
  TINYCLOUD_DEFAULT_SPACE_MANIFEST,
  TINYCLOUD_PUBLIC_SPACE_MANIFEST,
  TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
  bootstrapEncryptionNetworkId,
  bootstrapSpaceId,
  bootstrapSteps,
  composeBootstrapSpaceManifest,
  KV,
  SQL,
  DUCKDB,
  CAPABILITIES,
  HOOKS,
  ENCRYPTION,
  SPACE,
  CAPABILITY_REGISTRY,
  type CapabilityRegistryEntry,
  type CapabilityStatus,
  type BootstrapAllowlistEntry,
  type BootstrapAllowlistKind,
  type BootstrapEncryptionNetworkStep,
  type BootstrapManifest,
  type BootstrapRawAbilityAllowlistEntry,
  type BootstrapSchemaStep,
  type BootstrapSeedApplicationsStep,
  type BootstrapSeedSpacesStep,
  type BootstrapSpaceDescriptor,
  type BootstrapSpaceName,
  type BootstrapSpaceStep,
  type BootstrapStep,
  type BootstrapStepKind,
} from "@tinycloud/bootstrap";

// TinyCloud location registry helpers
export {
  CloudLocationResolutionError,
  DEFAULT_LOCAL_NODE_URL,
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  LOCAL_LINK_HOST_SUFFIX,
  LOCAL_LINK_PROBE_TIMEOUT_MS,
  LOCAL_LOOPBACK_PROBE_TIMEOUT_MS,
  LocationRecordValidationError,
  canonicalLocationPayload,
  createInMemoryLocalNodeIdentityStore,
  discoverLocalTinyCloudNode,
  fetchLocationRecord,
  httpUrlToMultiaddr,
  locationPayloadForRecord,
  multiaddrToHttpUrl,
  resolveCloudLocation,
  resolveTinyCloudHosts,
  signLocationRecord,
  validateLocationRecord,
  validateLocationRecordPayload,
  verifyDidKeyEd25519Signature,
  verifyLocationRecord,
  type DiscoverLocalTinyCloudNodeOptions,
  type DiscoveredLocalTinyCloudNode,
  type LocalNodeIdentityStore,
  type LocationCandidate,
  type LocationCandidateInput,
  type LocationRecord,
  type LocationRecordPayload,
  type LocationRecordSigner,
  type LocationResolutionAttempt,
  type LocationSource,
  type ResolveCloudLocationOptions,
  type ResolveTinyCloudHostsOptions,
  type ResolvedCloudLocation,
  type ResolvedTinyCloudHosts,
} from "./location";

// Capability subset checking and recap parsing
export {
  // Errors
  CaveatedDelegationUnsupportedError,
  PermissionNotInManifestError,
  SessionExpiredError,
  // Functions
  isCapabilitySubset,
  actionContains,
  canonicalizeRecapCaveats,
  parseRecapCapabilities,
  recapCaveatsEqual,
  // Types
  type ParseRecapFromSiwe,
  type SubsetCheckResult,
  type WasmRecapEntry,
} from "./capabilities";

// Default lifetimes for delegation flows. See `expiry.ts` for the
// "pick a tier, not a number" rationale.
export {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  EXPIRY,
  type ExpiryTier,
} from "./expiry";

// Policy signed-object profile core
export {
  ED25519_JCS_SIGNATURE_SUITE,
  EIP191_JCS_SIGNATURE_SUITE,
  POLICY_ENGINE_RECORD_SCHEMA,
  POLICY_SCHEMA,
  POLICY_STATUS_SCHEMA,
  SignatureMaterialError,
  SignatureVerificationError,
  SignedObjectCanonicalizationError,
  SignedObjectDigestError,
  SignedObjectIdError,
  SignedObjectProfileError,
  SignedObjectSchemaError,
  SigningKeyBindingError,
  UnsupportedSignatureSuiteError,
  canonicalizeSignedObjectUnsigned,
  createAndSignPolicy,
  createAndSignPolicyEngineRecord,
  createAndSignPolicyStatus,
  createAndSignSignedObject,
  deriveSignedObjectMaterial,
  jcsCanonicalize,
  normalizeJson,
  serializeJcsJson,
  signedObjectIdFor,
  toSignedObjectError,
  validatePolicyEngineRecordSigned,
  validatePolicyEngineRecordSignedShape,
  validatePolicyEngineRecordUnsigned,
  validatePolicySigned,
  validatePolicySignedShape,
  validatePolicyStatusSigned,
  validatePolicyStatusSignedShape,
  validatePolicyStatusUnsigned,
  validatePolicyUnsigned,
  verifyPolicy,
  verifyPolicyEngineRecord,
  verifyPolicyStatus,
  verifySignedObject,
  type JsonObject,
  type JsonValue,
  type Policy,
  type PolicyEngineRecord,
  type PolicyStatus,
  type SignatureSuite,
  type SignedObjectErrorCode,
  type SignedObjectKind,
  type SignedObjectMaterial,
  type SignedObjectSignature,
  type SignedObjectSigner,
  type SignedObjectVerificationResult,
  type SignedPolicyObject,
  type UnsignedPolicy,
  type UnsignedPolicyEngineRecord,
  type UnsignedPolicyObject,
  type UnsignedPolicyStatus,
} from "./policy";
