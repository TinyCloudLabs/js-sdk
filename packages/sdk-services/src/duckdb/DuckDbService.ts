/**
 * DuckDbService - DuckDB database service implementation.
 *
 * Platform-agnostic DuckDB service that works with both web-sdk and node-sdk.
 * Uses dependency injection via IServiceContext for platform dependencies.
 */

import { BaseService } from "../base/BaseService";
import {
  Result,
  ok,
  err,
  ErrorCodes,
  serviceError,
  type FetchResponse,
} from "../types";
import { authRequiredError, wrapError } from "../errors";
import type { IDuckDbService } from "./IDuckDbService";
import type { IDuckDbDatabaseHandle } from "./IDuckDbService";
import { DuckDbDatabaseHandle } from "./DuckDbDatabaseHandle";
import {
  type DuckDbServiceConfig,
  type DuckDbQueryOptions,
  type DuckDbExecuteOptions,
  type DuckDbBatchOptions,
  type DuckDbOptions,
  type DuckDbValue,
  type DuckDbStatement,
  type QueryResponse,
  type ExecuteResponse,
  type BatchResponse,
  type SchemaInfo,
  DuckDbAction,
} from "./types";

export class DuckDbService extends BaseService implements IDuckDbService {
  static readonly serviceName = "duckdb";

  declare protected _config: DuckDbServiceConfig;

  constructor(config: DuckDbServiceConfig = {}) {
    super();
    this._config = config;
  }

  get config(): DuckDbServiceConfig {
    return this._config;
  }

  private get defaultDbName(): string {
    return this._config.defaultDatabase ?? "default";
  }

  private get host(): string {
    return this.context.hosts[0];
  }

  /**
   * Get a handle to a named database.
   */
  db(name?: string): IDuckDbDatabaseHandle {
    return new DuckDbDatabaseHandle(this, name ?? this.defaultDbName);
  }

  /**
   * Shortcut: query the default database.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse<T> | ArrayBuffer>> {
    return this.queryOnDb<T>(this.defaultDbName, sql, params, options);
  }

  /**
   * Shortcut: execute on the default database.
   */
  async execute(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbExecuteOptions
  ): Promise<Result<ExecuteResponse>> {
    return this.executeOnDb(this.defaultDbName, sql, params, options);
  }

  /**
   * Shortcut: batch on the default database.
   */
  async batch(
    statements: DuckDbStatement[],
    options?: DuckDbBatchOptions
  ): Promise<Result<BatchResponse>> {
    return this.batchOnDb(this.defaultDbName, statements, options);
  }

  // === Internal methods called by DuckDbDatabaseHandle ===

