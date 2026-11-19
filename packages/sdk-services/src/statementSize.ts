/**
 * Request-side size code for a 413 from the SQL and DuckDB nodes.
 *
 * Returns `SQL_REQUEST_TOO_LARGE` or `DUCKDB_REQUEST_TOO_LARGE` when the 413 is
 * request-side, or undefined when the caller keeps its HTTP-mapped response code.
 * The node's own code prefix decides when present, and only this engine's
 * prefixes match; another engine's code falls through to the operation rule.
 * Without a matching prefix, the write-class operations (`batch`,
 * `executeStatement`, `import`) are request-side and every other operation is
 * response-side.
 */
export function requestTooLargeError(
  engine: "sql" | "duckdb",
  operation: string,
  status: number,
  errorText: string,
): string | undefined {
  if (status !== 413) return undefined;

  const nodeCode = errorText.split(":", 1)[0].trim();
  let request: boolean;
  if (nodeCode === `${engine}_request_too_large`) {
    request = true;
  } else if (nodeCode === `${engine}_response_too_large`) {
    request = false;
  } else {
    request = ["batch", "executeStatement", "import"].includes(operation);
  }
  return request ? `${engine.toUpperCase()}_REQUEST_TOO_LARGE` : undefined;
}
