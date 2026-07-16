/**
 * @tinycloud/node-sdk/core
 *
 * Platform-agnostic entry point for TinyCloud node-sdk.
 *
 * This entry point excludes Node.js-specific modules that depend on
 * @tinycloud/node-sdk-wasm (PrivateKeySigner, NodeWasmBindings), making it
 * safe to import in browser builds without webpack aliases or shims.
 *
 * Browser consumers (e.g., @tinycloud/web-sdk) should import from this
 * entry point instead of the root "@tinycloud/node-sdk".
 *
 * @packageDocumentation
 */

// Re-export core values
export { TinyCloud } from "@tinycloud/sdk-core";

// Re-export core types
export type {
  TinyCloudConfig,
  ISigner,
  ISessionStorage,
  IUserAuthorization,
  ClientSession,
  Extension,
  SignInOptions,
  PersistedSessionData,
  TinyCloudSession,
  INotificationHandler,
  IENSResolver,
  IWasmBindings,
  ISessionManager,
  ISpaceCreationHandler,
  SpaceCreationContext,
  CanonicalAddress,
  CanonicalParsedNetworkId,
  DidCacheKeyOptions,
  DidEqualsOptions,
  PkhDidParts,
  TinyCloudDebugEvent,
  TinyCloudDebugLevel,
  TinyCloudDebugEnableOptions,
  TinyCloudDebugTimer,
} from "@tinycloud/sdk-core";

// Re-export core values for extensibility
export {
  SilentNotificationHandler,
  AutoApproveSpaceCreationHandler,
  defaultSpaceCreationHandler,
  IdentityParseError,
  addressStorageKey,
  canonicalizeAddress,
  canonicalizeDid,
  canonicalizeDidUrl,
  canonicalizeNetworkId,
  didCacheKey,
  didEquals,
  isEvmAddress,
  makePkhSpaceId,
  parsePkhDid,
  pkhDid,
  principalDid,
  principalDidEquals,
  parseCanonicalNetworkId,
  TinyCloudDebugLogger,
  tinyCloudDebugLogger,
  enableTinyCloudDebug,
  disableTinyCloudDebug,
  getTinyCloudDebugLogs,
  clearTinyCloudDebugLogs,
  installTinyCloudDebugGlobals,
} from "@tinycloud/sdk-core";

// Storage implementations
export { MemorySessionStorage } from "./storage/MemorySessionStorage";
export { FileSessionStorage } from "./storage/FileSessionStorage";

// Authorization
export {
  NodeUserAuthorization,
  type NodeUserAuthorizationConfig,
} from "./authorization/NodeUserAuthorization";

// Sign strategies — value exports
export {
  createOpenKeyCallbackSigningStrategy,
  defaultSignStrategy,
} from "./authorization/strategies";

// Sign strategies — type exports (re-exported from sdk-core + Node.js-specific types)
export type {
  SignRequest,
  SignResponse,
  SignCallback,
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  OpenKeySigningStrategyOptions,
  OpenKeySigningRequestBody,
  OpenKeySigningResponseBody,
  OpenKeyCallbackStrategy,
  NodeEventEmitterStrategy,
  SignStrategy,
} from "./authorization/strategies";

// High-level API
export {
  TinyCloudNode,
  UnsupportedSessionRestoreError,
  type TinyCloudNodeConfig,
  type DelegateToOptions,
  type DelegateToResult,
  type RuntimePermissionGrantOptions,
  type SecretReadInput,
  type SecretReadResult,
} from "./TinyCloudNode";

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

