/**
 * ISQLService - Interface for SQL service.
 *
 * Platform-agnostic interface for SQL database operations.
 */

import type { IService, Result } from "../types";
import type {
  SQLServiceConfig,
  QueryOptions,
  ExecuteOptions,
  BatchOptions,
  SqlValue,
  SqlStatement,
  QueryResponse,
  ExecuteResponse,
  BatchResponse,
  SqlMigrationApplyOptions,
  SqlMigrationApplyResponse,
} from "./types";

/**
 * Migration helper bound to a specific database.
 */
export interface ISQLMigrations {
  /**
   * Apply ordered, app-owned migrations and record completed ids.
   */
  apply(options: SqlMigrationApplyOptions): Promise<Result<SqlMigrationApplyResponse>>;
}

/**
 * Database handle interface for operations on a specific named database.
 */
export interface IDatabaseHandle {
  /** The database name */
  readonly name: string;

  /** Versioned schema migration helper. */
  readonly migrations: ISQLMigrations;

  /**
   * Execute a SQL query and return rows.
   */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse<T>>>;

  /**
   * Execute a SQL statement and return change count.
   */
  execute(
    sql: string,
    params?: SqlValue[],
    options?: ExecuteOptions
  ): Promise<Result<ExecuteResponse>>;

  /**
   * Execute multiple statements in a transaction.
   */
  batch(
    statements: SqlStatement[],
    options?: BatchOptions
  ): Promise<Result<BatchResponse>>;

  /**
   * Execute a named prepared statement from delegation caveats.
   */
  executeStatement(
    name: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse | ExecuteResponse>>;

  /**
   * Export the raw SQLite database file.
   */
  export(options?: QueryOptions): Promise<Result<Blob>>;
}

/**
 * SQL service interface.
 *
 * Provides SQL database operations with:
 * - Result type pattern (no throwing)
 * - Named database handles
 * - Configurable timeouts
 * - Abort signal support
 */
export interface ISQLService extends IService {
  /**
   * Get a handle to a named database.
   * @param name - Database name (defaults to "default")
   */
  db(name?: string): IDatabaseHandle;

  /**
   * Shortcut: query the default database.
   */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse<T>>>;

  /**
   * Shortcut: execute on the default database.
   */
  execute(
    sql: string,
    params?: SqlValue[],
    options?: ExecuteOptions
  ): Promise<Result<ExecuteResponse>>;

  /**
   * Shortcut: batch on the default database.
   */
  batch(
    statements: SqlStatement[],
    options?: BatchOptions
  ): Promise<Result<BatchResponse>>;

  /**
   * Service configuration.
   */
  readonly config: SQLServiceConfig;
}
