/**
 * SQL Service Types
 *
 * Type definitions for the SQL service operations.
 */

/**
 * Configuration for SQLService.
 */
export interface SQLServiceConfig {
  /**
   * Default database name.
   * If not set, operations default to "default".
   */
  defaultDatabase?: string;

  /**
   * Default read mode for SQL queries.
   * Defaults to canonical.
   */
  readMode?: SQLReadMode;

  /**
   * Default timeout in milliseconds for SQL operations.
   */
  timeout?: number;

  /** Allow additional config properties */
  [key: string]: unknown;
}

/**
 * Options for SQL query operations.
 */
export interface QueryOptions {
  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;

  /**
   * Read canonical or provisional SQL state.
   * Defaults to the service config, then canonical.
   */
  readMode?: SQLReadMode;
}

/**
 * Options for SQL execute operations.
 */
export interface ExecuteOptions {
  /**
   * Schema initialization statements (CREATE TABLE IF NOT EXISTS ...).
   * Executed before the main statement on first write.
   */
  schema?: string[];

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Options for SQL batch operations.
 */
export interface BatchOptions {
  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

export type SQLReadMode = "canonical" | "provisional";

/**
 * A SQL value: null, number, string, or binary data.
 */
export type SqlValue = null | number | string | Uint8Array;

/**
 * A SQL statement with optional parameters.
 */
export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * Response from SQL query operations.
 */
export interface QueryResponse<T = Record<string, unknown>> {
  columns: string[];
  rows: T[][];
  rowCount: number;
}

/**
 * Response from SQL execute operations.
 */
export interface ExecuteResponse {
  changes: number;
  lastInsertRowId: number;
}

/**
 * Response from SQL batch operations.
 */
export interface BatchResponse {
  results: ExecuteResponse[];
}

/**
 * SQL service action types.
 */
export const SQLAction = {
  READ: "tinycloud.sql/read",
  WRITE: "tinycloud.sql/write",
  ADMIN: "tinycloud.sql/admin",
  SELECT: "tinycloud.sql/select",
  INSERT: "tinycloud.sql/insert",
  UPDATE: "tinycloud.sql/update",
  DELETE: "tinycloud.sql/delete",
  EXECUTE: "tinycloud.sql/execute",
  EXPORT: "tinycloud.sql/export",
  ALL: "tinycloud.sql/*",
} as const;

export type SQLActionType = (typeof SQLAction)[keyof typeof SQLAction];
