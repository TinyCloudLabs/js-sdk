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
  "tinycloud_secrets_get",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface McpStartupSelection {
  readonly profile: string;
  readonly explicitProfile: boolean;
  readonly allowOwnerProfile: boolean;
}

interface CatalogOperation {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
}

interface OperationsCatalog {
  readonly operations: readonly CatalogOperation[];
}

interface ToolBinding {
  readonly name: ToolName;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly readOnlyHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

const TOOL_BINDINGS: readonly ToolBinding[] = [
  {
    name: "tinycloud_status",
    operationId: "tinycloud.status.get",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_status",
    operationId: "tinycloud.auth.status",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_capabilities",
    operationId: "tinycloud.auth.capabilities",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_request",
    operationId: "tinycloud.auth.request",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  {
    name: "tinycloud_auth_import",
    operationId: "tinycloud.auth.import",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  {
    name: "tinycloud_secrets_get",
    operationId: "tinycloud.secrets.get",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
] as const;

const packageRequire = createRequire(
  typeof __filename === "string" && __filename !== "[eval]"
    ? __filename
    : process.argv[1] ?? join(process.cwd(), "package.json"),
);
const generatedCatalog = packageRequire("@tinycloud/operations/operations.json") as OperationsCatalog;

export function createJsonSchemaValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  return new AjvJsonSchemaValidator(ajv);
}

export function registerTinyCloudTools(
  server: McpServer,
  selection: McpStartupSelection,
  validator = createJsonSchemaValidator(),
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

    const inputSchema = fromJsonSchema(operation.input, validator);
    const annotations: ToolAnnotations = {
      readOnlyHint: binding.readOnlyHint,
      idempotentHint: binding.idempotentHint,
      destructiveHint: false,
      openWorldHint: binding.openWorldHint,
    };

    server.registerTool(
      binding.name,
      {
        title: operation.title,
        description: operation.description,
        inputSchema,
        annotations,
      },
      async (input: unknown): Promise<McpToolResult> => {
        const allowOwnerProfile = binding.name === "tinycloud_secrets_get"
          ? selection.explicitProfile && selection.allowOwnerProfile
          : true;
        const result = await invokeOperation(
          binding.operationId,
          binding.operationVersion,
          {
            profile: selection.profile,
            ...(allowOwnerProfile ? { allowOwnerProfile: true } : {}),
          },
          input,
        );
        return toMcpToolResult(result);
      },
    );
  }
}

export function toolBindingsForTest(): readonly ToolBinding[] {
  return TOOL_BINDINGS;
}
