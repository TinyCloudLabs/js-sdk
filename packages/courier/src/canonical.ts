import { createHash } from 'node:crypto';
import { CourierError } from './errors.js';

/** Deepest nesting `canonicalJson` accepts: a top-level object or array is depth 1. Shared with the view. */
export const MAX_CANONICAL_DEPTH = 64;

/**
 * Canonical JSON for hashing: object keys sorted recursively in UTF-16 code-unit order, no whitespace, arrays in
 * order; otherwise `JSON.stringify` of the key-sorted tree. The `/courier` view mirrors this function: an
 * approval's `requestHash` is `requestHash(<parsed me/requests/<id>.json>)`, so both sides must agree byte for byte.
 *
 * Throws `CourierError('canonical-invalid')` for a non-finite number (a parsed `1e999` is Infinity, which
 * `JSON.stringify` would silently turn into `null`) and for nesting deeper than {@link MAX_CANONICAL_DEPTH}: a
 * request like that is never written and never approved.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, 1));
}

function sortKeys(value: unknown, depth: number): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new CourierError('canonical-invalid', 'Not hashable: a number is not finite (for example 1e999).');
  }
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    if (depth > MAX_CANONICAL_DEPTH) throw new CourierError('canonical-invalid', `Not hashable: nested deeper than ${MAX_CANONICAL_DEPTH} levels.`);
  }
  if (Array.isArray(value)) return value.map((item) => sortKeys(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    // defineProperty, not assignment: a parsed `"__proto__"` key must stay an own property (assignment would set the
    // prototype and drop it from the hash, and the view's string-built canonical JSON keeps it).
    for (const key of Object.keys(source).sort()) {
      Object.defineProperty(sorted, key, { value: sortKeys(source[key], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return sorted;
  }
  return value;
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of {@link canonicalJson}. Throws like it. */
export function requestHash(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}
