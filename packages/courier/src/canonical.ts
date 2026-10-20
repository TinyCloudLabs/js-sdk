import { createHash } from 'node:crypto';

/**
 * Canonical JSON for hashing: object keys sorted recursively in UTF-16 code-unit order, no whitespace, arrays in
 * order; otherwise `JSON.stringify` of the key-sorted tree. The `/courier` view mirrors this function: an
 * approval's `requestHash` is `requestHash(<parsed me/requests/<id>.json>)`, so both sides must agree byte for byte.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of {@link canonicalJson}. */
export function requestHash(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}
