import { describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { ensureSpaceSetup } from "./space-setup.js";

const ctx = { profile: "fixture", host: "https://node.test" };
const permissions = [{ service: "tinycloud.kv", space: "applications", path: "spaces/", actions: ["tinycloud.kv/list"] }];
const hosted = async () => ({ ok: true, data: { keys: [] } });
const delegation = (spaceId: string) => ({ spaceId, spaceReady: null, spacePending: true });

/** A node that records which route answered the probe. */
function node(primary: string | undefined) {
  const routes: string[] = [];
  const fake = {
    spaceId: primary,
    kv: { list: async () => { routes.push("node.kv"); return hosted(); } },
    space: (id: string) => ({ kv: { list: async () => { routes.push(`space(${id})`); return hosted(); } } }),
  } as unknown as TinyCloudNode;
  return { fake, routes };
}

describe("a single-space login's space check", () => {
  test("a grant for the node's own space is read through the node, whatever the case of the owner address", async () => {
    const { fake, routes } = node("tinycloud:pkh:eip155:1:0xAbCdEf0123456789aBcDeF0123456789abcdef01:applications");
    await ensureSpaceSetup(ctx, delegation("tinycloud:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01:applications"), permissions, 0, async () => ({ node: fake }));
    expect(routes).toEqual(["node.kv"]);
  });

  test("a grant for another space than the node's primary is read through that space", async () => {
    const { fake, routes } = node("tinycloud:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01:default");
    await ensureSpaceSetup(ctx, delegation("tinycloud:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01:applications"), permissions, 0, async () => ({ node: fake }));
    expect(routes).toEqual(["space(tinycloud:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01:applications)"]);
  });
});