// Capability-chain primitives (spec: .claude/specs/capability-chain.md).
// Re-exported here so TinyCloudWeb and other consumers can pass
// `PermissionEntry[]` to `delegateTo` and catch the error classes without
// also importing from `@tinycloud/sdk-core`.
export {
  type PermissionEntry,
  type Manifest,
  type ManifestDefaults,
  type ManifestSecretActions,
  type ComposeManifestOptions,
  type ComposedManifestRequest,
  type ManifestRegistryRecord,
  type ResolvedCapabilities,
  type ResolvedDelegate,
  type ResourceCapability,
  type SpaceAbilitiesMap,
  ACCOUNT_REGISTRY_PATH,
  ACCOUNT_REGISTRY_SPACE,
  DEFAULT_MANIFEST_SPACE,
  DEFAULT_MANIFEST_VERSION,
  VAULT_PERMISSION_SERVICE,
  CaveatedDelegationUnsupportedError,
  PermissionNotInManifestError,
  SessionExpiredError,
  ManifestValidationError,
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

// Delegation
export { DelegatedAccess } from "./DelegatedAccess";
export { serializeDelegation, deserializeDelegation } from "./delegation";
export type { PortableDelegation } from "./delegation";

// Re-export KV service values
export {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  KVService,
  PrefixedKVService,
} from "@tinycloud/sdk-core";

// Re-export KV service types
export type {
  IKVService,
  KVServiceConfig,
  KVCreateSignedReadUrlOptions,
  KVResponse,
  KVSignedReadUrlResponse,
  IPrefixedKVService,
} from "@tinycloud/sdk-core";

// Re-export SQL service values
export { SQLService, SQLAction, DatabaseHandle } from "@tinycloud/sdk-core";

// Re-export SQL service types
export type {
  ISQLService,
  IDatabaseHandle,
  SQLServiceConfig,
  SqlValue,
  SqlStatement,
  QueryOptions,
  ExecuteOptions,
  BatchOptions,
  QueryResponse,
  ExecuteResponse,
  BatchResponse,
  SQLActionType,
} from "@tinycloud/sdk-core";

// Re-export DuckDB service values
export {
  DuckDbService,
  DuckDbDatabaseHandle,
  DuckDbAction,
} from "@tinycloud/sdk-core";

// Re-export DuckDB service types
export type {
  IDuckDbService,
  IDuckDbDatabaseHandle,
  DuckDbServiceConfig,
  DuckDbQueryOptions,
  DuckDbExecuteOptions,
  DuckDbBatchOptions,
  DuckDbOptions,
  DuckDbValue,
  DuckDbStatement,
  DuckDbQueryResponse,
  DuckDbExecuteResponse,
  DuckDbBatchResponse,
  DuckDbActionType,
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  ViewInfo,
} from "@tinycloud/sdk-core";

// Re-export Vault and Secrets service values
export {
  DataVaultService,
  VaultHeaders,
  VaultPublicSpaceKVActions,
  createVaultCrypto,
  SecretsService,
  SECRET_NAME_RE,
  canonicalizeSecretScope,
  resolveSecretListPrefix,
  resolveSecretPath,
} from "@tinycloud/sdk-core";

// Re-export Vault and Secrets service types
export type {
  IDataVaultService,
  VaultCrypto,
  WasmVaultFunctions,
  DataVaultConfig,
  VaultPutOptions,
  VaultGetOptions,
  VaultListOptions,
  VaultGrantOptions,
  VaultEntry,
  VaultNetworkReadResult,
  VaultError,
  ISecretsService,
  SecretPayload,
  SecretsError,
  ResolvedSecretPath,
  SecretScopeOptions,
} from "@tinycloud/sdk-core";

// Re-export v2 Delegation service values
export {
  DelegationManager,
  SharingService,
  createSharingService,
  DelegationErrorCodes,
} from "@tinycloud/sdk-core";

// Re-export v2 Delegation types
export type {
  DelegationManagerConfig,
  ISharingService,
  SharingServiceConfig,
  EncodedShareData,
  ReceiveOptions,
  ShareAccess,
  DelegateReceivedShareParams,
  DelegatedShareAccess,
  Delegation,
  CreateDelegationParams,
  DelegationResult,
  DelegationError,
  DelegationErrorCode,
  JWK,
  KeyType,
  KeyInfo,
  CapabilityEntry,
  DelegationRecord,
  SpaceOwnership,
  SpaceInfo,
  ShareSchema,
  ShareLink,
  ShareLinkData,
  IngestOptions,
  GenerateShareParams,
  DelegationChain,
  DelegationChainV2,
  DelegationDirection,
  DelegationFilters,
} from "@tinycloud/sdk-core";

// Re-export CapabilityKeyRegistry values (v2)
export {
  CapabilityKeyRegistry,
  createCapabilityKeyRegistry,
  CapabilityKeyRegistryErrorCodes,
} from "@tinycloud/sdk-core";

// Re-export CapabilityKeyRegistry types (v2)
export type {
  ICapabilityKeyRegistry,
  StoredDelegationChain,
  CapabilityKeyRegistryErrorCode,
} from "@tinycloud/sdk-core";

// Re-export SpaceService values (v2)
export {
  SpaceService,
  SpaceErrorCodes,
  createSpaceService,
  parseSpaceUri,
  buildSpaceUri,
  makePublicSpaceId,
  Space,
} from "@tinycloud/sdk-core";

// Re-export SpaceService types (v2)
export type {
  ISpaceService,
  SpaceServiceConfig,
  SpaceErrorCode,
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

// Re-export ServiceContext value for advanced usage
export { ServiceContext } from "@tinycloud/sdk-core";

// Re-export ServiceContext types for advanced usage
export type {
  ServiceContextConfig,
  ServiceSession,
  InvokeFunction,
  FetchFunction,
  TelemetryConfig,
  TelemetryEventHandler,
} from "@tinycloud/sdk-core";

// Re-export KeyProvider interface from sdk-core
export type { KeyProvider } from "@tinycloud/sdk-core";

// Key management for node-sdk
export {
  WasmKeyProvider,
  type WasmKeyProviderConfig,
  createWasmKeyProvider,
} from "./keys/WasmKeyProvider";
