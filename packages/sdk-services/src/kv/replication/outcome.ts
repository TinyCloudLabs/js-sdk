import { ErrorCodes, type Result } from "../../types";

const DEFINITIVE_FAILURES = new Set<string>([
  ErrorCodes.AUTH_REQUIRED, ErrorCodes.INVALID_INPUT, ErrorCodes.AUTH_UNAUTHORIZED,
  ErrorCodes.KV_PRECONDITION_FAILED, ErrorCodes.STORAGE_QUOTA_EXCEEDED, ErrorCodes.STORAGE_LIMIT_REACHED,
]);

export function classifyWriteOutcome<T>(
  op: "put" | "delete" | "batchPut",
  result: Result<T>,
  options: { conditional?: boolean } = {},
): "committed" | "failed" | "ambiguous" {
  if (result.ok) return "committed";
  const { code, meta } = result.error;
  if (op === "delete" && code === ErrorCodes.KV_NOT_FOUND) {
    return options.conditional ? "failed" : "committed";
  }
  // NODE_BUSY is the node's 503 busy marker: nothing was applied.
  if (meta?.requestMayHaveDispatched === false || DEFINITIVE_FAILURES.has(code) || code === ErrorCodes.NODE_BUSY) return "failed";
  const status = meta?.status;
  return meta?.outcome !== "batch-unconfirmed" && typeof status === "number" && status >= 400 && status < 500 ? "failed" : "ambiguous";
}
