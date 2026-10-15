/**
 * The `@tinycloud/replica/kv-storage` worker (`dist/kv-storage.worker.js`):
 * a self-contained module worker that owns the engine, the network calls,
 * the origin database and the device key for one storage instance. Like the
 * RC1 worker it never imports `@tinycloud/web-sdk` or `@tinycloud/node-sdk`;
 * `invoke` and the session manager come from `@tinycloud/web-sdk-wasm` with
 * the WASM inlined by the build.
 *
 * The lifecycle gate's `createIndexedDbGateTx` and the quota ledger plug in
 * here (`gateTx`, `ledgerFor`). Until the gate is wired every `open` refuses
 * REPLICA_GATED `gate_unavailable`: there is no ungated mode.
 */
import { initialized } from "@tinycloud/web-sdk-wasm";

import { createKvWorkerHost } from "./host.js";
import type { KvRequest } from "./protocol.js";
import { wasmWorkerDeps } from "./wasmDeps.js";

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent<{ id: number } & KvRequest>) => void) | null;
};

async function main(): Promise<void> {
  await initialized;
  const host = createKvWorkerHost({
    ...wasmWorkerDeps,
    post: (message, transfer) => scope.postMessage(message, transfer ?? []),
    ...(navigator.locks === undefined ? {} : { locks: navigator.locks }),
  });
  scope.onmessage = (message) => host.receive(message.data);
  scope.postMessage({ event: { event: "ready" } });
}

void main();
