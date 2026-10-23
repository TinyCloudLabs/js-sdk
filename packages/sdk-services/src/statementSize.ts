/**
 * Size errors for a 413 from the SQL and DuckDB nodes.
 *
 * This module exports one function. Everything else lives inside it, so the
 * bundle gets no extra top-level names. The request-too-large code is a plain
 * string literal, not an entry of the runtime ErrorCodes object in types.ts.
 */

export type StatementClass = "read" | "write" | "ambiguous";

/**
 * The size error for a 413, or undefined for any other status. `request` is
 * true for a request-side size, false for a response-side size. The node's code
 * decides first: a code prefix (or a bare code) names the side, and the
 * statement decides only when the node sent no code. `detail` is the service's
 * formatted error, appended after the short sentence unchanged. `code` is set
 * only for the request side; a response-side error keeps the HTTP mapping.
 */
export function requestTooLargeError(
  engine: "sql" | "duckdb",
  status: number,
  errorText: string,
  statement: StatementClass | { sql: string },
  detail: string,
): { code: string | undefined; message: string } | undefined {
  if (status !== 413) return undefined;

  function classify(sql: string): StatementClass {
    const token = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([A-Za-z_]+)/.exec(sql)?.[1]?.toLowerCase();
    if (token === "select" || token === "values") return "read";
    if (token === "with" || token === "explain" || token === "show" || token === "describe") return "ambiguous";
    return "write";
  }

  const name = engine === "sql" ? "SQL" : "DuckDB";
  const colon = errorText.indexOf(":");
  const nodeCode = (colon === -1 ? errorText : errorText.slice(0, colon)).trim();
  let request: boolean;
  if (nodeCode === `${engine}_request_too_large`) {
    request = true;
  } else if (nodeCode === `${engine}_response_too_large`) {
    request = false;
  } else {
    const statementClass = typeof statement === "string" ? statement : classify(statement.sql);
    request = statementClass === "write" || (statementClass === "ambiguous" && errorText.includes("envelope limit"));
  }
  return {
    code: request ? `${name.toUpperCase()}_REQUEST_TOO_LARGE` : undefined,
    message: `${name} ${request ? "request" : "response"} too large. ${detail}`,
  };
}
