/**
 * Statement classification and request-side size errors shared by the SQL and
 * DuckDB services.
 *
 * The request-too-large error codes are plain string literals, deliberately not
 * entries of the runtime ErrorCodes object in types.ts: that object is bundled
 * into every entry point, and the wire string is the contract.
 */

export type StatementClass = "read" | "write" | "ambiguous";

interface SizeEngine {
  label: string;
  requestNodeCode: string;
  responseNodeCode: string;
  errorCode: string;
}

const SIZE_ENGINES: Record<"sql" | "duckdb", SizeEngine> = {
  sql: {
    label: "SQL",
    requestNodeCode: "sql_request_too_large",
    responseNodeCode: "sql_response_too_large",
    errorCode: "SQL_REQUEST_TOO_LARGE",
  },
  duckdb: {
    label: "DuckDB",
    requestNodeCode: "duckdb_request_too_large",
    responseNodeCode: "duckdb_response_too_large",
    errorCode: "DUCKDB_REQUEST_TOO_LARGE",
  },
};

/** First keyword of a statement, lowercased, skipping leading whitespace and comments. */
export function firstSqlToken(sql: string): string | undefined {
  const match = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([A-Za-z_]+)/.exec(sql);
  return match?.[1].toLowerCase();
}

export function statementClassOf(sql: string): StatementClass {
  const token = firstSqlToken(sql);
  if (token === "select" || token === "values") return "read";
  if (token === "with" || token === "explain" || token === "show" || token === "describe") return "ambiguous";
  return "write";
}

// The node's limit, shown in the request-side message only when the node coded the cause.
const NODE_LIMIT_CLAUSE = /\(limit (\d+) bytes\)/;

/**
 * The request-too-large error for a 413, or undefined when the 413 is a response-side
 * size. The node's stable code (alone or before the first colon) decides; without
 * one (older nodes) the statement class decides: reads answer with the response size,
 * writes with the request size, ambiguous statements use the envelope text.
 */
export function requestTooLargeError(
  engine: keyof typeof SIZE_ENGINES,
  operation: string,
  errorText: string,
  statementClass: StatementClass,
): { code: string; message: string } | undefined {
  const spec = SIZE_ENGINES[engine];
  const colon = errorText.indexOf(":");
  const nodeCode = (colon === -1 ? errorText : errorText.slice(0, colon)).trim();

  if (nodeCode !== spec.requestNodeCode) {
    const request = nodeCode !== spec.responseNodeCode
      && (statementClass === "write" || (statementClass === "ambiguous" && errorText.includes("envelope limit")));
    if (!request) return undefined;
  }

  const limit = nodeCode === spec.requestNodeCode ? NODE_LIMIT_CLAUSE.exec(errorText)?.[1] : undefined;
  const suffix = limit === undefined ? "" : ` (the node's limit is ${limit} bytes)`;
  return {
    code: spec.errorCode,
    message: `${spec.label} ${operation} failed: request is too large${suffix}. Split the batch into smaller requests.`,
  };
}
