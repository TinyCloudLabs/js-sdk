import { ExitCode } from "../config/constants.js";

/** What `errors.ts` turns into a `CLIError`. */
export interface SqlCaveatErrorFields {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
  readonly metadata?: Record<string, unknown>;
}

/** DRAFT wording: one fixed line per refusal arm; the node's text and any SQL never reach the output. */
const SQL_CAVEAT_VIOLATION_MESSAGES: Readonly<Record<string, string>> = {
  table: "This grant doesn't allow that table.",
  column: "This grant doesn't allow that column.",
  write: "This grant doesn't allow changes.",
  chain: "This grant can't be checked, so nothing ran.",
};
const SQL_CAVEAT_VIOLATION_DEFAULT_MESSAGE = "This grant doesn't allow that request.";
const SQL_DELEGATED_CAVEATS_UNSUPPORTED_MESSAGE =
  "This node can't limit SQL grants to tables or columns yet, so nothing was sent.";

/**
 * The SDK's delegated SQL caveat codes as fixed messages. `SQL_CAVEAT_VIOLATION`
 * (a node refusal) exits as a permission denial and names only the arm;
 * `SQL_DELEGATED_CAVEATS_UNSUPPORTED` (refused before any request) exits as a
 * usage error. Read from an SDK error's `meta` or a CLIError's `metadata`.
 * `prefix` is the command's own progress note (as `throwSqlError` adds); the
 * node's text is never part of it.
 */
export function sqlCaveatErrorFields(error: unknown, prefix = ""): SqlCaveatErrorFields | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, meta, metadata } = error as { code?: unknown; meta?: unknown; metadata?: unknown };
  if (code === "SQL_DELEGATED_CAVEATS_UNSUPPORTED") {
    return { code, message: SQL_DELEGATED_CAVEATS_UNSUPPORTED_MESSAGE, exitCode: ExitCode.USAGE_ERROR };
  }
  if (code !== "SQL_CAVEAT_VIOLATION") return undefined;
  const details = (typeof meta === "object" && meta !== null ? meta : typeof metadata === "object" && metadata !== null ? metadata : {}) as Record<string, unknown>;
  const arm = typeof details.arm === "string" && Object.hasOwn(SQL_CAVEAT_VIOLATION_MESSAGES, details.arm) ? details.arm : undefined;
  const fixed = arm === undefined ? SQL_CAVEAT_VIOLATION_DEFAULT_MESSAGE : SQL_CAVEAT_VIOLATION_MESSAGES[arm]!;
  return {
    code,
    message: `${prefix}${fixed}`,
    exitCode: ExitCode.PERMISSION_DENIED,
    metadata: { status: 403, ...(arm === undefined ? {} : { arm }) },
  };
}
