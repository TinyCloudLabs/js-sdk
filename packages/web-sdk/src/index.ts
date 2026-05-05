// Main class and config
export { TinyCloudWeb, Config, ShareReceiveResult } from './modules/tcw';

// Browser Adapters
export {
  BrowserWalletSigner,
  BrowserSessionStorage,
  BrowserENSResolver,
  BrowserNotificationHandler,
  BrowserWasmBindings,
} from './adapters';

// Auth module (browser-specific strategies)
export {
  ModalSpaceCreationHandler,
  defaultWebSpaceCreationHandler,
} from './authorization';

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
  defaultSignStrategy,
  ISpaceCreationHandler,
  SpaceCreationContext,
  AutoApproveSpaceCreationHandler,
  defaultSpaceCreationHandler,
} from '@tinycloud/sdk-core';

// Re-exports from providers (browser/Web3-specific, formerly in web-core)
export * from './providers';

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
} from '@tinycloud/sdk-core';
export type { SignInOptions } from '@tinycloud/sdk-core';

// Re-export KV service types for direct usage
export {
  IKVService,
  KVService,
  KVResponse,
  PrefixedKVService,
  IPrefixedKVService,
} from '@tinycloud/sdk-core';

// Hooks service
export {
  HooksService,
} from '@tinycloud/sdk-core';
export type {
  IHooksService,
  HookSubscription,
  HookEvent,
  HookStreamEvent,
  SubscribeOptions,
  HooksServiceConfig,
} from '@tinycloud/sdk-core';

// Re-export delegation types and services from sdk-core
export {
  // DelegationManager
  DelegationManager,
  DelegationManagerConfig,
  // Delegation types
  Delegation,
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
} from '@tinycloud/sdk-core';

// Re-export CapabilityKeyRegistry from sdk-core
export {
  CapabilityKeyRegistry,
  ICapabilityKeyRegistry,
  createCapabilityKeyRegistry,
  StoredDelegationChain,
  CapabilityKeyRegistryErrorCodes,
  CapabilityKeyRegistryErrorCode,
} from '@tinycloud/sdk-core';

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
} from '@tinycloud/sdk-core';

// Protocol version checking
export {
  ProtocolMismatchError,
  VersionCheckError,
  UnsupportedFeatureError,
  checkNodeInfo,
} from '@tinycloud/sdk-core';

// Re-export Vault service types from sdk-core
export {
  DataVaultService,
  VaultPublicSpaceKVActions,
  createVaultCrypto,
  SecretsService,
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
  type VaultError,
  type ISecretsService,
  type SecretPayload,
  type SecretsError,
} from '@tinycloud/sdk-core';

// Adapter for web-sdk
export { createKVService } from './modules/Storage/tinycloud/KVServiceAdapter';

// Delegation Transport Types (re-exported from node-sdk for compatibility)
export {
  DelegatedAccess,
  serializeDelegation,
  deserializeDelegation,
} from '@tinycloud/node-sdk/core';
export type { PortableDelegation } from '@tinycloud/node-sdk/core';

// TinyCloudNode re-export (for advanced usage)
export {
  TinyCloudNode,
  type TinyCloudNodeConfig,
  type DelegateToOptions,
  type DelegateToResult,
  type RuntimePermissionGrantOptions,
} from '@tinycloud/node-sdk/core';

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
  // Errors raised by delegateTo / requestPermissions.
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
  parseExpiry,
  resourceCapabilitiesToSpaceAbilitiesMap,
} from '@tinycloud/sdk-core';
