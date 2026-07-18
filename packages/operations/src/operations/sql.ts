import type { TinyCloudNode } from "@tinycloud/node-sdk";
import nodeSqlParser from "node-sql-parser";
import { z } from "zod";

import type {
  CapabilityRequirement,
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
  OperationExposure,
  OperationSensitivity,
  RuntimeOperationContext,
  TinyCloudPosture,
} from "../contract.js";
import { OperationInvocationError, operationError } from "../errors.js";
import { operationSpaceResolver } from "../secrets.js";

const DEFAULT_MAX_ROWS = 100;
const MAX_MAX_ROWS = 1_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_MAX_BYTES = 4 * 1024 * 1024;
const SCHEMA_MAX_ROWS = 500;
const SCHEMA_MAX_BYTES = 1024 * 1024;
const MAX_PARAMETERS = 100;
const MAX_SQL_LENGTH = 64 * 1024;
const SQL_WRITE_AUTHORITY_NOTICE =
  "Approving tinycloud.sql/write grants full read/write/schema mutation authority over this exact database; the MCP tool itself accepts only one parameterized INSERT, UPDATE, or DELETE.";

const SCHEMA_QUERY = `SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE type IN ('table', 'view', 'index', 'trigger')
  AND name NOT LIKE 'sqlite_%'
ORDER BY type, name`;

type SqlPrimitive = null | number | string;
interface SqlBlob {
  readonly type: "blob";
  readonly base64: string;
  readonly byteLength: number;
}
type SqlOutputValue = SqlPrimitive | SqlBlob;
type SqlInputValue = SqlPrimitive | Readonly<{ type: "blob"; base64: string }>;

interface SqlTargetInput {
  readonly space: string;
  readonly database: string;
}

interface SqlQueryInput extends SqlTargetInput {
  readonly sql: string;
  readonly params?: readonly SqlInputValue[];
  readonly maxRows?: number;
  readonly maxBytes?: number;
}

interface SqlExecuteInput extends SqlTargetInput {
  readonly sql: string;
  readonly params: readonly SqlInputValue[];
  readonly acknowledgeDatabaseWideAuthority: true;
}

interface SqlLimitsOutput {
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly enforcement: "node-requested-client-verified";
}

interface SqlSchemaInspectOutput {
  readonly space: string;
  readonly database: string;
  readonly objects: readonly {
    readonly type: "table" | "view" | "index" | "trigger";
    readonly name: string;
    readonly tableName: string;
    readonly sql?: string;
  }[];
  readonly count: number;
  readonly limits: SqlLimitsOutput;
}

interface SqlQueryOutput {
  readonly space: string;
  readonly database: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlOutputValue[])[];
  readonly rowCount: number;
  readonly limits: SqlLimitsOutput;
}

interface SqlExecuteOutput {
  readonly space: string;
  readonly database: string;
  readonly statementType: "insert" | "update" | "delete";
  readonly changes: number;
  readonly lastInsertRowId: number | null;
  readonly authorityNotice: typeof SQL_WRITE_AUTHORITY_NOTICE;
}

const sqlParser = new nodeSqlParser.Parser();

