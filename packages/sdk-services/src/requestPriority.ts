import { nodeRetryError } from "./errors";
import { abortableSleep } from "./sleep";
import { ErrorCodes, type FetchFunction, type FetchRequestInit, type FetchResponse } from "./types";

const FOREGROUND_QUIET_MS = 400;
const scheduled = Symbol.for("@tinycloud/sdk-services/scheduled-request");
const lanesKey = Symbol.for("@tinycloud/sdk-services/request-lanes");

export type RequestPriority = "foreground" | "background";
type Request = FetchRequestInit & { [scheduled]?: true };

export function isScheduled(init: FetchRequestInit | undefined): boolean {
  return (init as Request | undefined)?.[scheduled] === true;
}

export function scheduledRequest(init: FetchRequestInit, priority: RequestPriority): Request {
  return { ...init, priority: priority === "foreground" ? "high" : "low", [scheduled]: true };
}

type BrowserLocks = {
  request(
    name: string,
    options: { mode?: "shared"; signal?: AbortSignal; ifAvailable?: boolean },
    callback: (lock: object | null) => void | Promise<void>,
  ): Promise<void>;
};

const browser = globalThis as typeof globalThis & {
  navigator?: { locks?: BrowserLocks };
  location?: { href: string };
};

type Lane = {
  foreground: number;
  background: boolean;
  resumeAt: number;
};

// Multiple SDK entrypoints may bundle ServiceContext separately.
const shared = globalThis as typeof globalThis & { [lanesKey]?: Map<string, Lane> };
const lanes = shared[lanesKey] ??= new Map<string, Lane>();

function laneFor(host: string): Lane {
  const existing = lanes.get(host);
  if (existing) return existing;
  const lane: Lane = { foreground: 0, background: false, resumeAt: 0 };
  lanes.set(host, lane);
  return lane;
}

async function busyPause(response: FetchResponse): Promise<number> {
  if (response.status !== 503 || !response.clone) return 0;
  const text = await response.clone().text().catch(() => "");
  const error = nodeRetryError("", "", response, text);
  const retryAfterMs = error?.meta?.retryAfterMs;
  return error?.code === ErrorCodes.NODE_BUSY
    ? Math.min(60_000, Math.max(FOREGROUND_QUIET_MS, typeof retryAfterMs === "number" ? retryAfterMs : 0))
    : 0;
}

/** Release the lane on body completion or cancellation, preserving streaming and backpressure. */
function trackResponse(response: FetchResponse): { response: FetchResponse; finished: Promise<void> } {
  const retry = response.retry;
  if (!(response instanceof Response) || response.body === null) {
    return { response, finished: Promise.resolve() };
  }
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const reader = response.body.getReader();
  void reader.closed.then(finish, finish);
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    cancel(reason) {
      return reader.cancel(reason).finally(finish);
    },
  });
  const tracked = new Response(body, response);
  if (retry) (tracked as FetchResponse).retry = retry;
  Object.defineProperties(tracked, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return { response: tracked, finished };
}

async function sendResponse(
  pending: Promise<FetchResponse>,
  resolve: (response: FetchResponse) => void,
): Promise<number> {
  const response = await pending;
  const pause = await busyPause(response);
  const tracked = trackResponse(response);
  resolve(tracked.response);
  await tracked.finished;
  return pause;
}

function nodeRequest(lane: Lane, foreground: boolean, send: () => Promise<FetchResponse>): Promise<FetchResponse> {
  if (foreground) lane.foreground++;
  else lane.background = true;
  return new Promise<FetchResponse>((resolve, reject) => {
    void (async () => {
      try {
        const pause = await sendResponse(send(), resolve);
        lane.resumeAt = Math.max(lane.resumeAt, performance.now() + pause);
      } catch (error) {
        reject(error);
      } finally {
        if (foreground) {
          lane.foreground--;
          lane.resumeAt = Math.max(lane.resumeAt, performance.now() + FOREGROUND_QUIET_MS);
        } else {
          lane.background = false;
        }
      }
    })();
  });
}

/** Hold foreground activity through retries. Browser Web Locks also reach replica workers. */
export async function foregroundRequest(
  url: string,
  signal: AbortSignal,
  send: () => Promise<FetchResponse>,
): Promise<FetchResponse> {
  const host = new URL(url, browser.location?.href).origin;
  const locks = browser.navigator?.locks;
  if (locks) {
    return new Promise<FetchResponse>((resolve, reject) => {
      void locks.request(`tinycloud:foreground:${host}`, { mode: "shared", signal }, async () => {
        let pause = FOREGROUND_QUIET_MS;
        try {
          pause = Math.max(pause, await sendResponse(send(), resolve));
        } catch (error) {
          reject(error);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pause));
      }).catch(reject);
    });
  }

  return nodeRequest(laneFor(host), true, send);
}

export async function backgroundRequest(
  url: string,
  signal: AbortSignal,
  send: () => Promise<FetchResponse>,
): Promise<FetchResponse> {
  const host = new URL(url, browser.location?.href).origin;
  const locks = browser.navigator?.locks;
  if (locks) {
    return new Promise<FetchResponse>((resolve, reject) => {
      void locks.request(`tinycloud:background:${host}`, { signal }, async () => {
        let request: Promise<FetchResponse> | undefined;
        while (!request) {
          signal.throwIfAborted();
          await locks.request(`tinycloud:foreground:${host}`, { ifAvailable: true }, (lock) => {
            if (lock !== null) {
              signal.throwIfAborted();
              request = send();
              void request.catch(() => undefined);
            }
          });
          if (!request) await abortableSleep(25, signal);
        }
        const pause = await sendResponse(request, resolve);
        if (pause) await new Promise<void>((resolve) => setTimeout(resolve, pause));
      }).catch(reject);
    });
  }

  const lane = laneFor(host);
  while (true) {
    signal.throwIfAborted();
    const delay = lane.resumeAt - performance.now();
    if (!lane.foreground && !lane.background && delay <= 0) break;
    await abortableSleep(lane.foreground || lane.background ? 25 : delay, signal);
  }
  return nodeRequest(lane, false, send);
}

/** Apply the background lane to a node request made outside a ServiceContext. */
export function backgroundFetch(fetch: FetchFunction): FetchFunction {
  return (url, init) => {
    const signal = init?.signal ?? new AbortController().signal;
    return backgroundRequest(url, signal, () => fetch(url, scheduledRequest({ ...init, signal }, "background")));
  };
}
