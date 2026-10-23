import { describe, expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";
import type { RequestEvent, RequestLog } from "@tinycloud/sdk-services";
import { TinyCloudNode } from "./TinyCloudNode";

const HOST = "https://tinycloud.test";

const EVENT: Omit<RequestEvent, "id"> = {
  v: 1,
  at: 0,
  service: "kv",
  op: "kv/get",
  path: "notes/a",
  space: "default",
  host: null,
  bytes: 3,
  durationMs: 1,
  attempts: 1,
  ok: true,
  code: "ok",
  source: "network",
};

function makeFakeSessionManager(): ISessionManager {
  const keys = new Set<string>(["default"]);
  return {
    createSessionKey(id: string): string {
      keys.add(id);
      return id;
    },
    replaceSessionKey(_jwk: object, keyId: string): string {
      keys.add(keyId);
      return keyId;
    },
    renameSessionKeyId(oldId: string, newId: string): void {
      if (keys.has(oldId)) {
        keys.delete(oldId);
        keys.add(newId);
      }
    },
    getDID(keyId: string): string {
      return `did:key:z6MkTest-${keyId}`;
    },
    jwk(keyId: string): string | undefined {
      if (!keys.has(keyId)) return undefined;
      return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" });
    },
  };
}

function makeFakeWasmBindings(): IWasmBindings {
  return {
    invoke: mock(() => Promise.resolve({} as any)) as any,
    invokeAny: mock(() => Promise.resolve({} as any)) as any,
    ensureEip55: (a: string) => a,
    makeSpaceId: (a: string, c: number, p: string) => `tinycloud:pkh:eip155:${c}:${a}:${p}`,
    protocolVersion: () => 1,
    createSessionManager: makeFakeSessionManager,
  } as unknown as IWasmBindings;
}

describe("TinyCloudNode request log", () => {
  test("requests is undefined unless requestLog is enabled", () => {
    const node = new TinyCloudNode({ host: HOST, wasmBindings: makeFakeWasmBindings() });
    expect(node.requests).toBeUndefined();
  });

  test("developer mode off allocates no request ring: the node's _requestLog field stays undefined", () => {
    const node = new TinyCloudNode({ host: HOST, wasmBindings: makeFakeWasmBindings() });
    // Private field read is the only way to observe that no RequestLog was allocated.
    expect(Reflect.get(node, "_requestLog")).toBeUndefined();
    expect(node.requests).toBeUndefined();
  });

  test("requests exposes a read-only view: no record or clear on the returned object", () => {
    const node = new TinyCloudNode({
      host: HOST,
      wasmBindings: makeFakeWasmBindings(),
      requestLog: true,
    });
    const view = node.requests as unknown as Record<string, unknown>;
    expect(typeof view.snapshot).toBe("function");
    expect(view.record).toBeUndefined();
    expect(view.clear).toBeUndefined();
  });

  test("sign-out clears recorded requests and notifies onClear listeners", async () => {
    const node = new TinyCloudNode({
      host: HOST,
      wasmBindings: makeFakeWasmBindings(),
      requestLog: true,
    });
    const log = Reflect.get(node, "_requestLog") as RequestLog;
    log.record(EVENT);
    expect(node.requests!.snapshot()).toHaveLength(1);

    const onClear = mock(() => {});
    node.requests!.onClear(onClear);
    await node.signOut();

    expect(node.requests!.snapshot()).toEqual([]);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
