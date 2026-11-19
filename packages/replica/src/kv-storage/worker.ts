/**
 * The `@tinycloud/replica/kv-storage` worker (`dist/kv-storage.worker.js`):
 * a self-contained module worker that owns the engine, the network calls,
 * the origin database and the device key for one storage instance. Like the
 * RC1 worker it never imports `@tinycloud/web-sdk` or `@tinycloud/node-sdk`;
 * `invoke` and the session manager come from `@tinycloud/web-sdk-wasm` with
 * the WASM inlined by the build.
 *
 * `createIndexedDbGateTx` plugs in as `gateTx` over the origin database. There is
 * no ungated mode: without it every `open` refuses REPLICA_GATED `gate_unavailable`.
 * The quota ledger shares the gated writer's transaction for every persisted row delta.
 */
import type { ReplicaDenyOutcome } from "@tinycloud/sdk-services/kv/replication";
import { initialized } from "@tinycloud/web-sdk-wasm";

import { createIndexedDbGateTx } from "./gateTx.js";
import { createKvWorkerHost } from "./host.js";
import { ledgerFor } from "./ledger.js";
import type { KvConsentExpiryAck, KvRequest } from "./protocol.js";
import { openKvDatabase } from "./schema.js";
import { wasmWorkerDeps } from "./wasmDeps.js";

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent<({ id: number } & KvRequest) | KvConsentExpiryAck>) => void) | null;
};

async function main(): Promise<void> {
  await initialized;
  let nextExpiryRequestId = 0;
  const pendingExpiry = new Map<number, { resolve(outcome: ReplicaDenyOutcome): void; reject(error: Error): void }>();
  const onConsentExpired = (): Promise<ReplicaDenyOutcome> => {
    const requestId = ++nextExpiryRequestId;
    const { promise, resolve, reject } = Promise.withResolvers<ReplicaDenyOutcome>();
    pendingExpiry.set(requestId, { resolve, reject });
    scope.postMessage({ event: { event: "consentExpiry", requestId } });
    return promise;
  };
  const host = createKvWorkerHost({
    ...wasmWorkerDeps,
    gateTx: createIndexedDbGateTx((create) => openKvDatabase({ create }), { onConsentExpired }),
    ledgerFor,
    post: (message, transfer) => scope.postMessage(message, transfer ?? []),
    locks: navigator.locks,
  });
  scope.onmessage = (message) => {
    const request = message.data;
    if (request.op === "consentExpiryAck") {
      const pending = pendingExpiry.get(request.requestId);
      if (pending === undefined) return;
      pendingExpiry.delete(request.requestId);
      if (request.ok) pending.resolve(request.outcome);
      else pending.reject(new Error(request.message));
      return;
    }
    host.receive(request);
  };
  scope.postMessage({ event: { event: "ready" } });
}

// A rejection inside a worker fires no `error` on the Worker object. reportError raises it as an
// uncaught exception, which reaches the main thread's Worker.onerror and fails every call fast.
main().catch(reportError);
