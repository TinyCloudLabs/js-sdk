import { createHash } from 'node:crypto';
import { CourierError } from './errors.js';

/** Deepest nesting `canonicalJson` accepts: a top-level object or array is depth 1. Shared with the view. */
export const MAX_CANONICAL_DEPTH = 64;

/**
 * Canonical JSON for hashing: object keys sorted recursively in UTF-16 code-unit order (integer-like keys too: `{"10":1,"9":2}`
 * is `{"10":1,"9":2}`), no whitespace, arrays in order, values as `JSON.stringify` writes them. The `/courier` view mirrors this function: an
 * approval's `requestHash` is `requestHash(<parsed me/requests/<id>.json>)`, so both sides must agree byte for byte.
 *
 * Throws `CourierError('canonical-invalid')` for a non-finite number (a parsed `1e999` is Infinity, which
 * `JSON.stringify` would silently turn into `null`) and for nesting deeper than {@link MAX_CANONICAL_DEPTH}: a
 * request like that is never written and never approved.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, 1);
}

/** Built as a string from the sorted entries (never by rebuilding an object, whose integer-like keys JS would reorder numerically). */
function canonicalize(value: unknown, depth: number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CourierError('canonical-invalid', 'Not hashable: a number is not finite (for example 1e999).');
    return JSON.stringify(value);
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (depth > MAX_CANONICAL_DEPTH) throw new CourierError('canonical-invalid', `Not hashable: nested deeper than ${MAX_CANONICAL_DEPTH} levels.`);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, depth + 1)).join(',')}]`;
  const source = value as Record<string, unknown>;
  // Default sort order is UTF-16 code-unit order, as specified. A parsed "__proto__" key is an own key and is kept.
  const entries = Object.keys(source).sort().flatMap((key) => (source[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalize(source[key], depth + 1)}`]));
  return `{${entries.join(',')}}`;
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of {@link canonicalJson}. Throws like it. */
export function requestHash(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}
