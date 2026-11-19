import { expect, test } from "bun:test";
import { ServiceContext } from "../context";
import { KVService } from "./KVService";
import type { ServiceSession } from "../types";

const session: ServiceSession = {
  delegationHeader: { Authorization: "A" }, delegationCid: "A",
  spaceId: "tinycloud:pkh:eip155:1:0x1:A", verificationMethod: "A", jwk: {},
};

function service(host: string) {
  const context = new ServiceContext({
    hosts: [host], session, invoke: () => ({}), invokeAny: () => ({}),
    // A batch put is confirmed by its written keys; every other call accepts a JSON body.
    fetch: async (_url, init) => init?.body instanceof FormData
      ? Response.json({ written: ["note"], count: 1 })
      : new Response("[]", { headers: { "content-type": "application/json" } }),
  });
  const kv = new KVService();
  kv.initialize(context);
  return { context, kv };
}

const calls = (kv: KVService, signal: AbortSignal, timeout?: number) => ({
  get: () => kv.get("note", { signal, timeout }),
  put: () => kv.put("note", "value", { signal, timeout }),
  batchPut: () => kv.batchPut([{ key: "note", value: "value" }], { signal, timeout }),
  list: () => kv.list({ signal, timeout }),
  delete: () => kv.delete("note", { signal, timeout }),
});

test.each(["get", "put", "batchPut", "list", "delete"] as const)(
  "%s can be cancelled while the read-through is still attaching", async (method) => {
    const { context, kv } = service(`https://${method}-attach-abort.invalid`);
    kv.setReadThroughReady(new Promise(() => {}));
    const controller = new AbortController();
    try {
      const pending = calls(kv, controller.signal)[method]();
      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ABORTED");
    } finally { context.retire(); }
  },
);

test.each(["get", "put", "batchPut", "list", "delete"] as const)(
  "%s starts its timeout after the read-through attaches", async (method) => {
    const { context, kv } = service(`https://${method}-attach-timeout.invalid`);
    let attach!: () => void;
    kv.setReadThroughReady(new Promise<void>((resolve) => { attach = resolve; }));
    try {
      const pending = calls(kv, new AbortController().signal, 100)[method]();
      // Real time: the attachment must outlast the call's timeout.
      setTimeout(attach, 250);
      const result = await pending;
      expect(result.ok).toBe(true);
    } finally { context.retire(); }
  },
);
