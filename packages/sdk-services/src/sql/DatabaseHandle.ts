/**
 * DatabaseHandle - Handle for operations on a specific named database.
 *
 * Delegates all operations to the parent SQLService with the database name.
 */

import type { Result } from "../types";
import type { IDatabaseHandle, ISQLMigrations } from "./ISQLService";
import type { SQLService } from "./SQLService";
import { SQLMigrations } from "./SQLMigrations";
import type {
  SqlValue,
  SqlStatement,
  QueryResponse,
  ExecuteResponse,
  BatchResponse,
  QueryOptions,
  ExecuteOptions,
  BatchOptions,
} from "./types";

export class DatabaseHandle implements IDatabaseHandle {
  private service: SQLService;
  public readonly name: string;
  public readonly migrations: ISQLMigrations;

  constructor(service: SQLService, name: string) {
    this.service = service;
    this.name = name;
    this.migrations = new SQLMigrations(service, name);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse<T>>> {
    return this.service.queryOnDb<T>(this.name, sql, params, options);
  }

  async execute(
    sql: string,
    params?: SqlValue[],
    options?: ExecuteOptions
  ): Promise<Result<ExecuteResponse>> {
    return this.service.executeOnDb(this.name, sql, params, options);
  }

  async batch(
    statements: SqlStatement[],
    options?: BatchOptions
  ): Promise<Result<BatchResponse>> {
    return this.service.batchOnDb(this.name, statements, options);
  }

  async executeStatement(
    name: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse | ExecuteResponse>> {
    return this.service.executeStatementOnDb(this.name, name, params, options);
  }

  async export(options?: QueryOptions): Promise<Result<Blob>> {
    return this.service.exportDb(this.name, options);
  }
}
