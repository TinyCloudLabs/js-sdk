/** MCP preserves the canonical envelope; hosted clients also receive readable JSON. */
export interface CanonicalOperationResult {
  readonly status: "ok" | "authority_required" | "setup_required" | "error";
  readonly [key: string]: unknown;
}

export interface McpToolResult extends CallToolResult {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: CanonicalOperationResult;
}

/** The binding fields needed to name the tool that runs an operation. */
export interface RecoveryToolBinding {
  readonly name: string;
  readonly operationId: string;
}

export interface McpToolResultOptions {
  readonly surface?: "hosted" | "local";
  readonly readOnly?: boolean;
  /** Trusted operation identity from the tool binding, not operation output. */
  readonly operationId?: string;
}

export function toMcpToolResult(
  result: unknown,
  bindings: readonly RecoveryToolBinding[] = [],
  options: McpToolResultOptions = {},
): McpToolResult {
  let canonical: CanonicalOperationResult = isCanonicalOperationResult(result)
    ? withRecoveryTool(result, bindings)
    : {
      status: "error",
      operation: {},
      context: {},
      error: { code: "INTERNAL_ERROR" },
    };
  let serialized: string | undefined;
  if (options.surface === "hosted") {
    serialized = JSON.stringify(canonical);
    if (
      (options.readOnly === true ||
        options.operationId === "tinycloud.apps.context" ||
        options.operationId === "tinycloud.apps.query") &&
      serialized.length > 100_000
    ) {
      const sql = options.operationId?.startsWith("tinycloud.sql.") ||
        options.operationId === "tinycloud.apps.query";
      canonical = {
        status: "error",
        operation: canonical.operation,
        context: canonical.context,
        error: {
          code: sql ? "SQL_RESULT_LIMIT_EXCEEDED" : "KV_RESPONSE_TOO_LARGE",
          message: sql
            ? "The result exceeds 100,000 characters. Select fewer columns or rows, add a WHERE filter or a smaller LIMIT, or aggregate the data."
            : "The result exceeds 100,000 characters. Request fewer keys, narrow the prefix, or use a smaller page size.",
          retryable: false,
        },
      };
      serialized = JSON.stringify(canonical);
    }
  }

  return {
    content: [{
      type: "text",
      text: resultSummary(canonical.status) +
        (serialized !== undefined && !(options.operationId === "tinycloud.secrets.get" && canonical.status === "ok")
          ? `\n${serialized}` : ""),
    }],
    structuredContent: canonical,
  };
}

/**
 * A redacted `complete_migration` recovery names an operation; MCP clients
 * call tools, so name the bound tool. `tool` comes from the code-owned binding
 * table only, never from operation data, and is added after redaction. An
 * operationId with no binding gets no `tool`.
 */
function withRecoveryTool(
  result: CanonicalOperationResult,
  bindings: readonly RecoveryToolBinding[],
): CanonicalOperationResult {
  if (result.status !== "error") return result;
  // The kernel's redaction already constrained `error.details.recovery` to a
  // safe recovery object; only its discriminant and operationId are read here.
  const error = result.error as
    | { readonly details?: { readonly recovery?: { readonly action?: unknown; readonly operationId?: unknown } } }
    | undefined;
  const recovery = error?.details?.recovery;
  if (recovery?.action !== "complete_migration") return result;
  const binding = bindings.find((candidate) => candidate.operationId === recovery.operationId);
  if (binding === undefined) return result;
  return {
    ...result,
    error: { ...error, details: { ...error?.details, recovery: { ...recovery, tool: binding.name } } },
  };
}

/** The canonical envelope immediately before MCP protocol serialization. */
export function canonicalMcpAdapterResult(result: unknown): CanonicalOperationResult {
  return toMcpToolResult(result).structuredContent;
}

function isCanonicalOperationResult(value: unknown): value is CanonicalOperationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  return status === "ok" ||
    status === "authority_required" ||
    status === "setup_required" ||
    status === "error";
}

function resultSummary(status: CanonicalOperationResult["status"]): string {
  switch (status) {
    case "ok":
      return "TinyCloud operation completed; use the structured result.";
    case "authority_required":
      return "TinyCloud authority is required; use the structured request and approval action.";
    case "setup_required":
      return "TinyCloud setup is required; use the structured setup action.";
    case "error":
      return "TinyCloud operation failed; use the structured error.";
  }
}
import type { CallToolResult } from "@modelcontextprotocol/server";