const SpaceSchema = z.string().min(1).refine(
  (space) =>
    (/^[A-Za-z0-9_-]+$/.test(space) || space.startsWith("tinycloud:")) &&
    !space.includes("*"),
  "Invalid TinyCloud space.",
);
const DatabaseSchema = z.string().min(1).max(256).refine(
  (database) =>
    database !== "/" &&
    !database.endsWith("/") &&
    !database.includes("*") &&
    !/[\u0000-\u001f\u007f]/.test(database),
  "Invalid SQLite database name.",
);
const SafeNumberSchema = z.number().finite().refine(
  (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
  "SQLite integer parameters must be JavaScript safe integers.",
);
const Base64Schema = z.string().max(Math.ceil(MAX_MAX_BYTES / 3) * 4).refine(
  isCanonicalBase64,
  "Invalid base64 BLOB value.",
);
const SqlInputValueSchema: z.ZodType<SqlInputValue> = z.union([
  z.null(),
  SafeNumberSchema,
  z.string().max(MAX_MAX_BYTES),
  z.object({ type: z.literal("blob"), base64: Base64Schema }).strict(),
]);
const SqlParamsSchema = z.array(SqlInputValueSchema).max(MAX_PARAMETERS).superRefine(
  (params, context) => {
    const totalBytes = params.reduce<number>(
      (total, value) => total + sqlInputValueBytes(value),
      0,
    );
    if (totalBytes > MAX_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SQLite query parameters exceed the 4 MiB input limit.",
      });
    }
  },
);
const RequiredSqlParamsSchema = z.array(SqlInputValueSchema).min(1).max(MAX_PARAMETERS).superRefine(
  (params, context) => {
    const totalBytes = params.reduce<number>(
      (total, value) => total + sqlInputValueBytes(value),
      0,
    );
    if (totalBytes > MAX_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SQLite query parameters exceed the 4 MiB input limit.",
      });
    }
  },
);
const SqlOutputValueSchema: z.ZodType<SqlOutputValue> = z.union([
  z.null(),
  SafeNumberSchema,
  z.string(),
  z.object({
    type: z.literal("blob"),
    base64: z.string(),
    byteLength: z.number().int().nonnegative(),
  }).strict(),
]);
const SqlTargetInputSchema: z.ZodType<SqlTargetInput> = z.object({
  space: SpaceSchema,
  database: DatabaseSchema,
}).strict();
const SqlQueryInputSchema: z.ZodType<SqlQueryInput> = z.object({
  space: SpaceSchema,
  database: DatabaseSchema,
  sql: z.string().min(1).max(MAX_SQL_LENGTH).superRefine((sql, context) => {
    if (!isSingleReadQuery(sql)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SQL must parse as exactly one SQLite SELECT statement.",
      });
    }
  }),
  params: SqlParamsSchema.optional(),
  maxRows: z.number().int().positive().max(MAX_MAX_ROWS).optional(),
  maxBytes: z.number().int().positive().max(MAX_MAX_BYTES).optional(),
}).strict();
const SqlExecuteInputSchema: z.ZodType<SqlExecuteInput> = z.object({
  space: SpaceSchema,
  database: DatabaseSchema,
  sql: z.string().min(1).max(MAX_SQL_LENGTH),
  params: RequiredSqlParamsSchema,
  acknowledgeDatabaseWideAuthority: z.literal(true).describe(SQL_WRITE_AUTHORITY_NOTICE),
}).strict().superRefine((input, context) => {
  if (parseSingleDmlStatement(input.sql, input.params.length) === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sql"],
      message: "SQL must parse as exactly one parameterized INSERT, UPDATE, or DELETE with one value per positional placeholder.",
    });
  }
});

const SqlLimitsOutputSchema: z.ZodType<SqlLimitsOutput> = z.object({
  maxRows: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  enforcement: z.literal("node-requested-client-verified"),
}).strict();
const SqlSchemaInspectOutputSchema: z.ZodType<SqlSchemaInspectOutput> = z.object({
  space: z.string().min(1),
  database: z.string().min(1),
  objects: z.array(z.object({
    type: z.enum(["table", "view", "index", "trigger"]),
    name: z.string().min(1),
    tableName: z.string().min(1),
    sql: z.string().optional(),
  }).strict()),
  count: z.number().int().nonnegative(),
  limits: SqlLimitsOutputSchema,
}).strict();
const SqlQueryOutputSchema: z.ZodType<SqlQueryOutput> = z.object({
  space: z.string().min(1),
  database: z.string().min(1),
  columns: z.array(z.string()),
  rows: z.array(z.array(SqlOutputValueSchema)),
  rowCount: z.number().int().nonnegative(),
  limits: SqlLimitsOutputSchema,
}).strict();
const SqlExecuteOutputSchema: z.ZodType<SqlExecuteOutput> = z.object({
  space: z.string().min(1),
  database: z.string().min(1),
  statementType: z.enum(["insert", "update", "delete"]),
  changes: z.number().int().nonnegative(),
  lastInsertRowId: z.number().int().nullable(),
  authorityNotice: z.literal(SQL_WRITE_AUTHORITY_NOTICE),
}).strict();

const AUTHENTICATED_POSTURES: readonly TinyCloudPosture[] = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
];
const SQL_EXPOSURE: OperationExposure = {
  cli: {
    status: "excluded",
    reason: "Existing SQL Commander commands remain the CLI surface.",
  },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};
const SQL_SCHEMA_SENSITIVITY: OperationSensitivity = {
  input: ["/database"],
  output: ["/objects"],
};
const SQL_QUERY_SENSITIVITY: OperationSensitivity = {
  input: ["/database", "/sql", "/params"],
  output: ["/columns", "/rows"],
};
const SQL_EXECUTE_SENSITIVITY: OperationSensitivity = {
  input: ["/database", "/sql", "/params"],
  output: ["/lastInsertRowId"],
};

