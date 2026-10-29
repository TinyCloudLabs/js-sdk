import { authorizationVerdictOf } from "@tinycloud/sdk-core";
import { ExitCode } from "../config/constants.js";

export interface ShareFailureClass {
  readonly code: string;
  readonly exitCode: number;
  /** Fixed wording plus the HTTP status and a vetted upstream code. Never remote text. */
  readonly reason: string;
}

const NETWORK_FAILURE = /\b(?:fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|network ?error|failed to fetch/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function httpStatus(value: unknown): number | undefined {
  const status = typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
  return status;
}

/** The HTTP status an error carries as `status`, `statusCode`, `meta.status`, or the same on its `cause`. */
function statusOf(error: unknown, depth = 0): number | undefined {
  const fields = record(error);
  if (fields === undefined) return undefined;
  const direct = httpStatus(fields.status) ?? httpStatus(fields.statusCode) ?? httpStatus(record(fields.meta)?.status);
  return direct ?? (depth === 0 ? statusOf(fields.cause, 1) : undefined);
}

/** An upstream error code only when it is a plain identifier, so no message text can ride along. */
function codeOf(error: unknown): string | undefined {
  const code = record(error)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : undefined;
}

/**
 * Classify a share failure that no specific mapping claimed, from its HTTP
 * status (or an authorization verdict, or a network failure) alone. The reason
 * is built from fixed wording and the status/code; the error's own message,
 * which can carry response bodies, tokens or links, is never read into it.
 * Returns `undefined` when the error carries no such signal.
 */
export function classifyShareFailure(error: unknown, loginHint: string): ShareFailureClass | undefined {
  const status = statusOf(error);
  const verdict = authorizationVerdictOf(error);
  const message = error instanceof Error ? error.message : "";
  const code = codeOf(error);
  const detail = (text: string): string => {
    const parts = [status === undefined ? undefined : `HTTP ${status}`, code].filter((part) => part !== undefined);
    return parts.length === 0 ? text : `${text} (${parts.join(", ")})`;
  };
  if (verdict === "unauthenticated" || status === 401) {
    return { code: "AUTH_REQUIRED", exitCode: ExitCode.AUTH_REQUIRED, reason: detail(`the node did not accept this session; sign in again with ${loginHint}`) };
  }
  if (verdict === "forbidden" || status === 403) {
    return { code: "PERMISSION_DENIED", exitCode: ExitCode.PERMISSION_DENIED, reason: detail("the node refused this session's authority for the request") };
  }
  if (status === 404) {
    return { code: "NOT_FOUND", exitCode: ExitCode.NOT_FOUND, reason: detail("the node could not find what the request names") };
  }
  if (status !== undefined && (status >= 500 || status === 408 || status === 429)) {
    return { code: "NODE_UNAVAILABLE", exitCode: ExitCode.NODE_ERROR, reason: detail("the node could not complete the request; try again shortly") };
  }
  if (status === 400 || status === 422) {
    return { code: "INVALID_ARGUMENT", exitCode: ExitCode.USAGE_ERROR, reason: detail("the node rejected the request as invalid") };
  }
  if (status !== undefined) {
    return { code: "NODE_REJECTED", exitCode: ExitCode.ERROR, reason: detail("the node rejected the request") };
  }
  if (NETWORK_FAILURE.test(message) || (typeof record(error)?.code === "string" && NETWORK_FAILURE.test(String(record(error)?.code)))) {
    return { code: "NETWORK_ERROR", exitCode: ExitCode.NETWORK_ERROR, reason: "the TinyCloud node could not be reached; check the connection and retry" };
  }
  return undefined;
}

/**
 * Last-resort diagnostic only. Never serialize the error, its cause, stack or response body.
 * Strip credential-bearing strings before bounding output so a truncated token cannot escape.
 */
export function unknownShareDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError: share operation failed";
  const className = error.name === "Error" ? error.constructor.name : error.name;
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(className) ? className : "Error";
  const message = error.message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']*/gi, "[redacted-url]")
    .replace(/["'][^"'\r\n]*["']/g, "[redacted]")
    .replace(/\b(?:Bearer|Invocation|Basic)\s+\S+/gi, "[redacted]")
    // A sensitive value can contain spaces or line breaks; suppress the entire remaining value.
    .replace(/\b(?:private[-_ ]?key|api[-_]?key|(?:access|refresh)[-_]?token|secret|token|password|authorization|session[-_ ]?(?:id|key)|credential|seed(?: phrase)?|mnemonic|recovery phrase)\s*[:=]\s*[\s\S]*/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_~.-]+/g, "[redacted]")
    .replace(/\b(?:tc1[-=][^\s]+|bafy[a-z0-9]+|bafk[a-z0-9]+)\b/gi, "[redacted]")
    .replace(/[#?][^\s]+/g, "[redacted]")
    .replace(/[A-Za-z0-9_+/-]{24,}={0,2}/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .trim();
  return `${name}: ${message || "share operation failed"}`.slice(0, 600);
}
