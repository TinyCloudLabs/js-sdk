/**
 * Test-only kv-storage worker with the production WASM signing path
 * (`wasmWorkerDeps`) and the adapter's test gate. It exercises the adapter
 * against a real node; lifecycle acceptance runs against the real gate in
 * the acceptance suite, not here.
 */
import { initialized } from "@tinycloud/web-sdk-wasm";

import { createKvWorkerHost } from "../../../src/kv-storage/host.js";
import type { KvRequest } from "../../../src/kv-storage/protocol.js";
import { wasmWorkerDeps } from "../../../src/kv-storage/wasmDeps.js";
import { createTestGate } from "../../test-gate.js";

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent<{ id: number } & KvRequest>) => void) | null;
};

await initialized;
const host = createKvWorkerHost({
  ...wasmWorkerDeps,
  gateTx: createTestGate(),
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
  ...(navigator.locks === undefined ? {} : { locks: navigator.locks }),
});
scope.onmessage = (message) => host.receive(message.data);
scope.postMessage({ event: { event: "ready" } });
