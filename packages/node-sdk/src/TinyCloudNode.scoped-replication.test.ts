import { expect, test } from "bun:test";
import { ServiceContext } from "@tinycloud/sdk-core";
import type { KVReadThrough } from "@tinycloud/sdk-services";
import { TinyCloudNode } from "./TinyCloudNode";

const host = "https://scoped-replication.test";
const space = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";

test("immediate writes through both primary-space views await replication attachment", async () => {
  const network = new Map([
    ["notes/scoped", "v0"],
    ["notes/created", "v0"],
  ]);
  const replica = new Map(network);
  const requests: string[] = [];
  const context = new ServiceContext({
    hosts: [host],
    invoke: (_session, _service, path, action) => ({
      Authorization: "synthetic",
      "x-test-path": path,
      "x-test-action": action,
    }),
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      const path = headers.get("x-test-path")!;
      const action = headers.get("x-test-action");
      requests.push(`${action}:${path}`);
      if (action === "tinycloud.kv/put") {
        network.set(path, await new Response(init?.body).text());
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ value: network.get(path) ?? null }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  context.setSession({
    delegationHeader: { Authorization: "synthetic" },
    delegationCid: "bafy-session",
    spaceId: space,
    verificationMethod: "did:key:zSession",
    jwk: {},
  });

  let resolveRuntime!: (runtime: { attach(space: string, kv: { setReadThrough(value: KVReadThrough | null): void }): void }) => void;
  const replicationRuntime = new Promise<{ attach(space: string, kv: { setReadThrough(value: KVReadThrough | null): void }): void }>((resolve) => {
    resolveRuntime = resolve;
  });
  const readThrough: KVReadThrough = {
    async get(request) {
      return {
        ok: true,
        data: { data: { value: replica.get(request.path) ?? "v0" }, headers: new Headers() },
      } as never;
    },
    async list(request) {
      return await request.network();
    },
    async write(request) {
      const result = await request.network();
      if (result.ok) {
        for (const entry of request.entries) {
          const value = network.get(entry.path);
          if (value !== undefined) replica.set(entry.path, value);
        }
      }
      return result;
    },
    observeNetworkRequested() {},
  };
  const receiver = Object.assign(Object.create(TinyCloudNode.prototype), {
    _serviceContext: context,
    _serviceGraph: { track: (tracked: ServiceContext) => tracked },
    config: {},
    replicationRuntime,
  }) as TinyCloudNode;

  const scopedView = receiver.kvForSpace(space);
  const createdView = (receiver as unknown as { createSpaceScopedKVService(spaceId: string): typeof scopedView })
    .createSpaceScopedKVService(space);
  const writes = Promise.all([
    scopedView.put("notes/scoped", "v1"),
    createdView.put("notes/created", "v1"),
  ]);
  await Promise.resolve();
  expect(requests).toEqual([]);

  resolveRuntime({
    attach(attachedSpace, kv) {
      kv.setReadThrough(attachedSpace === space ? readThrough : null);
    },
  });
  const results = await writes;
  expect(results.every((result) => result.ok)).toBe(true);
  expect((await scopedView.get("notes/scoped")).data?.data).toMatchObject({ value: "v1" });
  expect((await createdView.get("notes/created")).data?.data).toMatchObject({ value: "v1" });
  expect(requests).toEqual([
    "tinycloud.kv/put:notes/scoped",
    "tinycloud.kv/put:notes/created",
  ]);
});
