// Main class and config
export {
  TinyCloudWeb,
  type Config,
  type ShareReceiveResult,
  type SessionRestoreResult,
  type SessionRestoreStatus,
} from "./modules/tcw";
export {
  establishOpenKeySession,
  type EstablishOpenKeySessionOptions,
  type EstablishOpenKeySessionResult,
  type EstablishOpenKeySessionStatus,
} from "./openkey-session";
export type { SecretReadInput, SecretReadResult } from "@tinycloud/node-sdk";
export type {
  CreateOwnerDelegationParams,
  OwnerDelegationReceipt,
  RegisterOwnerSharePolicyParams,
  OwnerSharePolicyRegistrationReceipt,
} from "@tinycloud/sdk-core";

// Browser Adapters
export {
  BrowserWalletSigner,
  BrowserSessionStorage,
  BrowserENSResolver,
  BrowserNotificationHandler,
  BrowserWasmBindings,
} from "./adapters";
export type {
  BrowserSessionLoadResult,
  BrowserSessionLoadStatus,
  BrowserSessionStorageOptions,
} from "./adapters";

// Auth module (browser-specific strategies)
export {
  ModalSpaceCreationHandler,
  type ModalSpaceCreationHandlerOptions,
  type SpaceCreationHandlerConfig,
  SpaceCreationTimeoutError,
  DEFAULT_SPACE_CREATION_TIMEOUT_MS,
  defaultWebSpaceCreationHandler,
  resolveSpaceCreationHandler,
} from "./authorization/WebSpaceCreationHandler";

// Observability for prompts the SDK is blocked on
export {
  AWAITING_USER_INPUT_ATTRIBUTE,
  AWAITING_USER_INPUT_EVENT,
  AWAITING_USER_INPUT_RESOLVED_EVENT,
  type AwaitingUserInputDetail,
  type AwaitingUserInputOutcome,
  type AwaitingUserInputResolvedDetail,
  pendingUserInputKind,
} from "./notifications/awaitingUserInput";

// Re-export sdk-core authorization types used by the new auth module
export {
  type SignStrategy,
  type SignRequest,
  type SignResponse,
  type SignCallback,
  type AutoSignStrategy,
  type AutoRejectStrategy,
  type CallbackStrategy,
  type EventEmitterStrategy,
  type OpenKeySigningStrategyOptions,
  type OpenKeySigningRequestBody,
  type OpenKeySigningResponseBody,
  type OpenKeyCallbackStrategy,
  defaultSignStrategy,
  createOpenKeyCallbackSigningStrategy,
  type ISpaceCreationHandler,
  type SpaceCreationContext,
  AutoApproveSpaceCreationHandler,
  defaultSpaceCreationHandler,
} from "@tinycloud/sdk-core";

// Re-exports from providers (browser/Web3-specific, formerly in web-core)
export * from "./providers";

// Re-exports from sdk-core (platform-agnostic types)
export {
  // Session and auth types
  type ClientSession,
  type SiweConfig,
  type EnsData,
  SiweMessage,
  type ServerHost,
  type Extension,
  // Schemas and validation
  ClientSessionSchema,
  EnsDataSchema,
  SiweConfigSchema,
  validateClientSession,
  // Core interfaces
  TinyCloud,
  type ISigner,
  type ISessionStorage,
  type IUserAuthorization as ICoreUserAuthorization,
  type PersistedSessionData,
  type PartialSiweMessage,
  AccountService,
  TinyCloudDebugLogger,
  tinyCloudDebugLogger,
  enableTinyCloudDebug,
  disableTinyCloudDebug,
  getTinyCloudDebugLogs,
  clearTinyCloudDebugLogs,
  installTinyCloudDebugGlobals,
} from "@tinycloud/sdk-core";
export type {
  OwnerShareAction,
  OwnerShareMatcher,
  OwnerSharePolicyV2,
  DelegatedShareKey,
  SignedDelegation,
  OwnerSharePolicyRegistration,
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
  SignInOptions,
  TinyCloudDebugEvent,
  TinyCloudDebugLevel,
  TinyCloudDebugEnableOptions,
  TinyCloudDebugTimer,
} from "@tinycloud/sdk-core";