type SqlDefinition =
  | OperationDefinition<SqlTargetInput, SqlSchemaInspectOutput>
  | OperationDefinition<SqlQueryInput, SqlQueryOutput>
  | OperationDefinition<SqlExecuteInput, SqlExecuteOutput>;

export const sqlOperationDefinitions: readonly SqlDefinition[] = [
  {
    id: "tinycloud.sql.schema.inspect",
    version: 1,
    title: "Inspect a TinyCloud SQLite schema",
    description: "List user tables, views, indexes, and triggers in one exact TinyCloud SQLite database using a fixed read-only query.",
    input: SqlTargetInputSchema,
    output: SqlSchemaInspectOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: SQL_EXPOSURE,
    sensitivity: SQL_SCHEMA_SENSITIVITY,
    authority: planSqlRead,
    execute: executeSqlSchemaInspect,
  },
  {
    id: "tinycloud.sql.query",
    version: 1,
    title: "Query a TinyCloud SQLite database",
    description: "Run exactly one parser-approved SELECT against one exact TinyCloud SQLite database. Result limits are requested from the node and verified locally without silent truncation.",
    input: SqlQueryInputSchema,
    output: SqlQueryOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: SQL_EXPOSURE,
    sensitivity: SQL_QUERY_SENSITIVITY,
    invalidInputErrorCode: "SQL_QUERY_INVALID",
    authority: planSqlRead,
    execute: executeSqlQuery,
  },
  {
    id: "tinycloud.sql.execute",
    version: 1,
    title: "Execute a TinyCloud SQLite DML statement",
    description: `Run exactly one parameterized INSERT, UPDATE, or DELETE against one exact TinyCloud SQLite database. ${SQL_WRITE_AUTHORITY_NOTICE}`,
    input: SqlExecuteInputSchema,
    output: SqlExecuteOutputSchema,
    effects: ["write", "destructive"],
    runtime: "authenticated",
    postures: AUTHENTICATED_POSTURES,
    exposure: SQL_EXPOSURE,
    sensitivity: SQL_EXECUTE_SENSITIVITY,
    invalidInputErrorCode: "SQL_QUERY_INVALID",
    authority: planSqlWrite,
    execute: executeSqlDml,
  },
];

async function planSqlRead(
  context: RuntimeOperationContext,
  input: SqlTargetInput,
): Promise<readonly CapabilityRequirement[]> {
  const space = resolveSqlSpace(context, input.space);
  return [{
    service: "tinycloud.sql",
    space,
    path: input.database,
    actions: ["tinycloud.sql/read"],
  }];
}

async function planSqlWrite(
  context: RuntimeOperationContext,
  input: SqlExecuteInput,
): Promise<readonly CapabilityRequirement[]> {
  const space = resolveSqlSpace(context, input.space);
  return [{
    service: "tinycloud.sql",
    space,
    path: input.database,
    actions: ["tinycloud.sql/write"],
    description: SQL_WRITE_AUTHORITY_NOTICE,
  }];
}

async function executeSqlSchemaInspect(
  context: OperationContext,
  input: SqlTargetInput,
): Promise<OperationExecutionOutcome<SqlSchemaInspectOutput>> {
  try {
    const runtime = runtimeContext(context);
    const space = resolveSqlSpace(runtime, input.space);
    const result = await runtimeNode(runtime)
      .sqlForSpace(space)
      .db(input.database)
      .query(SCHEMA_QUERY, [], { maxRows: SCHEMA_MAX_ROWS, maxBytes: SCHEMA_MAX_BYTES });
    if (!result.ok) return sqlServiceFailure(result.error, "inspect the SQLite schema");

    const normalized = normalizeQueryResult(result.data, SCHEMA_MAX_ROWS, SCHEMA_MAX_BYTES);
    const objects = normalized.rows.map((row) => schemaObject(row));
    return {
      status: "ok",
      output: {
        space,
        database: input.database,
        objects,
        count: objects.length,
        limits: limitsOutput(SCHEMA_MAX_ROWS, SCHEMA_MAX_BYTES),
      },
    };
  } catch (error) {
    return sqlFailure(error, "inspect the SQLite schema");
  }
}

