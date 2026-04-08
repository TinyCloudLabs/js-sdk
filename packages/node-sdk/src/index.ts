/**
 * @tinycloud/node-sdk
 *
 * TinyCloud SDK for Node.js environments.
 *
 * This package provides Node.js-specific implementations of the TinyCloud SDK:
 * - PrivateKeySigner: Sign messages using a private key
 * - NodeUserAuthorization: Authorize users with configurable sign strategies
 * - MemorySessionStorage: Store sessions in memory
 * - FileSessionStorage: Persist sessions to the file system
 *
 * @example
 * ```typescript
 * import { TinyCloud } from '@tinycloud/sdk-core';
 * import {
 *   NodeUserAuthorization,
 *   PrivateKeySigner,
 *   FileSessionStorage,
 * } from '@tinycloud/node-sdk';
 *
 * const signer = new PrivateKeySigner(process.env.PRIVATE_KEY);
 * const auth = new NodeUserAuthorization({
 *   signer,
 *   signStrategy: { type: 'auto-sign' },
 *   domain: 'api.myapp.com',
 *   sessionStorage: new FileSessionStorage('/tmp/sessions'),
 * });
 *
 * const tc = new TinyCloud(auth);
 * await tc.signIn();
 * ```
 *
 * @packageDocumentation
 */

// Register Node.js-specific defaults (NodeWasmBindings, PrivateKeySigner)
// This must be imported before TinyCloudNode is used, so it runs on module load.
import "./nodeDefaults";

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
  PersistedSessionData,
  TinyCloudSession,
  INotificationHandler,
  IENSResolver,
  IWasmBindings,
  ISessionManager,
  ISpaceCreationHandler,
  SpaceCreationContext,
} from "@tinycloud/sdk-core";

// Re-export core values for extensibility
export {
  SilentNotificationHandler,
  AutoApproveSpaceCreationHandler,
  defaultSpaceCreationHandler,
} from "@tinycloud/sdk-core";

// Signers
export { PrivateKeySigner } from "./signers/PrivateKeySigner";

// Storage implementations
export { MemorySessionStorage } from "./storage/MemorySessionStorage";
export { FileSessionStorage } from "./storage/FileSessionStorage";

// Authorization
export {
  NodeUserAuthorization,
  NodeUserAuthorizationConfig,
} from "./authorization/NodeUserAuthorization";

// Sign strategies — value exports
export { defaultSignStrategy } from "./authorization/strategies";

// Sign strategies — type exports (re-exported from sdk-core + Node.js-specific types)
export type {
  SignRequest,
  SignResponse,
  SignCallback,
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  NodeEventEmitterStrategy,
  SignStrategy,
} from "./authorization/strategies";

// High-level API
export { TinyCloudNode, TinyCloudNodeConfig } from "./TinyCloudNode";

// WASM bindings
export { NodeWasmBindings } from "./NodeWasmBindings";

// Delegation
export { DelegatedAccess } from "./DelegatedAccess";
export {
  PortableDelegation,
  serializeDelegation,
  deserializeDelegation,
} from "./delegation";

// Re-export KV service values
export { KVService, PrefixedKVService } from "@tinycloud/sdk-core";

// Re-export KV service types
export type {
  IKVService,
  KVServiceConfig,
  KVResponse,
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
export { DuckDbService, DuckDbDatabaseHandle, DuckDbAction } from "@tinycloud/sdk-core";

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

// Re-export Vault service values
export { DataVaultService, VaultHeaders, VaultPublicSpaceKVActions, createVaultCrypto } from "@tinycloud/sdk-core";

// Re-export Vault service types
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
  VaultError,
} from "@tinycloud/sdk-core";

// Re-export Hooks service values
export { HooksService } from "@tinycloud/sdk-core";

// Re-export Hooks service types
export type {
  IHooksService,
  HookSubscription,
  HookEvent,
  HookStreamEvent,
  SubscribeOptions,
  HooksServiceConfig,
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
} from "@tinycloud/sdk-core";

// Re-export KeyProvider interface from sdk-core
export type { KeyProvider } from "@tinycloud/sdk-core";

// Key management for node-sdk
export {
  WasmKeyProvider,
  WasmKeyProviderConfig,
  createWasmKeyProvider,
} from "./keys/WasmKeyProvider";
