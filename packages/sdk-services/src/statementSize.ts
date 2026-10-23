/**
 * Size errors for a 413 from the SQL and DuckDB nodes.
 *
 * This module exports one function. The node's code prefix decides the side.
 * Without a code, the requested operation decides: read operations are
 * response-side, everything else is request-side. An uncoded 413 on `execute`
 * is therefore request-side even for a SELECT.
 */

/**
 * The size error for a 413, or undefined for any other status. `detail` is the
 * service's formatted error, appended after the short sentence unchanged. `code`
 * is set only for the request side; a response-side error keeps the HTTP mapping.
 */
export function requestTooLargeError(
  engine: "sql" | "duckdb",
  operation: string,
  status: number,
  errorText: string,
  detail: string,
): { code: string | undefined; message: string } | undefined {
  if (status !== 413) return undefined;

  const nodeCode = errorText.split(":", 1)[0].trim();
  let request: boolean;
  if (["sql_request_too_large", "duckdb_request_too_large"].includes(nodeCode)) {
    request = true;
  } else if (["sql_response_too_large", "duckdb_response_too_large"].includes(nodeCode)) {
    request = false;
  } else {
    request = !["query", "queryArrow", "describe", "export"].includes(operation);
  }

  const name = engine === "sql" ? "SQL" : "DuckDB";
  return {
    code: request ? (engine === "sql" ? "SQL_REQUEST_TOO_LARGE" : "DUCKDB_REQUEST_TOO_LARGE") : undefined,
    message: `${name} ${request ? "request" : "response"} too large. ${detail}`,
  };
}
