/**
 * Error codes only the SQL service raises. Kept out of the shared `ErrorCodes`
 * object (and out of the modules the service itself imports) so that bundles
 * which never read them (the replica workers, the web bundle) do not carry them.
 */
export const SqlErrorCodes = {
  /**
   * HTTP 403: the delegation's SQL caveats (tables, columns, read-only) do not
   * allow the request. `meta.arm` is `table`, `column`, `write` or `chain`
   * when the node named one; the message never carries SQL.
   */
  SQL_CAVEAT_VIOLATION: "SQL_CAVEAT_VIOLATION",
} as const;
