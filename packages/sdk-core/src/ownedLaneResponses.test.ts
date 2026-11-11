import { expect, test } from "bun:test";
import type { FetchFunction, ResourceTransport } from "@tinycloud/sdk-services";
import { activateSessionWithHost } from "./space";
import { checkNodeInfo } from "./version";
import { SpaceService } from "./spaces/SpaceService";
// Load sibling source at runtime so core's declaration root stays within this package.
const hostingModule = "../../node-sdk/src/space-hosting";
const replicaModule = "../../replica/src/transport";
const nodeModule = "../../node-sdk/src/TinyCloudNode";
const { askSpaceHosting } = await import(hostingModule);
const { kvSyncTransport } = await import(replicaModule);
import { dispatchRequest } from "@tinycloud/sdk-services/request-priority";

let hostSequence = 0;
function finiteResponse(status = 200) {
  let cancelled = 0;
  let pulled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 20) controller.close();
      else { pulled++; controller.enqueue(new TextEncoder().encode("unwanted chunk\n")); }
    },
    cancel() { cancelled++; },
  }), { status });
  return { response, cancelled: () => cancelled, pulled: () => pulled };
}
function ports(fetch: FetchFunction) {
  return {
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
    operations: [{ service: "space", path: "", action: "tinycloud.space/info" }],
    covers: () => true, scope: {}, host: `https://hosting-owned-${hostSequence++}.test`,
    fetch, sign: () => ({}), activate: async () => {},
  };
}

test.each([200, 401, 403, 500])("hosting %i releases its finite body before retry or return and permits background progress", async (status) => {
  const responses: ReturnType<typeof finiteResponse>[] = [];
  const p = ports(async (url, init) => dispatchRequest(url, {
    ...init, signal: init?.signal ?? new AbortController().signal,
  }, "foreground", async () => {
    const body = finiteResponse(status);
    responses.push(body);
    return body.response;
  }));
  p.activate = async () => { expect(responses[0]!.cancelled()).toBe(1); };
  expect(await askSpaceHosting(p)).toBe(status === 200 ? "hosted" : "unknown");
  for (const body of responses) {
    expect(body.cancelled()).toBe(1);
    expect(body.pulled()).toBeLessThan(20);
  }
  const sibling = await dispatchRequest(`${p.host}/sibling`, {
    signal: AbortSignal.timeout(2000),
  }, "background", async () => new Response(null));
  expect(sibling.ok).toBe(true);
}, 4000);

test("activation releases a late response even when custom fetch ignores an aborted signal and JSON reading throws", async () => {
  const controller = new AbortController();
  const body = finiteResponse();
  Object.defineProperty(body.response, "json", { configurable: true, value: async () => { throw controller.signal.reason; } });
  const result = activateSessionWithHost("https://activation-owned.test", { Authorization: "Bearer test" }, controller.signal,
    async () => { controller.abort(new Error("retired")); return body.response; });
  expect(await result).toMatchObject({ success: true, activated: [], skipped: [] });
  expect(body.cancelled()).toBe(1);
});

test("node info releases its response when a custom JSON reader rejects", async () => {
  const body = finiteResponse();
  Object.defineProperty(body.response, "json", { configurable: true, value: async () => { throw new Error("reader failed"); } });
  await expect(checkNodeInfo("https://info-owned.test", 1, async () => body.response)).rejects.toThrow("reader failed");
  expect(body.cancelled()).toBe(1);
});

test("replica feature discovery releases a non-OK response before sync proceeds", async () => {
  const body = finiteResponse(500);
  const kv = { changes: async () => {
    expect(body.cancelled()).toBe(1);
    return { ok: false, error: { code: "NETWORK_ERROR", message: "stop after discovery" } };
  } };
  const transport = kvSyncTransport(kv, { host: "https://replica-owned.test", fetch: async () => body.response });
  await expect(transport.syncPage({ prefix: "/", limit: 1 })).rejects.toThrow("stop after discovery");
  expect(body.pulled()).toBeLessThan(20);
});

test.each(["owned", "create", "info", "created", "received"])("SpaceService %s releases a response on JSON reader rejection", async (operation) => {
  const body = finiteResponse();
  Object.defineProperty(body.response, "json", { configurable: true, value: async () => { throw new Error("reader failed"); } });
  const service = new SpaceService({ hosts: ["https://space-owned.test"], session: { spaceId: "test" } as never,
    invoke: () => ({}), fetch: async () => body.response });
  const internals = service as unknown as { listOwnedSpaces(): Promise<unknown>; getSpaceInfo(space: string): Promise<unknown> };
  const delegations = service.get("tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default").delegations;
  const pending = operation === "owned" ? internals.listOwnedSpaces() : operation === "create" ? service.create("example") :
    operation === "info" ? internals.getSpaceInfo("test") : operation === "created" ? delegations.list() : delegations.listReceived();
  expect(await pending).toMatchObject({ ok: false });
  expect(body.cancelled()).toBe(1);
});

