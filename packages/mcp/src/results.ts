/**
 * MCP has one structured result channel for a TinyCloud operation. Text is a
 * fixed, non-sensitive status line; it never serializes the operation result.
 */
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

export function toMcpToolResult(
  result: unknown,
  bindings: readonly RecoveryToolBinding[] = [],
): McpToolResult {
  const canonical: CanonicalOperationResult = isCanonicalOperationResult(result)
    ? withRecoveryTool(result, bindings)
    : {
      status: "error",
      operation: {},
      context: {},
      error: { code: "INTERNAL_ERROR" },
    };

  return {
    content: [{ type: "text", text: resultSummary(canonical.status) }],
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
