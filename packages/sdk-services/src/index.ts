/**
 * TinyCloud SDK Services
 *
 * Platform-agnostic services with plugin architecture for TinyCloud.
 *
 * @packageDocumentation
 * @module @tinycloud/sdk-services
 *
 * @example
 * ```typescript
 * import {
 *   ServiceContext,
 *   BaseService,
 *   Result,
 *   ErrorCodes,
 * } from '@tinycloud/sdk-services';
 *
 * // Create a context
 * const context = new ServiceContext({
 *   invoke: wasmInvoke,
 *   hosts: ['https://node.tinycloud.xyz'],
 * });
 *
 * // Create and register a service
 * const kv = new KVService({ prefix: 'myapp' });
 * context.registerService('kv', kv);
 * kv.initialize(context);
 *
 * // Use the service
 * const result = await kv.get('key');
 * if (result.ok) {
 *   console.log(result.data);
 * }
 * ```
 */

// Core types
export type {
  Result,
  ServiceError,
  StorageQuotaInfo,
  ErrorCode,
  IServiceContext,
  IService,
  ServiceSession,
  RetryPolicy,
  InvokeFunction,
  InvokeAnyFunction,
  InvokeAnyEntry,
  InvocationFact,
  InvocationFacts,
  FetchFunction,
  FetchRequestInit,
  FetchResponse,
  ServiceHeaders,
  EventHandler,
  ServiceRequestEvent,
  ServiceResponseEvent,
  ServiceErrorEvent,
  ServiceRetryEvent,
} from "./types";

export {
  ErrorCodes,
  defaultRetryPolicy,
  TelemetryEvents,
  ok,
  err,
  serviceError,
} from "./types";

// Zod schemas and validation
export {
  // Schemas
  ServiceErrorSchema,
  KVResponseHeadersSchema,
  KVListResponseSchema,
  ServiceRequestEventSchema,
  ServiceResponseEventSchema,
  ServiceErrorEventSchema,
  ServiceRetryEventSchema,
  RetryPolicySchema,
  ServiceSessionSchema,
  GenericResultSchema,
  GenericKVResponseSchema,
  KVListResultSchema,
  // Schema factories
  createResultSchema,
  createKVResponseSchema,
  // Validation functions
  validateServiceError,
  validateKVListResponse,
  validateKVResponseHeaders,
  validateServiceSession,
  validateRetryPolicy,
  validateServiceRequestEvent,
  validateServiceResponseEvent,
} from "./types.schema";

export type {
  // Inferred types from schemas
  ValidationError,
  ServiceErrorType,
  KVResponseHeadersType,
  KVListResponseType,
  GenericKVResponseType,
  KVListResultType,
  ServiceRequestEventType,
  ServiceResponseEventType,
  ServiceErrorEventType,
  ServiceRetryEventType,
  RetryPolicyType,
  ServiceSessionType,
} from "./types.schema";

// Context
export { ServiceContext } from "./context";
export type { ServiceContextConfig } from "./context";

// Errors
export {
  authRequiredError,
  authExpiredError,
  networkError,
  timeoutError,
  abortedError,
  notFoundError,
  permissionDeniedError,
  wrapError,
  errorResult,
  storageQuotaExceededError,
  storageLimitReachedError,
  parseAuthError,
  authUnauthorizedError,
} from "./errors";

// Base service
export { BaseService } from "./base/index";
export type {
  ServiceConstructor,
  ServiceRegistration,
  BaseServiceOptions,
} from "./base/index";

// KV service
export {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  KVService,
  PrefixedKVService,
  IKVService,
  KVAction,
} from "./kv";
export type {
  IPrefixedKVService,
  KVServiceConfig,
  KVGetOptions,
  KVPutOptions,
  KVListOptions,
  KVDeleteOptions,
  KVHeadOptions,
  KVCreateSignedReadUrlOptions,
  KVResponse,
  KVListResponse,
  KVSignedReadUrlResponse,
  KVResponseHeaders,
  KVActionType,
} from "./kv";

// SQL service
export { SQLService, DatabaseHandle, SQLAction } from "./sql";
export type { ISQLService, IDatabaseHandle } from "./sql";
export type {
  SQLServiceConfig,
  QueryOptions,
  ExecuteOptions,
  BatchOptions,
  SqlValue,
  SqlStatement,
  QueryResponse,
  ExecuteResponse,
  BatchResponse,
  SQLActionType,
} from "./sql";

// DuckDB service
export { DuckDbService, DuckDbDatabaseHandle, DuckDbAction } from "./duckdb";
export type { IDuckDbService, IDuckDbDatabaseHandle } from "./duckdb";
export type {
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
} from "./duckdb";

// Hooks service
export { HooksService } from "./hooks";
export type {
  IHooksService,
  HookServiceName,
  HookSubscription,
  HookEvent,
  HookStreamEvent,
  HookWebhookScope,
  HookWebhookRegistration,
  HookWebhookRecord,
  HookWebhookListOptions,
  HookWebhookUnregisterOptions,
  SubscribeOptions,
  HooksServiceConfig,
} from "./hooks";

// Quota
export { TinyCloudQuota } from "./quota";
export type { QuotaConfig, QuotaStatus } from "./quota";

// Vault service
export {
  DataVaultService,
  VaultHeaders,
  VaultPublicSpaceKVActions,
  createVaultCrypto,
} from "./vault";
export type {
  IDataVaultService,
  VaultCrypto,
  WasmVaultFunctions,
} from "./vault";
export type {
  DataVaultConfig,
  VaultPutOptions,
  VaultGetOptions,
  VaultListOptions,
  VaultGrantOptions,
  VaultEntry,
  VaultError,
} from "./vault";

export {
  SecretsService,
  SECRET_NAME_RE,
  canonicalizeSecretScope,
  resolveSecretListPrefix,
  resolveSecretPath,
} from "./secrets";
export type {
  ISecretsService,
  SecretPayload,
  SecretsError,
  ResolvedSecretPath,
  SecretScopeOptions,
} from "./secrets";

// Encryption service (network-scoped one-of-one decrypt)
export {
  EncryptionService,
  parseNetworkId,
  buildNetworkId,
  isNetworkId,
  networkDiscoveryKey,
  NetworkIdError,
  ENCRYPTION_NETWORK_URN_PREFIX,
  NETWORK_NAME_PATTERN,
  canonicalize as canonicalizeEncryptionJson,
  canonicalHashHex,
  hexEncode,
  hexDecode,
  base64Encode,
  base64Decode,
  utf8Encode,
  utf8Decode,
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
} from "./encryption";
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
  Json,
} from "./encryption";
