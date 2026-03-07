/**
 * DuckDbDatabaseHandle - Handle for operations on a specific named database.
 *
 * Delegates all operations to the parent DuckDbService with the database name.
 */

import type { Result } from "../types";
import type { IDuckDbDatabaseHandle } from "./IDuckDbService";
import type { DuckDbService } from "./DuckDbService";
import type {
  DuckDbValue,
  DuckDbStatement,
  QueryResponse,
  ExecuteResponse,
  BatchResponse,
  SchemaInfo,
  DuckDbQueryOptions,
  DuckDbExecuteOptions,
  DuckDbBatchOptions,
  DuckDbOptions,
} from "./types";

export class DuckDbDatabaseHandle implements IDuckDbDatabaseHandle {
  private service: DuckDbService;
  public readonly name: string;

  constructor(service: DuckDbService, name: string) {
    this.service = service;
    this.name = name;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse<T> | ArrayBuffer>> {
    return this.service.queryOnDb<T>(this.name, sql, params, options);
  }

  async execute(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbExecuteOptions
  ): Promise<Result<ExecuteResponse>> {
    return this.service.executeOnDb(this.name, sql, params, options);
  }

  async batch(
    statements: DuckDbStatement[],
    options?: DuckDbBatchOptions
  ): Promise<Result<BatchResponse>> {
    return this.service.batchOnDb(this.name, statements, options);
  }

  async executeStatement(
    name: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse | ExecuteResponse>> {
    return this.service.executeStatementOnDb(this.name, name, params, options);
  }

  async describe(options?: DuckDbOptions): Promise<Result<SchemaInfo>> {
    return this.service.describeDb(this.name, options);
  }

  async export(options?: DuckDbOptions): Promise<Result<Blob>> {
    return this.service.exportOnDb(this.name, options);
  }

  async import(data: Uint8Array, options?: DuckDbOptions): Promise<Result<void>> {
    return this.service.importOnDb(this.name, data, options);
  }
}
