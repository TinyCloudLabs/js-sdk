/**
 * DuckDB Service Module
 *
 * Provides DuckDB database operations for TinyCloud.
 */

export { DuckDbService } from "./DuckDbService";
export { DuckDbDatabaseHandle } from "./DuckDbDatabaseHandle";
export type { IDuckDbService, IDuckDbDatabaseHandle } from "./IDuckDbService";
export {
  DuckDbAction,
  type DuckDbActionType,
  type DuckDbServiceConfig,
  type DuckDbQueryOptions,
  type DuckDbExecuteOptions,
  type DuckDbBatchOptions,
  type DuckDbOptions,
  type DuckDbValue,
  type DuckDbStatement,
  type QueryResponse as DuckDbQueryResponse,
  type ExecuteResponse as DuckDbExecuteResponse,
  type BatchResponse as DuckDbBatchResponse,
  type SchemaInfo,
  type TableInfo,
  type ColumnInfo,
  type ViewInfo,
} from "./types";
