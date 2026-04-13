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
export { IWasmBindings, ISessionManager } from "./wasm";

// Signer interface
export { ISigner, Bytes } from "./signer";

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
  type KVResponse,
  type KVListResponse,
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
  type VaultError,
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
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  EventEmitterStrategy,
  SignStrategy,
  defaultSignStrategy,
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
  type ManifestDelegation,
  type PermissionEntry,
  type ResolvedCapabilities,
  type ResolvedDelegate,
  type ResourceCapability,
  // Errors
  ManifestValidationError,
  // Constants
  DEFAULT_DEFAULTS,
  DEFAULT_EXPIRY,
  SERVICE_LONG_TO_SHORT,
  SERVICE_SHORT_TO_LONG,
  // Types
  type AbilitiesMap,
  // Functions
  applyPrefix,
  expandActionShortNames,
  loadManifest,
  manifestAbilitiesUnion,
  normalizeDefaults,
  parseExpiry,
  resolveManifest,
  resourceCapabilitiesToAbilitiesMap,
  validateManifest,
} from "./manifest";

// Capability subset checking and recap parsing
export {
  // Errors
  PermissionNotInManifestError,
  SessionExpiredError,
  // Functions
  isCapabilitySubset,
  parseRecapCapabilities,
  // Types
  type ParseRecapFromSiwe,
  type SubsetCheckResult,
  type WasmRecapEntry,
} from "./capabilities";
