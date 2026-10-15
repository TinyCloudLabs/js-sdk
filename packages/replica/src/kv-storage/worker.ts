/**
 * The `@tinycloud/replica/kv-storage` worker (`dist/kv-storage.worker.js`):
 * a self-contained module worker that owns the engine, the network calls,
 * the origin database and the device key for one storage instance. Like the
 * RC1 worker it never imports `@tinycloud/web-sdk` or `@tinycloud/node-sdk`;
 * `invoke` and the session manager come from `@tinycloud/web-sdk-wasm` with
 * the WASM inlined by the build.
 */
import { KVService, ServiceContext } from "@tinycloud/sdk-services";
import { initialized, tinycloud, tcwSession } from "@tinycloud/web-sdk-wasm";

import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { kvSyncTransport } from "../transport.js";
import { createKvWorkerHost } from "./host.js";
import type { KvRequest } from "./protocol.js";

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent<{ id: number } & KvRequest>) => void) | null;
};

async function main(): Promise<void> {
  await initialized;
  const host = createKvWorkerHost({
    post: (message, transfer) => scope.postMessage(message, transfer ?? []),
    createDevice() {
      const manager = new tcwSession.TCWSessionManager();
      const keyId = manager.createSessionKey("replica-device") ?? "replica-device";
      const jwk = manager.jwk(keyId);
      if (jwk === null || jwk === undefined) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The WASM key manager returned no JWK.");
      return { did: manager.getDID(keyId), jwk: JSON.parse(jwk) as object };
    },
    transportFor(grant, spec, device) {
      // A KV service bound to exactly this grant and device against the pinned host,
      // wired like node-sdk's DelegatedAccess.
      const context = new ServiceContext({
        invoke: tinycloud.invoke,
        invokeAny: tinycloud.invokeAny,
        fetch: globalThis.fetch.bind(globalThis),
        hosts: [spec.identity.host],
      });
      const kv = new KVService({});
      kv.initialize(context);
      context.registerService("kv", kv);
      context.setSession({
        delegationHeader: { Authorization: new TextDecoder().decode(grant.bytes) },
        delegationCid: grant.cid,
        spaceId: spec.space,
        verificationMethod: device.did,
        jwk: device.jwk,
      });
      return kvSyncTransport(kv, { host: spec.identity.host });
    },
    ...(navigator.locks === undefined ? {} : { locks: navigator.locks }),
  });
  scope.onmessage = (message) => host.receive(message.data);
  scope.postMessage({ event: { event: "ready" } });
}

void main();
