/**
 * SQLService - SQL database service implementation.
 *
 * Platform-agnostic SQL service that works with both web-sdk and node-sdk.
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
  type ServiceHeaders,
  type ServiceSession,
} from "../types";
import { authRequiredError, wrapError, parseAuthError } from "../errors";
import type { ISQLService } from "./ISQLService";
import type { IDatabaseHandle } from "./ISQLService";
import { DatabaseHandle } from "./DatabaseHandle";
import {
  type SQLServiceConfig,
  type QueryOptions,
  type ExecuteOptions,
  type BatchOptions,
  type SqlValue,
  type SqlStatement,
  type QueryResponse,
  type ExecuteResponse,
  type BatchResponse,
  SQLAction,
} from "./types";

const DDL_TOKENS = new Set(["alter", "create", "drop"]);

export class SQLService extends BaseService implements ISQLService {
  static readonly serviceName = "sql";

  declare protected _config: SQLServiceConfig;

  constructor(config: SQLServiceConfig = {}) {
    super();
    this._config = config;
  }

  get config(): SQLServiceConfig {
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
  db(name?: string): IDatabaseHandle {
    return new DatabaseHandle(this, name ?? this.defaultDbName);
  }

  /**
   * Shortcut: query the default database.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse<T>>> {
    return this.queryOnDb<T>(this.defaultDbName, sql, params, options);
  }

  /**
   * Shortcut: execute on the default database.
   */
  async execute(
    sql: string,
    params?: SqlValue[],
    options?: ExecuteOptions
  ): Promise<Result<ExecuteResponse>> {
    return this.executeOnDb(this.defaultDbName, sql, params, options);
  }

  /**
   * Shortcut: batch on the default database.
   */
  async batch(
    statements: SqlStatement[],
    options?: BatchOptions
  ): Promise<Result<BatchResponse>> {
    return this.batchOnDb(this.defaultDbName, statements, options);
  }

  // === Internal methods called by DatabaseHandle ===

  async queryOnDb<T = Record<string, unknown>>(
    dbName: string,
    sql: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse<T>>> {
    return this.withTelemetry("query", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }

      try {
        const response = await this.invokeSQL(
          dbName,
          this.actionForSql(sql, SQLAction.READ),
          { action: "query", sql, params: params ?? [] },
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "query");
        }

        const data = (await response.json()) as QueryResponse<T>;
        return ok(data);
      } catch (error) {
        return err(wrapError("sql", error));
      }
    });
  }

  async executeOnDb(
    dbName: string,
    sql: string,
    params?: SqlValue[],
    options?: ExecuteOptions
  ): Promise<Result<ExecuteResponse>> {
    return this.withTelemetry("execute", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
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

        const actions = [
          this.actionForSql(sql, SQLAction.WRITE),
          ...(options?.schema ?? []).map((statement) =>
            this.actionForSql(statement, SQLAction.DDL),
          ),
        ];
        const response = await this.invokeSQL(
          dbName,
          this.dedupeActions(actions),
          body,
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "execute");
        }

        const data = (await response.json()) as ExecuteResponse;
        return ok(data);
      } catch (error) {
        return err(wrapError("sql", error));
      }
    });
  }

  async batchOnDb(
    dbName: string,
    statements: SqlStatement[],
    options?: BatchOptions
  ): Promise<Result<BatchResponse>> {
    return this.withTelemetry("batch", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }

      try {
        const response = await this.invokeSQL(
          dbName,
          this.actionsForSqlBatch(statements),
          { action: "batch", statements },
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "batch");
        }

        const data = (await response.json()) as BatchResponse;
        return ok(data);
      } catch (error) {
        return err(wrapError("sql", error));
      }
    });
  }

  async executeStatementOnDb(
    dbName: string,
    name: string,
    params?: SqlValue[],
    options?: QueryOptions
  ): Promise<Result<QueryResponse | ExecuteResponse>> {
    return this.withTelemetry("executeStatement", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }

      try {
        const response = await this.invokeSQL(
          dbName,
          SQLAction.EXECUTE,
          { action: "execute_statement", name, params: params ?? [] },
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
        return err(wrapError("sql", error));
      }
    });
  }

  async exportDb(
    dbName: string,
    options?: QueryOptions
  ): Promise<Result<Blob>> {
    return this.withTelemetry("export", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }

      try {
        const response = await this.invokeSQL(
          dbName,
          SQLAction.EXPORT,
          { action: "export" },
          options?.signal
        );

        if (!response.ok) {
          return this.handleErrorResponse(response, "export");
        }

        // FetchResponse doesn't expose blob(), so access it from the
        // underlying response which is a standard fetch Response at runtime
        const resp = response as any;
        if (typeof resp.blob === "function") {
          const blob = await resp.blob();
          return ok(blob as Blob);
        }
        // If blob() is not available, return the raw text as a Blob-like
        const text = await response.text();
        return ok(text as unknown as Blob);
      } catch (error) {
        return err(wrapError("sql", error));
      }
    });
  }

  // === Private helpers ===

  private async invokeSQL(
    dbName: string,
    actions: string | string[],
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<FetchResponse> {
    const session = this.context.session!;
    const actionList = Array.isArray(actions) ? actions : [actions];
    const headers =
      actionList.length === 1
        ? this.context.invoke(session, "sql", dbName, actionList[0]!)
        : this.invokeSQLAny(session, dbName, actionList);

    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers: {
        ...(headers as Record<string, string>),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body) as any,
      signal: this.combineSignals(signal),
    });
  }

  private actionForSql(sql: string, fallback: string): string {
    const token = firstSqlToken(sql);
    if (token === "pragma") return SQLAction.ADMIN;
    if (token !== undefined && DDL_TOKENS.has(token)) return SQLAction.DDL;
    return fallback;
  }

  private actionsForSqlBatch(statements: SqlStatement[]): string[] {
    return this.dedupeActions(
      statements.map((statement) => this.actionForSql(statement.sql, SQLAction.WRITE)),
    );
  }

  private dedupeActions(actions: string[]): string[] {
    return [...new Set(actions)];
  }

  private invokeSQLAny(
    session: ServiceSession,
    dbName: string,
    actions: string[],
  ): ServiceHeaders {
    if (!this.context.invokeAny) {
      throw new Error(
        `SQL operation requires multiple permissions (${actions.join(", ")}) but this SDK runtime does not support multi-resource invocations`,
      );
    }

    return this.context.invokeAny(
      session,
      actions.map((action) => ({
        spaceId: session.spaceId,
        service: "sql",
        path: dbName,
        action,
      })),
    );
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
      `SQL ${operation} failed: ${response.status} - ${errorText}`;

    const meta: Record<string, unknown> = { status: response.status, statusText: response.statusText };

    if (response.status === 401) {
      const { resource, action } = parseAuthError(errorText);
      if (action) meta.requiredAction = action;
      if (resource) meta.resource = resource;
    }

    return err(
      serviceError(errorCode, message, "sql", { meta })
    );
  }

  private mapHttpStatusToErrorCode(
    status: number,
    serverError?: string
  ): string {
    switch (status) {
      case 400:
        return ErrorCodes.SQL_ERROR;
      case 401:
        return ErrorCodes.AUTH_UNAUTHORIZED;
      case 403:
        if (serverError === "sql_readonly_violation") {
          return ErrorCodes.SQL_READONLY_VIOLATION;
        }
        return ErrorCodes.SQL_PERMISSION_DENIED;
      case 404:
        return ErrorCodes.SQL_DATABASE_NOT_FOUND;
      case 413:
        return ErrorCodes.SQL_RESPONSE_TOO_LARGE;
      case 429:
        return ErrorCodes.SQL_QUOTA_EXCEEDED;
      default:
        return ErrorCodes.NETWORK_ERROR;
    }
  }
}

function firstSqlToken(sql: string): string | undefined {
  let index = 0;

  while (index < sql.length) {
    while (index < sql.length && /\s/.test(sql[index])) {
      index++;
    }

    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      if (newline === -1) {
        return undefined;
      }
      index = newline + 1;
      continue;
    }

    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        return undefined;
      }
      index = end + 2;
      continue;
    }

    break;
  }

  const match = /^[A-Za-z_]+/.exec(sql.slice(index));
  return match?.[0].toLowerCase();
}
