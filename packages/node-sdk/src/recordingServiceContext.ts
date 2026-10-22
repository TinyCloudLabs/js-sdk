import {
  ServiceContext,
  type FetchFunction,
  type FetchRequestInit,
  type FetchResponse,
  type InvokeAnyFunction,
  type InvokeFunction,
  type ServiceContextConfig,
} from "@tinycloud/sdk-services";
import {
  buildRequestEvent,
  byteLengthOf,
  declaredLengthOf,
  invocationMetaOf,
  type InvocationMeta,
  type RequestDraft,
  type RequestSink,
} from "@tinycloud/sdk-services/telemetry/requestLog";
import { registerRecording } from "./recordingRegistry";

/**
 * Developer request recording lives here, outside the sdk-services graph that the replica worker
 * bundles. With developer mode off, `createServiceContext` returns a plain `ServiceContext` and
 * none of this code runs.
 */
export type RecordingServiceContextConfig = ServiceContextConfig & { requestSink?: RequestSink };

interface PendingMeta {
  meta?: InvocationMeta;
}

interface AttemptSample {
  url: string;
  init?: FetchRequestInit;
  response?: FetchResponse;
  meta?: InvocationMeta;
  at: number;
  clock: number;
  attempts?: number;
}

const SYNC_ABILITY = "tinycloud.kv/sync";
const INFO_PATH = "/info";

/** Outcome code for every request row: `ok`, `HTTP_<status>`, or `ERROR` when no response arrived. */
function outcomeCodeOf(response: FetchResponse | undefined): string {
  return response === undefined ? "ERROR" : response.ok ? "ok" : `HTTP_${response.status}`;
}

/**
 * Replication traffic, keyed on endpoint shape only: the `/info` feature probe and
 * `tinycloud.kv/sync` invocations. Returns the op for a relabelled row, or undefined for other calls.
 */
function replicationOp(url: string, meta: InvocationMeta | undefined): string | undefined {
  if (meta !== undefined) return meta.action === SYNC_ABILITY ? `${meta.service}/sync` : undefined;
  return isInfoUrl(url) ? "sync/info" : undefined;
}

function isInfoUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === INFO_PATH;
  } catch {
    return false;
  }
}

/**
 * One row per HTTP attempt. Only the host survives (buildRequestEvent's host rule): path, space,
 * and key text are never passed in, so no endpoint or key text reaches a `sync` row.
 */
function replicationEvent(sample: AttemptSample, op: string): RequestDraft {
  return buildRequestEvent({
    service: "sync",
    op,
    url: sample.url,
    bytes: byteLengthOf(sample.init?.body) ?? declaredLengthOf(sample.response?.headers.get("content-length")),
    durationMs: performance.now() - sample.clock,
    attempts: sample.attempts ?? 1,
    ok: sample.response?.ok === true,
    code: outcomeCodeOf(sample.response),
    at: sample.at,
  });
}

/** Plain `ServiceContext` without a sink; a recording context when a sink is given. */
export function createServiceContext(config: RecordingServiceContextConfig): ServiceContext {
  const { requestSink, ...base } = config;
  return requestSink === undefined
    ? new ServiceContext(base)
    : new RecordingServiceContext(base, requestSink);
}

class RecordingServiceContext extends ServiceContext {
  readonly requestSink: RequestSink;
  private readonly pending: PendingMeta;

  constructor(config: ServiceContextConfig, sink: RequestSink) {
    const pending: PendingMeta = {};
    super({
      ...config,
      invoke: rememberInvoke(config.invoke, sink, pending),
      invokeAny: config.invokeAny ? rememberInvokeAny(config.invokeAny, sink, pending) : undefined,
    });
    this.requestSink = sink;
    this.pending = pending;
    registerRecording(this, () => this.unrecordedFetch);
  }

  /** Per-call recording; `_fetch` is read at access time, so overrides apply. */
  override get fetch(): FetchFunction {
    const raw = super.fetch;
    return (url, init) => this.recordCall(raw, url, init);
  }

  /** Transport without per-call recording. */
  get unrecordedFetch(): FetchFunction {
    return super.fetch;
  }

  /**
   * One event per logical request. The first resolved attempt's init is the logged request and
   * `attempts` counts resolved builds. A retired context throws before the first build and records
   * nothing, as master does.
   */
  override async invokeWithRetry(
    url: string,
    build: () => FetchRequestInit | Promise<FetchRequestInit>,
  ): Promise<FetchResponse> {
    const at = Date.now();
    const clock = performance.now();
    let reached = false;
    let attempts = 0;
    let first: FetchRequestInit | undefined;
    let firstMeta: InvocationMeta | undefined;
    let response: FetchResponse | undefined;
    const attempt = async (): Promise<FetchRequestInit> => {
      reached = true;
      this.pending.meta = undefined;
      const built = build();
      const meta = this.pending.meta;
      const init = await built;
      attempts += 1;
      if (first === undefined) {
        first = init;
        firstMeta = meta;
      }
      return init;
    };
    try {
      response = await super.invokeWithRetry(url, attempt);
      return response;
    } finally {
      if (reached) {
        this.observeAttempt({ url, init: first, response, meta: firstMeta, at, clock, attempts });
      }
    }
  }

  private async recordCall(
    fetchFn: FetchFunction,
    url: string,
    init?: FetchRequestInit,
  ): Promise<FetchResponse> {
    const at = Date.now();
    const clock = performance.now();
    let response: FetchResponse | undefined;
    try {
      response = await fetchFn(url, init);
      return response;
    } finally {
      this.observeAttempt({ url, init, response, at, clock });
    }
  }

  private observeAttempt(sample: AttemptSample): void {
    try {
      const replication = replicationOp(sample.url, sample.meta ?? invocationMetaOf(sample.init?.headers));
      if (replication !== undefined) {
        this.requestSink.record(replicationEvent(sample, replication));
        return;
      }
      const headers = sample.init?.headers;
      if (sample.meta !== undefined && typeof headers === "object" && headers !== null) {
        this.requestSink.remember(headers, sample.meta);
      }
      this.requestSink.observe({
        url: sample.url,
        requestHeaders: headers,
        requestBody: sample.init?.body,
        responseContentLength: sample.response?.headers.get("content-length"),
        ok: sample.response?.ok === true,
        code: outcomeCodeOf(sample.response),
        durationMs: performance.now() - sample.clock,
        attempts: sample.attempts ?? 1,
        at: sample.at,
      });
    } catch {
      // Observability must not affect requests.
    }
  }
}

function rememberInvoke(invoke: InvokeFunction, sink: RequestSink, pending: PendingMeta): InvokeFunction {
  return (session, service, path, action, facts) => {
    const headers = invoke(session, service, path, action, facts);
    const meta: InvocationMeta = { service, path, action, spaceId: session.spaceId };
    pending.meta = meta;
    sink.remember(headers, meta);
    return headers;
  };
}

function rememberInvokeAny(
  invokeAny: InvokeAnyFunction,
  sink: RequestSink,
  pending: PendingMeta,
): InvokeAnyFunction {
  return (session, entries, facts) => {
    const headers = invokeAny(session, entries, facts);
    const first = entries[0];
    const meta: InvocationMeta | undefined =
      first === undefined
        ? undefined
        : { service: first.service, path: first.path, action: first.action, spaceId: first.spaceId ?? session.spaceId };
    pending.meta = meta;
    if (meta !== undefined) sink.remember(headers, meta);
    return headers;
  };
}