test.each([false, true])("SpaceService revoke releases an acknowledged body (resource transport: %s)", async (routed) => {
  const body = finiteResponse();
  const resourceTransport: ResourceTransport = async (_resources, consume) => consume({
    url: "https://routed-revoke-owned.test", nodeDid: "did:key:test", nodeInfo: { nodeId: "did:key:test" },
    fetch: async () => body.response, bindAudience: async (value) => value,
  });
  const service = new SpaceService({ hosts: ["https://revoke-owned.test"], session: { spaceId: "test" } as never,
    invoke: () => ({ authorization: "Bearer test" }), fetch: async () => body.response,
    ...(routed ? { resourceTransport } : {}),
  });
  expect(await service.get("tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default").delegations.revoke("cid")).toMatchObject({ ok: true });
  expect(body.cancelled()).toBe(1);
});

test.each([200, 409])("public space creation closes the info body before create and discards %i creation body", async (status) => {
  const { TinyCloud } = await import("./TinyCloud");
  const info = finiteResponse(404);
  const created = finiteResponse(status);
  let calls = 0;
  const receiver = {
    address: () => "0x0000000000000000000000000000000000000001", chainId: () => 1,
    _serviceContext: { session: {}, hosts: ["https://public-owned.test"], invoke: () => ({}), fetch: async () => {
      if (calls++ === 0) return info.response;
      expect(info.cancelled()).toBe(1);
      return created.response;
    } },
  };
  expect(await TinyCloud.prototype.ensurePublicSpace.call(receiver as never)).toMatchObject({ ok: true });
  expect(calls).toBe(2);
  expect(created.cancelled()).toBe(1);
});

test("public space existing success discards its body", async () => {
  const { TinyCloud } = await import("./TinyCloud");
  const info = finiteResponse();
  const receiver = {
    address: () => "0x0000000000000000000000000000000000000001", chainId: () => 1,
    _serviceContext: { session: {}, hosts: ["https://public-owned.test"], invoke: () => ({}), fetch: async () => info.response },
  };
  expect(await TinyCloud.prototype.ensurePublicSpace.call(receiver as never)).toMatchObject({ ok: true });
  expect(info.cancelled()).toBe(1);
});

test("storage status releases its body when a custom text reader rejects", async () => {
  const { TinyCloudNode } = await import(nodeModule);
  const body = finiteResponse();
  Object.defineProperty(body.response, "text", { configurable: true, value: async () => { throw new Error("reader failed"); } });
  const prototype = TinyCloudNode.prototype as unknown as { readStorageStatus(this: unknown): Promise<unknown> };
  expect(await prototype.readStorageStatus.call({
    _serviceContext: { session: { spaceId: "test" }, hosts: ["https://storage-owned.test"], invoke: () => ({}), fetch: async () => body.response },
    findGrantForOperation: () => ({}),
  })).toMatchObject({ ok: false });
  expect(body.cancelled()).toBe(1);
});

test.each([false, true])("service graph registry guard preserves exact handoff or releases refusal (refusal: %s)", async (refusal) => {
  const { TinyCloudNode } = await import(nodeModule);
  const original = globalThis.fetch;
  const body = finiteResponse(403);
  if (refusal) Object.defineProperty(body.response, "clone", { configurable: true, value: () => new Response("registry_hosting_denied: denied") });
  const prototype = TinyCloudNode.prototype as unknown as {
    throwRegistryRefusal(status: number, text: string): void;
    createServiceGraphLifetime(this: unknown): { fetch: (url: string) => Promise<Response>; retire(): void };
  };
  const graph = prototype.createServiceGraphLifetime.call({ throwRegistryRefusal: prototype.throwRegistryRefusal });
  globalThis.fetch = (async () => body.response) as unknown as typeof fetch;
  try {
    if (refusal) {
      await expect(graph.fetch("https://guard-owned.test/test")).rejects.toMatchObject({ code: "node_registry_entry_exists" });
      expect(body.cancelled()).toBe(1);
    } else {
      const received = await graph.fetch("https://guard-owned.test/test");
      expect(received).toBe(body.response);
      expect(body.cancelled()).toBe(0);
      await received.body?.cancel();
    }
  } finally {
    graph.retire();
    globalThis.fetch = original;
  }
});
