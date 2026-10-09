import { ErrorCodes, type Result } from "../../types";

const DEFINITIVE_FAILURES = new Set<string>([
  ErrorCodes.AUTH_REQUIRED, ErrorCodes.INVALID_INPUT, ErrorCodes.AUTH_UNAUTHORIZED,
  ErrorCodes.KV_PRECONDITION_FAILED, ErrorCodes.STORAGE_QUOTA_EXCEEDED, ErrorCodes.STORAGE_LIMIT_REACHED,
]);

export function classifyWriteOutcome<T>(op: "put" | "delete" | "batchPut", result: Result<T>): "committed" | "failed" | "ambiguous" {
  if (result.ok) return "committed";
  const { code, meta } = result.error;
  if (op === "delete" && code === ErrorCodes.KV_NOT_FOUND) return "committed";
  if (meta?.requestMayHaveDispatched === false) return "failed";
  if (DEFINITIVE_FAILURES.has(code)) return "failed";
  if (meta?.outcome === "batch-unconfirmed") return "ambiguous";
  const status = typeof meta?.status === "number" ? meta.status : undefined;
  if (status !== undefined && status >= 400 && status < 500) return "failed";
  return "ambiguous";
}
