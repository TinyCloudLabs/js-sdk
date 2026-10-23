/**
 * The WASM half of the kv-storage worker: the owner device key factory and
 * the signing transport, from `@tinycloud/web-sdk-wasm`. Shared by the
 * production worker entry and test workers that run the same signing path.
 * Call after `initialized` resolves.
 */
import { KVService } from "@tinycloud/sdk-services/kv";
import { ServiceContext } from "@tinycloud/sdk-services/context";
import { tinycloud, tcwSession } from "@tinycloud/web-sdk-wasm";

import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { kvSyncTransport } from "../transport.js";
import type { KvWorkerDeps } from "./host.js";

export const wasmWorkerDeps: Pick<KvWorkerDeps, "createDevice" | "transportFor"> = {
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
};
