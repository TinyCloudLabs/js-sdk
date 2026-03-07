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
  ErrorCode,
  IServiceContext,
  IService,
  ServiceSession,
  RetryPolicy,
  InvokeFunction,
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
} from "./errors";

// Base service
export { BaseService } from "./base/index";
export type {
  ServiceConstructor,
  ServiceRegistration,
  BaseServiceOptions,
} from "./base/index";

// KV service
export { KVService, PrefixedKVService, IKVService, KVAction } from "./kv";
export type {
  IPrefixedKVService,
  KVServiceConfig,
  KVGetOptions,
  KVPutOptions,
  KVListOptions,
  KVDeleteOptions,
  KVHeadOptions,
  KVResponse,
  KVListResponse,
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

// Vault service
export { DataVaultService, VaultAction, VaultHeaders, createVaultCrypto } from "./vault";
export type { IDataVaultService, VaultCrypto, WasmVaultFunctions } from "./vault";
export type {
  DataVaultConfig,
  VaultPutOptions,
  VaultGetOptions,
  VaultListOptions,
  VaultGrantOptions,
  VaultEntry,
  VaultError,
  VaultActionType,
} from "./vault";