// Re-export KV service types for direct usage
export {
  KVService,
  PrefixedKVService,
  type IKVService,
  type KVResponse,
  type IPrefixedKVService,
} from "@tinycloud/sdk-core";

// Hooks service
export { HooksService } from "@tinycloud/sdk-core";
export type {
  IHooksService,
  HookSubscription,
  HookEvent,
  HookStreamEvent,
  SubscribeOptions,
  HooksServiceConfig,
} from "@tinycloud/sdk-core";

// Re-export delegation types and services from sdk-core
export {
  // DelegationManager
  DelegationManager,
  type DelegationManagerConfig,
  // Delegation types
  type Delegation,
  type DelegationRevocationReceipt,
  type AccountDelegationResource,
  type AccountDelegationRecord,
  type AccountDelegationPage,
  type AccountDelegationQueryOptions,
  type CreateDelegationParams,
  type DelegationChain,
  type DelegationApiResponse,
  type DelegationResult,
  type DelegationError,
  DelegationErrorCodes,
  type DelegationErrorCode,
  // SharingService
  SharingService,
  createSharingService,
  type ISharingService,
  type SharingServiceConfig,
  type EncodedShareData,
  type ReceiveOptions,
  type ShareAccess,
  type DelegateReceivedShareParams,
  type DelegatedShareAccess,
  // Key and delegation record types
  type JWK,
  type KeyType,
  type KeyInfo,
  type CapabilityEntry,
  type DelegationRecord,
  type DelegationChainV2,
  type DelegationDirection,
  type DelegationFilters,
  type SpaceOwnership,
  type SpaceInfo,
  type ShareSchema,
  type ShareLink,
  type ShareLinkData,
  type IngestOptions,
  type GenerateShareParams,
  createDelegatedShareKey,
  createPolicyEnforcementDelegation,
  canonicalOwnerSharePolicy,
  computeOwnerShareRegistrationCid,
  validateOwnerSharePolicyRegistration,
  MAX_CONTENT_BYTES,
} from "@tinycloud/sdk-core";

// Re-export CapabilityKeyRegistry from sdk-core
export {
  CapabilityKeyRegistry,
  type ICapabilityKeyRegistry,
  createCapabilityKeyRegistry,
  type StoredDelegationChain,
  CapabilityKeyRegistryErrorCodes,
  type CapabilityKeyRegistryErrorCode,
} from "@tinycloud/sdk-core";

// Re-export SpaceService from sdk-core
export {
  SpaceService,
  type ISpaceService,
  type SpaceServiceConfig,
  SpaceErrorCodes,
  type SpaceErrorCode,
  createSpaceService,
  parseSpaceUri,
  buildSpaceUri,
  makePublicSpaceId,
  // Space object
  Space,
  type ISpace,
  type SpaceConfig,
  type ISpaceScopedDelegations,
  type ISpaceScopedSharing,
} from "@tinycloud/sdk-core";

// Protocol version checking
export {
  ProtocolMismatchError,
  VersionCheckError,
  UnsupportedFeatureError,
  checkNodeInfo,
} from "@tinycloud/sdk-core";

// Re-export Vault service types from sdk-core
export {
  DataVaultService,
  VaultPublicSpaceKVActions,
  createVaultCrypto,
  SecretsService,
  SECRET_NAME_RE,
  canonicalizeSecretScope,
  resolveSecretListPrefix,
  resolveSecretPath,
  type WasmVaultFunctions,
  type VaultHeaders,
  type IDataVaultService,
  type VaultCrypto,
  type DataVaultConfig,
  type VaultPutOptions,
  type VaultGetOptions,
  type VaultListOptions,
  type VaultGrantOptions,
  type VaultEntry,
  type VaultNetworkReadResult,
  type VaultError,
  type ISecretsService,
  type SecretPayload,
  type SecretsError,
  type ResolvedSecretPath,
  type SecretScopeOptions,
} from "@tinycloud/sdk-core";