  async queryOnDb<T = Record<string, unknown>>(
    dbName: string,
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse<T> | ArrayBuffer>> {
    return this.withTelemetry<QueryResponse<T> | ArrayBuffer>("query", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const isArrow = options?.format === "arrow";
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.READ,
          { action: "query", sql, params: params ?? [] },
          options?.signal,
          isArrow
            ? { Accept: "application/vnd.apache.arrow.stream" }
            : undefined
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "query");
        }

        if (isArrow) {
          if (typeof response.arrayBuffer === "function") {
            const buffer = await response.arrayBuffer();
            return ok(buffer);
          }
          // Fallback: read as text and convert
          const text = await response.text();
          const encoder = new TextEncoder();
          return ok(encoder.encode(text).buffer as ArrayBuffer);
        }

        const data = (await response.json()) as QueryResponse<T>;
        return ok(data);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  async executeOnDb(
    dbName: string,
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbExecuteOptions
  ): Promise<Result<ExecuteResponse>> {
    return this.withTelemetry("execute", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const body: Record<string, unknown> = {
          action: "execute",
          sql,
          params: params ?? [],
        };
        if (options?.schema) {
          body.schema = options.schema;
        }

        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.WRITE,
          body,
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "execute");
        }

        const data = (await response.json()) as ExecuteResponse;
        return ok(data);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  async batchOnDb(
    dbName: string,
    statements: DuckDbStatement[],
    options?: DuckDbBatchOptions
  ): Promise<Result<BatchResponse>> {
    return this.withTelemetry("batch", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const body: Record<string, unknown> = {
          action: "batch",
          statements,
        };
        if (options?.transactional !== undefined) {
          body.transactional = options.transactional;
        }

        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.WRITE,
          body,
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "batch");
        }

        const data = (await response.json()) as BatchResponse;
        return ok(data);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  async executeStatementOnDb(
    dbName: string,
    name: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse | ExecuteResponse>> {
    return this.withTelemetry("executeStatement", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.EXECUTE,
          { action: "executeStatement", name, params: params ?? [] },
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "executeStatement");
        }

        const data = (await response.json()) as
          | QueryResponse
          | ExecuteResponse;
        return ok(data);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  async describeDb(
    dbName: string,
    options?: DuckDbOptions
  ): Promise<Result<SchemaInfo>> {
    return this.withTelemetry("describe", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.DESCRIBE,
          { action: "describe" },
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "describe");
        }

        const data = (await response.json()) as SchemaInfo;
        return ok(data);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  async exportOnDb(
    dbName: string,
    options?: DuckDbOptions
  ): Promise<Result<Blob>> {
    return this.withTelemetry("export", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.EXPORT,
          { action: "export" },
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "export");
        }

        if (typeof response.blob === "function") {
          const blob = await response.blob();
          return ok(blob);
        }
        const text = await response.text();
        return ok(text as unknown as Blob);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  async importOnDb(
    dbName: string,
    data: Uint8Array,
    options?: DuckDbOptions
  ): Promise<Result<void>> {
    return this.withTelemetry("import", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const session = this.context.session!;
        const headers = this.context.invoke(
          session,
          "duckdb",
          dbName,
          DuckDbAction.IMPORT
        );

        const response = await this.context.fetch(`${this.host}/invoke`, {
          method: "POST",
          headers: {
            ...(headers as Record<string, string>),
            "Content-Type": "application/x-duckdb",
          },
          body: new Blob([data]),
          signal: this.combineSignals(options?.signal),
        });

        if (!response.ok) {
          return this.handleErrorResponse(response, "import");
        }

        return ok(undefined);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  // === Private helpers ===

  private async invokeDuckDb(
    dbName: string,
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>
  ): Promise<FetchResponse> {
    const session = this.context.session!;
    const headers = this.context.invoke(session, "duckdb", dbName, action);

    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers: {
        ...(headers as Record<string, string>),
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: this.combineSignals(signal),
    });
  }

  private async handleErrorResponse(
    response: FetchResponse,
    operation: string
  ): Promise<Result<never>> {
    const errorText = await response.text();

    let errorBody: { error?: string; message?: string; code?: string } = {};
    try {
      errorBody = JSON.parse(errorText);
    } catch {
      // Not JSON
    }

    const errorCode = this.mapHttpStatusToErrorCode(
      response.status,
      errorBody.error
    );
    const message =
      errorBody.message ||
      `DuckDB ${operation} failed: ${response.status} - ${errorText}`;

    return err(
      serviceError(errorCode, message, "duckdb", {
        meta: { status: response.status, statusText: response.statusText },
      })
    );
  }

  private mapHttpStatusToErrorCode(
    status: number,
    serverError?: string
  ): string {
    switch (status) {
      case 400:
        return ErrorCodes.DUCKDB_ERROR;
      case 403:
        if (serverError === "duckdb_readonly_violation") {
          return ErrorCodes.DUCKDB_READONLY_VIOLATION;
        }
        return ErrorCodes.DUCKDB_PERMISSION_DENIED;
      case 404:
        return ErrorCodes.DUCKDB_DATABASE_NOT_FOUND;
      case 413:
        return ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE;
      case 429:
        return ErrorCodes.DUCKDB_QUOTA_EXCEEDED;
      default:
        return ErrorCodes.NETWORK_ERROR;
    }
  }
}
