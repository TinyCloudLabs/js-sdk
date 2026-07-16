// Main class and config
export {
  TinyCloudWeb,
  Config,
  ShareReceiveResult,
  SessionRestoreResult,
  SessionRestoreStatus,
} from "./modules/tcw";
export type { SecretReadInput, SecretReadResult } from "@tinycloud/node-sdk";

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
  defaultWebSpaceCreationHandler,
} from "./authorization";

// Re-export sdk-core authorization types used by the new auth module
export {
  SignStrategy,
  SignRequest,
  SignResponse,
  SignCallback,
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  EventEmitterStrategy,
  OpenKeySigningStrategyOptions,
  OpenKeySigningRequestBody,
  OpenKeySigningResponseBody,
  OpenKeyCallbackStrategy,
  defaultSignStrategy,
  createOpenKeyCallbackSigningStrategy,
  ISpaceCreationHandler,
  SpaceCreationContext,
  AutoApproveSpaceCreationHandler,
  defaultSpaceCreationHandler,
} from "@tinycloud/sdk-core";

// Re-exports from providers (browser/Web3-specific, formerly in web-core)
export * from "./providers";

// Re-exports from sdk-core (platform-agnostic types)
export {
  // Session and auth types
  ClientSession,
  SiweConfig,
  EnsData,
  SiweMessage,
  ServerHost,
  Extension,
  // Schemas and validation
  ClientSessionSchema,
  EnsDataSchema,
  SiweConfigSchema,
  validateClientSession,
  // Core interfaces
  TinyCloud,
  ISigner,
  ISessionStorage,
  IUserAuthorization as ICoreUserAuthorization,
  PersistedSessionData,
  PartialSiweMessage,
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
  IKVService,
  KVService,
  KVResponse,
  PrefixedKVService,
  IPrefixedKVService,
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
  DelegationManagerConfig,
  // Delegation types
  Delegation,
  DelegationRevocationReceipt,
  AccountDelegationResource,
  AccountDelegationRecord,
  AccountDelegationPage,
  AccountDelegationQueryOptions,
  CreateDelegationParams,
  DelegationChain,
  DelegationApiResponse,
  DelegationResult,
  DelegationError,
  DelegationErrorCodes,
  DelegationErrorCode,
  // SharingService
  SharingService,
  createSharingService,
  ISharingService,
  SharingServiceConfig,
  EncodedShareData,
  ReceiveOptions,
  ShareAccess,
  DelegateReceivedShareParams,
  DelegatedShareAccess,
  // Key and delegation record types
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
} from "@tinycloud/sdk-core";

// Re-export CapabilityKeyRegistry from sdk-core
export {
  CapabilityKeyRegistry,
  ICapabilityKeyRegistry,
  createCapabilityKeyRegistry,
  StoredDelegationChain,
  CapabilityKeyRegistryErrorCodes,
  CapabilityKeyRegistryErrorCode,
} from "@tinycloud/sdk-core";

// Re-export SpaceService from sdk-core
export {
  SpaceService,
  ISpaceService,
  SpaceServiceConfig,
  SpaceErrorCodes,
  SpaceErrorCode,
  createSpaceService,
  parseSpaceUri,
  buildSpaceUri,
  makePublicSpaceId,
  // Space object
  Space,
  ISpace,
  SpaceConfig,
  ISpaceScopedDelegations,
  ISpaceScopedSharing,
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
