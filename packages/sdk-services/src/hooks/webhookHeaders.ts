/**
 * Custom headers on a webhook registration, for receivers that need their own
 * credential (for example `Authorization: Bearer <key>`). The node stores the
 * values encrypted, never lists or logs them, and repeats these checks; they run
 * here first so a bad registration fails before any request is sent.
 */

export const WEBHOOK_HEADER_LIMITS = {
  maxHeaders: 8,
  maxNameLength: 64,
  maxValueLength: 1024,
  maxTotalLength: 4096,
} as const;

/** Headers the delivery itself sets or that change how it is routed, framed or authenticated by a proxy. */
const RESERVED_HEADERS: Readonly<Record<string, true>> = {
  "host": true,
  "content-length": true,
  "content-type": true,
  "content-encoding": true,
  "content-range": true,
  "content-md5": true,
  "transfer-encoding": true,
  "accept-encoding": true,
  "connection": true,
  "keep-alive": true,
  "proxy-connection": true,
  "te": true,
  "trailer": true,
  "upgrade": true,
  "expect": true,
  "cookie": true,
  "cookie2": true,
  "set-cookie": true,
  "forwarded": true,
  "via": true,
  "x-real-ip": true,
};
const RESERVED_PREFIXES = ["x-tinycloud-", "x-forwarded-", "proxy-", "sec-"] as const;

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Visible ASCII, space and tab: no CR, LF, NUL or other controls, no non-ASCII. */
const FIELD_VALUE = /^[\t\x20-\x7e]+$/;

export function isReservedWebhookHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return Object.prototype.hasOwnProperty.call(RESERVED_HEADERS, lower) || RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The first problem with `headers`, or `undefined` when they are acceptable.
 * The message names the header, never its value.
 */
export function webhookHeadersProblem(headers: unknown): string | undefined {
  if (headers === undefined) return undefined;
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return "Webhook headers must be an object of header names to string values";
  }
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > WEBHOOK_HEADER_LIMITS.maxHeaders) {
    return `Webhook headers are limited to ${WEBHOOK_HEADER_LIMITS.maxHeaders} entries`;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > WEBHOOK_HEADER_LIMITS.maxNameLength || !TOKEN.test(name)) {
      return `Webhook header name is not a valid HTTP header name (1-${WEBHOOK_HEADER_LIMITS.maxNameLength} token characters)`;
    }
    const lower = name.toLowerCase();
    if (isReservedWebhookHeader(lower)) return `Webhook header "${name}" is reserved and cannot be set`;
    if (seen.has(lower)) return `Webhook header "${name}" is given more than once`;
    seen.add(lower);
    if (typeof value !== "string" || value.length === 0 || value.length > WEBHOOK_HEADER_LIMITS.maxValueLength ||
      !FIELD_VALUE.test(value) || value.trim() !== value) {
      return `Webhook header "${name}" needs a non-empty value of printable ASCII, at most ${WEBHOOK_HEADER_LIMITS.maxValueLength} characters, without surrounding whitespace`;
    }
    total += name.length + value.length;
  }
  if (total > WEBHOOK_HEADER_LIMITS.maxTotalLength) {
    return `Webhook headers are limited to ${WEBHOOK_HEADER_LIMITS.maxTotalLength} characters in total`;
  }
  return undefined;
}
