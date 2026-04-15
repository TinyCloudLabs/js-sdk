import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { join } from "node:path";
import type { TinyCloudVfsWorkerInit, WorkerRequest, WorkerResponse } from "./types";
import { createEIO } from "./errors";

const WAIT_SLICE_MS = 1_000;

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

  constructor(init: TinyCloudVfsWorkerInit) {
    const specifier = resolveWorkerSpecifier();
    this.worker = typeof specifier === "string"
      ? new Worker(specifier)
      : new Worker(specifier);

    const response = this.requestSync({ type: "init", init });
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

    while (Atomics.load(view, 0) === 0) {
      Atomics.wait(view, 0, 0, WAIT_SLICE_MS);
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
