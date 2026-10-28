import { createRequire } from "node:module";
import { join } from "node:path";

import { fromJsonSchema, type McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { invokeOperation } from "@tinycloud/operations";

import { toMcpToolResult, type McpToolResult } from "./results.js";
import { logToolCall } from "./logging.js";
import { toMcpJsonSchema } from "./schemas.js";

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
  "tinycloud_knowledge_list",
  "tinycloud_knowledge_read",
  "tinycloud_sql_schema_inspect",
  "tinycloud_sql_query",
  "tinycloud_sql_execute",
  "tinycloud_secrets_get",
  "tinycloud_secrets_status",
  "tinycloud_apps_context",
  "tinycloud_apps_read",
  "tinycloud_apps_write",
  "tinycloud_apps_query",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Private stdio/hosted surfaces and the restricted public plugin. */
export type McpSurface = "local" | "hosted" | "public";

export interface McpStartupSelection {
  /** Which server registers the tools; bindings not on this surface are skipped. */
  readonly surface: McpSurface;
  readonly profile: string;
  readonly explicitProfile: boolean;
  readonly allowOwnerProfile: boolean;
  /** Absolute TinyCloud home used to isolate one hosted principal. */
  readonly stateRoot?: string;
  /** Optional allowlist for surfaces whose grant is narrower than hosted OAuth. */
  readonly allowedTools?: readonly ToolName[];
  /** Check node authority only when an operation needs the account. */
  readonly beforeOperation?: () => Promise<void>;
  /** Hosted transports may attach a browser approval URL to canonical results. */
  readonly transformOperationResult?: (result: unknown, invocation: McpOperationInvocation) => Promise<unknown>;
}

export interface McpOperationInvocation {
  readonly operationId: string;
  readonly operationVersion: number;
  readonly input: unknown;
}

export interface McpInvocationTarget {
  readonly profile: string;
  readonly allowOwnerProfile?: true;
  readonly stateRoot?: string;
}

/** Project one startup selection into the only owner-sensitive target shape. */
export function invocationTargetForMcp(
  selection: Omit<McpStartupSelection, "surface">,
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
  readonly stableErrors: readonly string[];
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
const stableErrorCodes: Readonly<Record<string, true>> = Object.fromEntries(
  generatedCatalog.stableErrors.map((code) => [code, true as const]),
);

export interface ToolBinding {
  readonly name: ToolName;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly readOnlyHint: boolean;
  readonly idempotentHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
  /** Surfaces that register this tool; omitted means private local and hosted surfaces only. */
  readonly surfaces?: readonly McpSurface[];
}

const PRIVATE_SURFACES: readonly McpSurface[] = ["local", "hosted"];

/** The surfaces a binding is registered on. */
export function bindingSurfaces(binding: ToolBinding): readonly McpSurface[] {
  return binding.surfaces ?? PRIVATE_SURFACES;
}

export const TOOL_BINDINGS: readonly ToolBinding[] = [
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
    // Hosted delegations must arrive through the owner/request-bound OpenKey callback,
    // not a caller-supplied import artifact.
    surfaces: ["local"],
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
    name: "tinycloud_knowledge_list",
    operationId: "tinycloud.knowledge.list",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  {
    name: "tinycloud_knowledge_read",
    operationId: "tinycloud.knowledge.read",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
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
  {
    name: "tinycloud_secrets_status",
    operationId: "tinycloud.secrets.status",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
    // Hosted has no persistent reauthorization path for a revoked session
    // yet (TC-896), so status is local/stdio only.
    surfaces: ["local"],
  },
  {
    name: "tinycloud_apps_context",
    operationId: "tinycloud.apps.context",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: false,
    surfaces: ["hosted", "public"],
  },
  {
    name: "tinycloud_apps_read",
    operationId: "tinycloud.apps.read",
    operationVersion: 1,
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
    surfaces: ["hosted", "public"],
  },
  {
    name: "tinycloud_apps_write",
    operationId: "tinycloud.apps.write",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
    surfaces: ["hosted", "public"],
  },
  {
    name: "tinycloud_apps_query",
    operationId: "tinycloud.apps.query",
    operationVersion: 1,
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: false,
    surfaces: ["hosted", "public"],
  },
] as const;

// Project once per process; never mutate the catalog shared with non-MCP consumers.
const definitions = new Map(generatedCatalog.operations.map((operation) => [
  `${operation.id}@${operation.version}`,
  {
    ...operation,
    input: toMcpJsonSchema(operation.input),
    result: toMcpJsonSchema(operation.result),
  },
]));

export function createJsonSchemaValidator(): AjvJsonSchemaValidator {
  return new AjvJsonSchemaValidator();
}

export function registerTinyCloudTools(
  server: McpServer,
  selection: McpStartupSelection,
  validator: AjvJsonSchemaValidator,
): void {
  const bindings = TOOL_BINDINGS.filter((binding) =>
    bindingSurfaces(binding).includes(selection.surface) &&
    (selection.allowedTools === undefined || selection.allowedTools.includes(binding.name)));
  for (const binding of bindings) {
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
        const startedAt = performance.now();
        const metrics = { replayedGrants: 0 };
        let code = "INTERNAL_ERROR";
        try {
          await selection.beforeOperation?.();
          const result = await invokeOperation(
            binding.operationId,
            binding.operationVersion,
            invocationTargetForMcp(selection),
            input,
            metrics,
          );
          const projected = selection.transformOperationResult === undefined
            ? result
            : await selection.transformOperationResult(result, {
              operationId: binding.operationId,
              operationVersion: binding.operationVersion,
              input,
            });
          const response = toMcpToolResult(projected, bindings, {
            surface: selection.surface === "local" ? "local" : "hosted",
            readOnly: binding.readOnlyHint,
            operationId: binding.operationId,
          });
          code = outcomeCode(response.structuredContent);
          return response;
        } finally {
          if (selection.surface !== "local") {
            logToolCall(binding.name, code, startedAt, metrics.replayedGrants);
          }
        }
      },
    );
  }
}

function outcomeCode(result: McpToolResult["structuredContent"]): string {
  if (result.status === "error") {
    const error = result.error as { code?: unknown } | undefined;
    return typeof error?.code === "string" && Object.hasOwn(stableErrorCodes, error.code) ? error.code : "INTERNAL_ERROR";
  }
  if (result.status !== "ok") return result.status;
  const output = result.output as { outcome?: unknown; ops?: readonly { outcome?: unknown }[] } | undefined;
  if (output?.outcome === "COPY_PARTIAL") return "COPY_PARTIAL";
  if (Array.isArray(output?.ops) && output.ops.some((op) => op.outcome !== "ok")) return "PARTIAL";
  return "ok";
}

export function toolBindingsForTest(): readonly ToolBinding[] {
  return TOOL_BINDINGS;
}
