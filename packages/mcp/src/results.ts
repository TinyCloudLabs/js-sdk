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

export function toMcpToolResult(result: unknown): McpToolResult {
  const canonical: CanonicalOperationResult = isCanonicalOperationResult(result)
    ? result
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
