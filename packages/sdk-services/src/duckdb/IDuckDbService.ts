/**
 * IDuckDbService - Interface for DuckDB service.
 *
 * Platform-agnostic interface for DuckDB database operations.
 */

import type { IService, Result } from "../types";
import type {
  DuckDbServiceConfig,
  DuckDbQueryOptions,
  DuckDbExecuteOptions,
  DuckDbBatchOptions,
  DuckDbOptions,
  DuckDbValue,
  DuckDbStatement,
  QueryResponse,
  ExecuteResponse,
  BatchResponse,
  SchemaInfo,
} from "./types";

/**
 * Database handle interface for operations on a specific named database.
 */
export interface IDuckDbDatabaseHandle {
  /** The database name */
  readonly name: string;

  /**
   * Execute a DuckDB query and return rows.
   */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse<T> | ArrayBuffer>>;

  /**
   * Execute a DuckDB statement and return change count.
   */
  execute(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbExecuteOptions
  ): Promise<Result<ExecuteResponse>>;

  /**
   * Execute multiple statements in a batch.
   */
  batch(
    statements: DuckDbStatement[],
    options?: DuckDbBatchOptions
  ): Promise<Result<BatchResponse>>;

  /**
   * Execute a named prepared statement from delegation caveats.
   */
  executeStatement(
    name: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse | ExecuteResponse>>;

  /**
   * Describe the database schema.
   */
  describe(options?: DuckDbOptions): Promise<Result<SchemaInfo>>;

  /**
   * Export the database as a Blob.
   */
  export(options?: DuckDbOptions): Promise<Result<Blob>>;

  /**
   * Import a binary DuckDB database file.
   */
  import(data: Uint8Array, options?: DuckDbOptions): Promise<Result<void>>;
}

/**
 * DuckDB service interface.
 *
 * Provides DuckDB database operations with:
 * - Result type pattern (no throwing)
 * - Named database handles
 * - Configurable timeouts
 * - Abort signal support
 * - Arrow format support
 */
export interface IDuckDbService extends IService {
  /**
   * Get a handle to a named database.
   * @param name - Database name (defaults to "default")
   */
  db(name?: string): IDuckDbDatabaseHandle;

  /**
   * Shortcut: query the default database.
   */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse<T> | ArrayBuffer>>;

  /**
   * Shortcut: execute on the default database.
   */
  execute(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbExecuteOptions
  ): Promise<Result<ExecuteResponse>>;

  /**
   * Shortcut: batch on the default database.
   */
  batch(
    statements: DuckDbStatement[],
    options?: DuckDbBatchOptions
  ): Promise<Result<BatchResponse>>;

  /**
   * Service configuration.
   */
  readonly config: DuckDbServiceConfig;
}
