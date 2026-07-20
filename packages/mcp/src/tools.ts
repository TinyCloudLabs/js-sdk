import { createRequire } from "node:module";
import { join } from "node:path";

import { fromJsonSchema, type McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { addFormats, Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { invokeOperation } from "@tinycloud/operations";

import { toMcpToolResult, type McpToolResult } from "./results.js";

export const TOOL_NAMES = [
  "tinycloud_status",
  "tinycloud_auth_status",
  "tinycloud_auth_capabilities",
  "tinycloud_auth_request",
  "tinycloud_auth_import",
  "tinycloud_account_spaces_list",
  "tinycloud_account_applications_list",
  "tinycloud_kv_list",
  "tinycloud_kv_get",
  "tinycloud_kv_head",
  "tinycloud_kv_put",
  "tinycloud_kv_delete",
  "tinycloud_sql_schema_inspect",
  "tinycloud_sql_query",
  "tinycloud_sql_execute",
  "tinycloud_secrets_get",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface McpStartupSelection {
  readonly profile: string;
  readonly explicitProfile: boolean;
  readonly allowOwnerProfile: boolean;
  /** Absolute TinyCloud home used to isolate one hosted OAuth principal. */
  readonly stateRoot?: string;
  /** Hosted transports may attach a browser approval URL to canonical results. */
  readonly transformOperationResult?: (result: unknown) => Promise<unknown>;
}

export interface McpInvocationTarget {
  readonly profile: string;
  readonly allowOwnerProfile?: true;
  readonly stateRoot?: string;
}

/** Project one startup selection into the only owner-sensitive target shape. */
export function invocationTargetForMcp(
  selection: McpStartupSelection,
): McpInvocationTarget {
  return {
    profile: selection.profile,
    ...(selection.explicitProfile && selection.allowOwnerProfile
      ? { allowOwnerProfile: true }
      : {}),
    ...(selection.stateRoot === undefined ? {} : { stateRoot: selection.stateRoot }),
  };
}

interface CatalogOperation {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly result: Record<string, unknown>;
}

interface OperationsCatalog {
  readonly operations: readonly CatalogOperation[];
}

// The require anchor is this module, never the consumer entrypoint. In ESM
// tsup preserves import.meta.url; in CJS it rewrites the same module-relative
// anchor to the generated __filename, so both formats stay in MCP's package
// dependency boundary.
const packageRequire = createRequire(
  typeof __dirname === "string" ? join(__dirname, "tools.cjs") : import.meta.url,
);
const generatedCatalog = packageRequire(
  "@tinycloud/operations/operations.json",
) as OperationsCatalog;

interface ToolBinding {
  readonly name: ToolName;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly readOnlyHint: boolean;
  readonly idempotentHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

const TOOL_BINDINGS: readonly ToolBinding[] = [
  {
    name: "tinycloud_status",
    operationId: "tinycloud.status.get",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_status",
    operationId: "tinycloud.auth.status",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_capabilities",
    operationId: "tinycloud.auth.capabilities",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_request",
    operationId: "tinycloud.auth.request",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_import",
    operationId: "tinycloud.auth.import",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    name: "tinycloud_account_spaces_list",
    operationId: "tinycloud.account.spaces.list",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_account_applications_list",
    operationId: "tinycloud.account.applications.list",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_kv_list",
    operationId: "tinycloud.kv.list",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_kv_get",
    operationId: "tinycloud.kv.get",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_kv_head",
    operationId: "tinycloud.kv.head",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_kv_put",
    operationId: "tinycloud.kv.put",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: true,
  },
  {
    name: "tinycloud_kv_delete",
    operationId: "tinycloud.kv.delete",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: true,
  },
  {
    name: "tinycloud_sql_schema_inspect",
    operationId: "tinycloud.sql.schema.inspect",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_sql_query",
    operationId: "tinycloud.sql.query",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_sql_execute",
    operationId: "tinycloud.sql.execute",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  {
    name: "tinycloud_secrets_get",
    operationId: "tinycloud.secrets.get",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
] as const;

export function createJsonSchemaValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  return new AjvJsonSchemaValidator(ajv);
}

export function registerTinyCloudTools(
  server: McpServer,
  selection: McpStartupSelection,
  validator: AjvJsonSchemaValidator,
): void {
  const definitions = new Map(
    generatedCatalog.operations.map((operation) => [
      `${operation.id}@${operation.version}`,
      operation,
    ]),
  );

  for (const binding of TOOL_BINDINGS) {
    const operation = definitions.get(`${binding.operationId}@${binding.operationVersion}`);
    if (operation === undefined) {
      throw new Error(`Generated operations catalog is missing ${binding.operationId}@${binding.operationVersion}.`);
    }

    const inputSchema = fromJsonSchema(
      operation.input as Parameters<typeof fromJsonSchema>[0],
      validator,
    );
    const outputSchema = fromJsonSchema(
      operation.result as unknown as Parameters<typeof fromJsonSchema>[0],
      validator,
    );
    const annotations: ToolAnnotations = {
      readOnlyHint: binding.readOnlyHint,
      idempotentHint: binding.idempotentHint,
      destructiveHint: binding.destructiveHint,
      openWorldHint: binding.openWorldHint,
    };

    server.registerTool(
      binding.name,
      {
        title: operation.title,
        description: operation.description,
        inputSchema,
        outputSchema,
        annotations,
      },
      async (input: unknown): Promise<McpToolResult> => {
        const result = await invokeOperation(
          binding.operationId,
          binding.operationVersion,
          invocationTargetForMcp(selection),
          input,
        );
        const projected = selection.transformOperationResult === undefined
          ? result
          : await selection.transformOperationResult(result);
        return toMcpToolResult(projected);
      },
    );
  }
}

export function toolBindingsForTest(): readonly ToolBinding[] {
  return TOOL_BINDINGS;
}