async function executeSqlQuery(
  context: OperationContext,
  input: SqlQueryInput,
): Promise<OperationExecutionOutcome<SqlQueryOutput>> {
  try {
    if (!isSingleReadQuery(input.sql)) {
      return {
        status: "error",
        error: operationError(
          "SQL_QUERY_INVALID",
          "SQL must parse as exactly one SQLite SELECT statement.",
        ),
      };
    }

    const runtime = runtimeContext(context);
    const space = resolveSqlSpace(runtime, input.space);
    const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const params = (input.params ?? []).map(decodeSqlInputValue);
    const result = await runtimeNode(runtime)
      .sqlForSpace(space)
      .db(input.database)
      .query(input.sql, params, { maxRows, maxBytes });
    if (!result.ok) return sqlServiceFailure(result.error, "run the SQLite query");

    const normalized = normalizeQueryResult(result.data, maxRows, maxBytes);
    return {
      status: "ok",
      output: {
        space,
        database: input.database,
        columns: normalized.columns,
        rows: normalized.rows,
        rowCount: normalized.rows.length,
        limits: limitsOutput(maxRows, maxBytes),
      },
    };
  } catch (error) {
    return sqlFailure(error, "run the SQLite query");
  }
}

async function executeSqlDml(
  context: OperationContext,
  input: SqlExecuteInput,
): Promise<OperationExecutionOutcome<SqlExecuteOutput>> {
  try {
    const statementType = parseSingleDmlStatement(input.sql, input.params.length);
    if (statementType === undefined) {
      return {
        status: "error",
        error: operationError(
          "SQL_QUERY_INVALID",
          "SQL must parse as exactly one parameterized INSERT, UPDATE, or DELETE with one value per positional placeholder.",
        ),
      };
    }

    const runtime = runtimeContext(context);
    const space = resolveSqlSpace(runtime, input.space);
    const result = await runtimeNode(runtime)
      .sqlForSpace(space)
      .db(input.database)
      .execute(input.sql, input.params.map(decodeSqlInputValue));
    if (!result.ok) return nodeFailure("execute the SQLite statement");
    const normalized = normalizeExecuteResult(result.data);
    return {
      status: "ok",
      output: {
        space,
        database: input.database,
        statementType,
        ...normalized,
        authorityNotice: SQL_WRITE_AUTHORITY_NOTICE,
      },
    };
  } catch (error) {
    return sqlFailure(error, "execute the SQLite statement");
  }
}

function isSingleReadQuery(sql: string): boolean {
  const ast = parseSingleStatement(sql);
  return ast !== undefined && ast.type === "select";
}

function parseSingleDmlStatement(
  sql: string,
  parameterCount: number,
): "insert" | "update" | "delete" | undefined {
  const ast = parseSingleStatement(sql);
  if (
    ast === undefined ||
    (ast.type !== "insert" && ast.type !== "update" && ast.type !== "delete") ||
    ast.with !== undefined && ast.with !== null
  ) {
    return undefined;
  }
  const placeholders = countPositionalParameters(ast);
  return placeholders > 0 && placeholders === parameterCount ? ast.type : undefined;
}

function parseSingleStatement(sql: string): Record<string, unknown> | undefined {
  try {
    const ast = sqlParser.astify(sql, { database: "sqlite" }) as unknown;
    return !Array.isArray(ast) && isRecord(ast) ? ast : undefined;
  } catch {
    return undefined;
  }
}

function countPositionalParameters(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countPositionalParameters(entry), 0);
  }
  if (!isRecord(value)) return 0;
  const current = value.type === "origin" && value.value === "?" ? 1 : 0;
  return Object.values(value).reduce<number>(
    (count, entry) => count + countPositionalParameters(entry),
    current,
  );
}

function decodeSqlInputValue(value: SqlInputValue): null | number | string | Uint8Array {
  if (isRecord(value) && value.type === "blob") {
    return new Uint8Array(Buffer.from(value.base64 as string, "base64"));
  }
  return value as null | number | string;
}

function normalizeQueryResult(
  value: unknown,
  maxRows: number,
  maxBytes: number,
): Readonly<{ columns: readonly string[]; rows: readonly (readonly SqlOutputValue[])[] }> {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
    throw unsafeSqlValue("The node returned an invalid SQLite query result.");
  }
  const columns = value.columns.map((column) => {
    if (typeof column !== "string") {
      throw unsafeSqlValue("The node returned an invalid SQLite column name.");
    }
    return column;
  });
  const rows = value.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw unsafeSqlValue("The node returned an invalid SQLite row.");
    }
    return row.map(normalizeSqlOutputValue);
  });

  const serializedBytes = Buffer.byteLength(JSON.stringify({ columns, rows }), "utf8");
  if (rows.length > maxRows || serializedBytes > maxBytes) {
    throw new OperationInvocationError(operationError(
      "SQL_RESULT_LIMIT_EXCEEDED",
      "The SQLite query result exceeded the requested result limits.",
      {
        details: {
          maxRows,
          maxBytes,
          returnedRows: rows.length,
          returnedBytes: serializedBytes,
        },
      },
    ));
  }
  return { columns, rows };
}

