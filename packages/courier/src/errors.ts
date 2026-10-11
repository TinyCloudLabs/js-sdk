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
