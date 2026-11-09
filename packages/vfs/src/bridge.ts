import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { join } from "node:path";
import type { TinyCloudVfsWorkerInit, WorkerRequest, WorkerResponse } from "./types";
import { createEIO } from "./errors";

const WAIT_SLICE_MS = 1_000;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 120_000;

interface BridgeTestHooks {
  timeoutMs?: number;
  createWorker?: () => Worker;
}

let testHooks: BridgeTestHooks = {};

/** Internal seam for the package's own tests; not re-exported from the package entry. */
export function setBridgeTestHooks(hooks: BridgeTestHooks): void {
  testHooks = hooks;
}

export class TinyCloudVfsBridgeTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  readonly errno = -110;
  readonly syscall = "bridge";
  readonly timeoutMs: number;

  constructor(requestType: string, timeoutMs: number) {
    super(`worker did not answer "${requestType}" within ${timeoutMs}ms, bridge '/'`);
    this.name = "TinyCloudVfsBridgeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function createWaitSignal(): { buffer: SharedArrayBuffer; view: Int32Array } {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  return {
    buffer,
    view: new Int32Array(buffer),
  };
}

function resolveWorkerSpecifier(): string | URL {
  if (typeof __dirname !== "undefined") {
    return join(__dirname, "worker.cjs");
  }

  return new URL("./worker.js", import.meta.url);
}

export class TinyCloudVfsBridge {
  private readonly worker: Worker;
  private readonly timeoutMs: number;

  constructor(init: TinyCloudVfsWorkerInit) {
    this.timeoutMs = testHooks.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    if (testHooks.createWorker) {
      this.worker = testHooks.createWorker();
    } else {
      const specifier = resolveWorkerSpecifier();
      this.worker = typeof specifier === "string"
        ? new Worker(specifier)
        : new Worker(specifier);
    }

    let response: WorkerResponse;
    try {
      response = this.requestSync({ type: "init", init });
    } catch (error) {
      void this.worker.terminate();
      throw error;
    }
    if (!response.ok) {
      this.worker.terminate();
      throw createEIO("init", "/", response.error.message);
    }
  }

  close(): void {
    void this.worker.terminate();
  }

  requestSync(request: WorkerRequest): WorkerResponse {
    const { port1, port2 } = new MessageChannel();
    const { buffer, view } = createWaitSignal();

    this.worker.postMessage(
      {
        request,
        replyPort: port1,
        waitBuffer: buffer,
      },
      [port1],
    );

    const deadline = Date.now() + this.timeoutMs;
    while (Atomics.load(view, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        port2.close();
        throw new TinyCloudVfsBridgeTimeoutError(request.type, this.timeoutMs);
      }
      Atomics.wait(view, 0, 0, Math.min(WAIT_SLICE_MS, remaining));
    }

    const response = receiveMessageOnPort(port2)?.message as WorkerResponse | undefined;
    port2.close();
    if (!response) {
      throw createEIO("bridge", "/", "worker did not return a response");
    }

    return response;
  }

  async requestAsync(request: WorkerRequest): Promise<WorkerResponse> {
    return this.requestSync(request);
  }
}
