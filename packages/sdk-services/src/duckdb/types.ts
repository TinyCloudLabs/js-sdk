/**
 * DuckDB Service Types
 *
 * Type definitions for the DuckDB service operations.
 */

/**
 * Configuration for DuckDbService.
 */
export interface DuckDbServiceConfig {
  /**
   * Default database name.
   * If not set, operations default to "default".
   */
  defaultDatabase?: string;

  /**
   * Default timeout in milliseconds for DuckDB operations.
   */
  timeout?: number;

  /** Allow additional config properties */
  [key: string]: unknown;
}

/**
 * Options for DuckDB query operations.
 */
export interface DuckDbQueryOptions {
  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;

  /**
   * Response format. "json" returns parsed objects, "arrow" returns ArrayBuffer.
   */
  format?: "json" | "arrow";
}

/**
 * Options for DuckDB execute operations.
 */
export interface DuckDbExecuteOptions {
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
 * Options for DuckDB batch operations.
 */
export interface DuckDbBatchOptions {
  /**
   * Whether to run statements in a transaction.
   */
  transactional?: boolean;

  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * Options for DuckDB operations that only need an abort signal.
 */
export interface DuckDbOptions {
  /**
   * Custom abort signal for this operation.
   */
  signal?: AbortSignal;
}

/**
 * A DuckDB value: null, boolean, number, string, binary, array, or object.
 */
export type DuckDbValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | DuckDbValueArray
  | DuckDbValueRecord;

/** Array of DuckDB values (workaround for circular type alias). */
export interface DuckDbValueArray extends Array<DuckDbValue> {}

/** Record of DuckDB values (workaround for circular type alias). */
export interface DuckDbValueRecord {
  [key: string]: DuckDbValue;
}

/**
 * A DuckDB statement with optional parameters.
 */
export interface DuckDbStatement {
  sql: string;
  params?: DuckDbValue[];
}

/**
 * Response from DuckDB query operations.
 */
export interface QueryResponse<T = Record<string, unknown>> {
  columns: string[];
  rows: T[][];
  rowCount: number;
}

/**
 * Response from DuckDB execute operations.
 */
export interface ExecuteResponse {
  changes: number;
}

/**
 * Response from DuckDB batch operations.
 */
export interface BatchResponse {
  results: ExecuteResponse[];
}

/**
 * Schema information for a DuckDB database.
 */
export interface SchemaInfo {
  tables: TableInfo[];
  views: ViewInfo[];
}

/**
 * Information about a table.
 */
export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

/**
 * Information about a column.
 */
export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

/**
 * Information about a view.
 */
export interface ViewInfo {
  name: string;
  sql: string;
}

/**
 * DuckDB service action types.
 */
export const DuckDbAction = {
  READ: "tinycloud.duckdb/read",
  WRITE: "tinycloud.duckdb/write",
  ADMIN: "tinycloud.duckdb/admin",
  DESCRIBE: "tinycloud.duckdb/describe",
  EXPORT: "tinycloud.duckdb/export",
  IMPORT: "tinycloud.duckdb/import",
  EXECUTE: "tinycloud.duckdb/execute",
  ALL: "tinycloud.duckdb/*",
} as const;

export type DuckDbActionType = (typeof DuckDbAction)[keyof typeof DuckDbAction];
