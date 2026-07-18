/**
 * SQL Service Types
 *
 * Type definitions for the SQL service operations.
 */

import { SQL } from "@tinycloud/bootstrap";

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

  /** Maximum rows the node may return. Nodes without limit support ignore it. */
  maxRows?: number;

  /** Maximum serialized result bytes the node may return. */
  maxBytes?: number;
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
  lastInsertRowId: number | null;
}

/**
 * Response from SQL batch operations.
 */
export interface BatchResponse {
  results: ExecuteResponse[];
}

/**
 * A versioned SQL migration owned by an application or SDK subsystem.
 */
export interface SqlMigration {
  /**
   * Stable migration id within the namespace, e.g. "001_initial".
   */
  id: string;

  /**
   * SQL statements to apply when this migration has not been recorded.
   * Statements should be idempotent where SQLite supports it.
   */
  sql: Array<string | SqlStatement>;
}

/**
 * Options for applying SQL migrations.
 */
export interface SqlMigrationApplyOptions {
  /**
   * Namespace for this migration set, usually an app id or SDK subsystem.
   */
  namespace: string;

  /**
   * Ordered migration list.
   */
  migrations: SqlMigration[];

  /**
   * Custom abort signal for migration operations.
   */
  signal?: AbortSignal;
}

/**
 * Result from applying SQL migrations.
 */
export interface SqlMigrationApplyResponse {
  database: string;
  namespace: string;
  status: "already_current" | "applied";
  applied: string[];
  skipped: string[];
}

/**
 * SQL service action types.
 *
 * URNs derive from the canonical capability registry in `@tinycloud/bootstrap`
 * (TC-112 single source of truth, vendored from tinycloud-node). `insert`,
 * `update`, and `delete` were dropped — zero client refs and never accepted
 * node-side. `select` is a deprecated alias of `read`. `execute`/`export` are
 * request-kind artifacts, not grantable capabilities: the node routes them by
 * request-body kind, so they are absent from the registry but kept here as the
 * invocation ability the client sends today (wire alignment tracked in TC-114).
 */
export const SQLAction = {
  READ: SQL.READ,
  WRITE: SQL.WRITE,
  SCHEMA: SQL.SCHEMA,
  ADMIN: SQL.ADMIN,
  SELECT: SQL.SELECT,
  EXECUTE: SQL.EXECUTE,
  EXPORT: SQL.EXPORT,
  ALL: SQL.ALL,
} as const;

export type SQLActionType = (typeof SQLAction)[keyof typeof SQLAction];