function normalizeSqlOutputValue(value: unknown): SqlOutputValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw unsafeSqlValue("The node returned an integer that cannot be represented safely in JavaScript.");
    }
    return value;
  }
  if (value instanceof Uint8Array) return encodeBlob(value);
  if (Array.isArray(value) && value.every(isByte)) {
    return encodeBlob(Uint8Array.from(value));
  }
  if (isRecord(value) && value.type === "Buffer" && Array.isArray(value.data) && value.data.every(isByte)) {
    return encodeBlob(Uint8Array.from(value.data));
  }
  throw unsafeSqlValue("The node returned an unsupported SQLite value.");
}

function normalizeExecuteResult(
  value: unknown,
): Readonly<{ changes: number; lastInsertRowId: number | null }> {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.changes) ||
    (value.changes as number) < 0 ||
    (
      value.lastInsertRowId !== null &&
      !Number.isSafeInteger(value.lastInsertRowId)
    )
  ) {
    throw unsafeSqlValue("The node returned SQLite mutation metadata that cannot be represented safely in JavaScript.");
  }
  return {
    changes: value.changes as number,
    lastInsertRowId: value.lastInsertRowId as number | null,
  };
}

function schemaObject(row: readonly SqlOutputValue[]): SqlSchemaInspectOutput["objects"][number] {
  const [type, name, tableName, sql] = row;
  if (
    (type !== "table" && type !== "view" && type !== "index" && type !== "trigger") ||
    typeof name !== "string" ||
    typeof tableName !== "string" ||
    (sql !== null && typeof sql !== "string")
  ) {
    throw unsafeSqlValue("The node returned an invalid SQLite schema record.");
  }
  return {
    type,
    name,
    tableName,
    ...(sql === null ? {} : { sql }),
  };
}

function limitsOutput(maxRows: number, maxBytes: number): SqlLimitsOutput {
  return { maxRows, maxBytes, enforcement: "node-requested-client-verified" };
}

function runtimeContext(context: OperationContext): RuntimeOperationContext {
  if (context.runtime === undefined) {
    throw new TypeError("Authenticated operation runtime is unavailable.");
  }
  return context as RuntimeOperationContext;
}

function runtimeNode(context: RuntimeOperationContext): TinyCloudNode {
  return context.runtime.node as TinyCloudNode;
}

function resolveSqlSpace(context: RuntimeOperationContext, space: string): string {
  const resolved = operationSpaceResolver(
    context.runtime.node,
    context.summary.space,
  )(space);
  const name = resolved.split(":").at(-1)?.toLowerCase();
  if (name === "secrets" || name === "account") {
    throw new OperationInvocationError(operationError(
      "INPUT_INVALID",
      "Generic SQL operations cannot access protected TinyCloud account or secrets spaces.",
    ));
  }
  return resolved;
}

function encodeBlob(value: Uint8Array): SqlBlob {
  return {
    type: "blob",
    base64: Buffer.from(value).toString("base64"),
    byteLength: value.byteLength,
  };
}

function unsafeSqlValue(message: string): OperationInvocationError {
  return new OperationInvocationError(operationError("SQL_VALUE_UNSAFE", message));
}

function sqlFailure(
  error: unknown,
  action: string,
): OperationExecutionOutcome<never> {
  if (error instanceof OperationInvocationError) {
    return { status: "error", error: error.operationError };
  }
  return nodeFailure(action);
}

function nodeFailure(action: string): OperationExecutionOutcome<never> {
  return {
    status: "error",
    error: operationError(
      "NODE_ERROR",
      `The TinyCloud node could not ${action}.`,
      { retryable: true },
    ),
  };
}

function sqlServiceFailure(
  error: unknown,
  action: string,
): OperationExecutionOutcome<never> {
  if (isRecord(error) && error.code === "SQL_RESPONSE_TOO_LARGE") {
    return {
      status: "error",
      error: operationError(
        "SQL_RESULT_LIMIT_EXCEEDED",
        "The SQLite query result exceeded the requested result limits.",
      ),
    };
  }
  return nodeFailure(action);
}

function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function sqlInputValueBytes(value: SqlInputValue): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (isRecord(value) && value.type === "blob") {
    return Buffer.from(value.base64 as string, "base64").byteLength;
  }
  return 8;
}

function isByte(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