// Re-export encryption service types and helpers from sdk-core
export {
  EncryptionService,
  DecryptTransportResponseError,
  canonicalizeNetworkId,
  parseNetworkId,
  parseCanonicalNetworkId,
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
  encryptionBase64Encode,
  encryptionBase64Decode,
  encryptionUtf8Encode,
  encryptionUtf8Decode,
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
} from "@tinycloud/sdk-core";
export type {
  IEncryptionService,
  EncryptionServiceConfig,
  DecryptTransport,
  EncryptToNetworkOptions,
  DecryptEnvelopeOptions,
  ParsedNetworkId,
  BuildDecryptInvocationInput,
  BuiltDecryptInvocation,
  CanonicalJson,
  DecryptCapabilityProof,
  DecryptInvocationFact,
  DecryptInvocationSigner,
  DecryptRequestBody,
  DecryptResponseBody,
  EncryptionCrypto,
  EncryptionError,
  EncryptionErrorInput,
  InlineEncryptedEnvelope,
  NetworkDescriptor,
  ReceiverKeyPair,
  ReceiverKeySigner,
  EncryptToNetworkInput,
  EncryptToNetworkResult,
  CanonicalDecryptRequest,
  BuildCanonicalDecryptRequestInput,
  BuildDecryptFactsInput,
  RandomReceiverKeyInput,
  SignedReceiverKeyInput,
  VerifyDecryptResponseInput,
  DiscoverNetworkInput,
  DiscoveredNetwork,
  DiscoverySource,
  NodeDescriptorFetcher,
  WellKnownDescriptorFetcher,
} from "@tinycloud/sdk-core";

// Adapter for web-sdk
export { createKVService } from "./modules/Storage/tinycloud/KVServiceAdapter";

// Delegation Transport Types (re-exported from node-sdk for compatibility)
export {
  DelegatedAccess,
  serializeDelegation,
  deserializeDelegation,
} from "@tinycloud/node-sdk/core";
export type { PortableDelegation } from "@tinycloud/node-sdk/core";

// TinyCloudNode re-export (for advanced usage)
export {
  TinyCloudNode,
  type TinyCloudNodeConfig,
  type DelegateToOptions,
  type DelegateToResult,
  type RuntimePermissionGrantOptions,
} from "@tinycloud/node-sdk/core";

// Capability-chain delegation types and errors (spec: .claude/specs/capability-chain.md)
export {
  // Manifest shapes — PermissionEntry is what callers pass to delegateTo.
  type Manifest,
  type ManifestDefaults,
  type ManifestSecretActions,
  type ComposeManifestOptions,
  type ComposedManifestRequest,
  type ManifestRegistryRecord,
  type PermissionEntry,
  type ResolvedCapabilities,
  type ResolvedDelegate,
  type ResourceCapability,
  type SpaceAbilitiesMap,
  ACCOUNT_REGISTRY_PATH,
  ACCOUNT_REGISTRY_SPACE,
  DEFAULT_MANIFEST_SPACE,
  DEFAULT_MANIFEST_VERSION,
  VAULT_PERMISSION_SERVICE,
  // Errors raised by delegateTo / requestPermissions.
  CaveatedDelegationUnsupportedError,
  PermissionNotInManifestError,
  SessionExpiredError,
  ManifestValidationError,
  // Resolution + subset helpers for apps that want to compose manifests
  // at runtime.
  composeManifestRequest,
  resolveManifest,
  validateManifest,
  loadManifest,
  isCapabilitySubset,
  expandActionShortNames,
  expandPermissionEntries,
  expandPermissionEntry,
  parseExpiry,
  resourceCapabilitiesToSpaceAbilitiesMap,
} from "@tinycloud/sdk-core";
