import { buildRequestEvent, type RequestSink } from "@tinycloud/sdk-services";

type Draft = Parameters<RequestSink["record"]>[0];

/**
 * Relabels the replication transport's invocations as `service: "sync"`. Path and space are
 * dropped, so replication traffic never carries key or space text into the log.
 */
export function syncRequestSink(sink: RequestSink): RequestSink {
  return {
    record: (event: Draft) => sink.record({ ...event, service: "sync", path: null, space: null }),
  };
}

/**
 * Wraps the `/info` feature probe so each network attempt records one `service: "sync"` row.
 * Only installed when a sink exists; with developer mode off the probe uses `fetch` unchanged.
 */
export function recordingInfoFetch(fetchFn: typeof globalThis.fetch, sink: RequestSink): typeof globalThis.fetch {
  const record = (url: string, started: number, ok: boolean, code: string) =>
    sink.record(
      buildRequestEvent({
        service: "sync",
        op: "sync/info",
        url,
        bytes: null,
        durationMs: performance.now() - started,
        attempts: 1,
        ok,
        code,
        source: "network",
        at: Date.now(),
      }),
    );
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const started = performance.now();
    let response: Response;
    try {
      response = await fetchFn(input, init);
    } catch (error) {
      record(url, started, false, "ERROR");
      throw error;
    }
    record(url, started, response.ok, response.ok ? "ok" : `HTTP_${response.status}`);
    return response;
  }) as typeof globalThis.fetch;
}
