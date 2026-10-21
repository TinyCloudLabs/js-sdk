/** Courier CLI error with a stable machine-readable code. */
export class CourierError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CourierError';
    this.code = code;
  }
}

/** Shape of SDK Result objects and thrown errors, normalised for output. */
export function errInfo(e: unknown): { name?: string; code?: unknown; message: string } {
  if (!e) return { message: 'unknown error' };
  if (e instanceof CourierError) return { name: e.name, code: e.code, message: e.message };
  const anyE = e as Record<string, unknown>;
  return {
    name: typeof anyE.name === 'string' ? anyE.name : undefined,
    code: anyE.code ?? anyE.status,
    message: String(anyE.message ?? e).slice(0, 400),
  };
}

export interface ResultLike<T> {
  ok: boolean;
  data?: T;
  error?: { code?: unknown; message?: string; status?: unknown; meta?: { status?: unknown } };
}

const TRANSIENT_CODES = ['NETWORK_ERROR', 'ECONNRESET', 'ETIMEDOUT'];

/** Reads one structured field. Message text is never parsed: keys and messages can contain any digits. */
function fieldOf(source: unknown, name: string): unknown {
  return typeof source === 'object' && source !== null ? Reflect.get(source, name) : undefined;
}

function asStatus(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

/** HTTP statuses from the `status`, `meta.status` and numeric `code` fields. Each field is checked on its own. */
function httpStatuses(error: unknown): number[] {
  return [fieldOf(error, 'status'), fieldOf(fieldOf(error, 'meta'), 'status'), fieldOf(error, 'code')]
    .map(asStatus)
    .filter((s): s is number => s !== undefined);
}

/** Conditional write rejected by the store (HTTP 412 or KV_PRECONDITION_FAILED). */
export function isPreconditionError(error: unknown): boolean {
  return fieldOf(error, 'code') === 'KV_PRECONDITION_FAILED' || httpStatuses(error).includes(412);
}

/** Key or space missing (HTTP 404 or KV_NOT_FOUND). */
export function isNotFoundError(error: unknown): boolean {
  return fieldOf(error, 'code') === 'KV_NOT_FOUND' || httpStatuses(error).includes(404);
}

/** Node-side or network failure worth a bounded retry on an idempotent read: any 5xx, or a network code. */
export function isTransientError(error: unknown): boolean {
  if (httpStatuses(error).some((s) => s >= 500 && s <= 599)) return true;
  const code = fieldOf(error, 'code');
  const causeCode = fieldOf(fieldOf(error, 'cause'), 'code');
  return TRANSIENT_CODES.some((c) => c === code || c === causeCode);
}

/** Unwrap an SDK Result, throwing a CourierError on failure. */
export function unwrap<T>(r: ResultLike<T> | T, what: string): T {
  if (r && typeof r === 'object' && 'ok' in (r as ResultLike<T>)) {
    const res = r as ResultLike<T>;
    if (!res.ok) {
      const code = String(res.error?.code ?? res.error?.status ?? res.error?.meta?.status ?? 'sdk-error');
      throw new CourierError(code, `${what}: ${res.error?.message ?? 'failed'}`);
    }
    return res.data as T;
  }
  return r as T;
}
