import type { FetchFunction, ServiceContext } from "@tinycloud/sdk-services";
import type { RequestSink } from "@tinycloud/sdk-services/telemetry/requestLog";

/**
 * Sink and raw transport for contexts that `createServiceContext` built with a request sink.
 * Type-only imports keep this module free of sdk-services values, so replica-side readers
 * (`replication/runtime.ts`) do not pull the recording class into the replica worker bundle.
 */
export interface Recording {
  requestSink: RequestSink;
  /** Read at call time so `_fetch` overrides still reach the transport. */
  unrecordedFetch: () => FetchFunction;
}

const recordings = new WeakMap<ServiceContext, Recording>();

export function registerRecording(context: ServiceContext, recording: Recording): void {
  recordings.set(context, recording);
}

/**
 * The transport fetch for a context: `context.fetch` for a plain context (identical to master),
 * the raw transport for a recording context, so the caller's own recording is not doubled.
 */
export function unrecordedFetchOf(context: ServiceContext): FetchFunction {
  const recording = recordings.get(context);
  return recording ? recording.unrecordedFetch() : context.fetch;
}

/** The sink behind a recording context; undefined for a plain context. */
export function requestSinkOf(context: ServiceContext): RequestSink | undefined {
  return recordings.get(context)?.requestSink;
}
