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
import { authRequiredError, wrapError, parseAuthError } from "../errors";
import {
  formatServiceResponseError,
  parseServiceErrorBody,
  responseErrorMeta,
} from "../responseErrors";
import type { IDuckDbService, IDuckDbDatabaseHandle } from "./IDuckDbService";
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
   * Shortcut: query the default database (JSON format).
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<QueryResponse<T>>> {
    return this.queryOnDb<T>(this.defaultDbName, sql, params, options);
  }

  /**
   * Shortcut: query the default database (Arrow IPC format).
   */
  async queryArrow(
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<ArrayBuffer>> {
    return this.queryArrowOnDb(this.defaultDbName, sql, params, options);
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
  ): Promise<Result<QueryResponse<T>>> {
    return this.withTelemetry<QueryResponse<T>>("query", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.READ,
          { action: "query", sql, params: params ?? [] },
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "query");
        }

        const data = (await response.json()) as QueryResponse<T>;
        return ok(data);
      } catch (error) {
        return err(wrapError("duckdb", error));
      }
    });
  }

  async queryArrowOnDb(
    dbName: string,
    sql: string,
    params?: DuckDbValue[],
    options?: DuckDbQueryOptions
  ): Promise<Result<ArrayBuffer>> {
    return this.withTelemetry<ArrayBuffer>("queryArrow", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }

      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.READ,
          { action: "query", sql, params: params ?? [] },
          options?.signal,
          { Accept: "application/vnd.apache.arrow.stream" }
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "queryArrow");
        }

        const buffer = await response.arrayBuffer();
        return ok(buffer);
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
        // TC-114: mint the dispatchable ability, not the literal method name.
        // The node has no `tinycloud.duckdb/execute` capability — it routes an
        // `executeStatement` request by body kind and classifies write-class
        // from the RESOLVED named statement's SQL
        // (tinycloud-node-server/src/routes/mod.rs:1698-1701). Mirroring the SQL
        // path, `write` is the ability that works for both read-only and
        // mutating named statements and is contained in a normal read+write
        // delegation.
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.WRITE,
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
        // TC-114: mint the dispatchable ability, not the literal method name.
        // The node has no `tinycloud.duckdb/describe` capability — it routes a
        // `describe` request by body kind and authorizes it as a READ
        // (`DuckDbRequest::Describe` is non-write:
        // tinycloud-node-server/src/routes/mod.rs:1705, see comment :1680).
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.READ,
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

        const blob = await response.blob();
        return ok(blob);
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

    const errorBody = parseServiceErrorBody(errorText);

    const errorCode = this.mapHttpStatusToErrorCode(
      response.status,
      errorBody.error
    );
    const message = formatServiceResponseError(
      "DuckDB",
      operation,
      response.status,
      errorText,
      errorBody,
    );

    const meta = responseErrorMeta(response.status, response.statusText, errorText);

    if (response.status === 401) {
      const { resource, action } = parseAuthError(errorText);
      if (action) meta.requiredAction = action;
      if (resource) meta.resource = resource;
    }

    return err(
      serviceError(errorCode, message, "duckdb", { meta })
    );
  }

  private mapHttpStatusToErrorCode(
    status: number,
    serverError?: string
  ): string {
    switch (status) {
      case 400:
        return ErrorCodes.DUCKDB_ERROR;
      case 401:
        return ErrorCodes.AUTH_UNAUTHORIZED;
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
