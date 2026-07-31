export type HttpTimingPhase = "headers" | "total";

export interface HttpTimingContext {
  benchmark: string;
  iteration: number;
}

export interface HttpTimingSample extends HttpTimingContext {
  requestId: number;
  phase: HttpTimingPhase;
  method: string;
  path: string;
  ok: boolean;
  durationMs: number;
  status?: number;
  requestBodyBytes?: number;
  responseBodyBytes?: number;
  authorizationBytes?: number;
  error?: string;
}

export interface TimedFetchOptions {
  server: string;
  context: () => HttpTimingContext;
  record: (sample: HttpTimingSample) => void;
  logRequests?: boolean;
}

export type FetchCall = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const BODY_CONSUMERS = new Set<PropertyKey>([
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
]);

export function createTimedFetch(
  fetchFn: FetchCall,
  options: TimedFetchOptions,
): FetchCall {
  const serverOrigin = new URL(options.server).origin;
  let nextRequestId = 1;

  return (async (input, init) => {
    const url = requestUrl(input);
    if (url.origin !== serverOrigin) {
      return fetchFn(input, init);
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    const context = options.context();
    const method = requestMethod(input, init);
    const path = url.pathname;
    const requestBodyBytes = bodyBytes(init?.body);
    const authorizationBytes = headerBytes(input, init, "authorization");
    const startedAt = performance.now();

    try {
      const response = await fetchFn(input, init);
      const headersDurationMs = performance.now() - startedAt;
      const responseBodyBytes = contentLength(response);
      const common = {
        requestId,
        benchmark: context.benchmark,
        iteration: context.iteration,
        method,
        path,
        ok: response.ok,
        status: response.status,
        requestBodyBytes,
        responseBodyBytes,
        authorizationBytes,
      };

      options.record({
        ...common,
        phase: "headers",
        durationMs: headersDurationMs,
      });
      if (options.logRequests) {
        console.log(
          `[HTTP #${requestId}] ${context.benchmark} ${method} ${path} ` +
            `${response.status} headers=${headersDurationMs.toFixed(2)}ms`,
        );
      }

      let totalRecorded = false;
      const recordTotal = (error?: unknown): void => {
        if (totalRecorded) return;
        totalRecorded = true;
        const durationMs = performance.now() - startedAt;
        const sample: HttpTimingSample = {
          ...common,
          phase: "total",
          ok: response.ok && error === undefined,
          durationMs,
          ...(error === undefined ? {} : { error: errorMessage(error) }),
        };
        options.record(sample);
      };

      if (response.body === null || method === "HEAD" || response.status === 204 || response.status === 304) {
        recordTotal();
        return response;
      }

      return wrapResponse(response, recordTotal);
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const common = {
        requestId,
        benchmark: context.benchmark,
        iteration: context.iteration,
        method,
        path,
        ok: false,
        durationMs,
        requestBodyBytes,
        authorizationBytes,
        error: errorMessage(error),
      };
      options.record({ ...common, phase: "headers" });
      options.record({ ...common, phase: "total" });
      if (options.logRequests) {
        console.log(
          `[HTTP #${requestId}] ${context.benchmark} ${method} ${path} ` +
            `ERROR ${durationMs.toFixed(2)}ms`,
        );
      }
      throw error;
    }
  }) as FetchCall;
}

function wrapResponse(response: Response, recordTotal: (error?: unknown) => void): Response {
  return new Proxy(response, {
    get(target, property) {
      if (BODY_CONSUMERS.has(property)) {
        const consume = Reflect.get(target, property, target);
        if (typeof consume === "function") {
          return async (...args: unknown[]) => {
            try {
              const result = await consume.apply(target, args);
              recordTotal();
              return result;
            } catch (error) {
              recordTotal(error);
              throw error;
            }
          };
        }
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function headerBytes(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): number | undefined {
  const value = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name);
  return value === null ? undefined : new TextEncoder().encode(value).byteLength;
}

function bodyBytes(body: BodyInit | null | undefined): number | undefined {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }
  return undefined;
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
