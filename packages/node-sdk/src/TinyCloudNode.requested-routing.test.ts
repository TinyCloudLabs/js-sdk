import { expect, spyOn, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";

const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const wasm = new NodeWasmBindings();

test("post-construction manifest routes through its requested space, ahead of implicit account companions", async () => {
  const node = new TinyCloudNode({ signer, wasmBindings: wasm, host: "https://routing.test", autoBootstrapAccount: false, autoCreateSpace: false });
  node.setManifest({ app_id: "com.demo.app", name: "Demo", defaults: false, includePublicSpace: false,
    permissions: [{ service: "tinycloud.kv", space: "default", path: "config", actions: ["get"] }] });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ protocol: 1, version: "1.0.0", features: [], activated: [], skipped: [] }), { preconnect: globalThis.fetch.preconnect }));
  try {
    await node.signIn();
    expect(node.spaceId).toBe(wasm.makeSpaceId(await signer.getAddress(), 1, "default"));
    expect(node.hasRuntimePermissions([{ service: "tinycloud.kv", space: "default", path: "com.demo.app/config", actions: ["tinycloud.kv/get"] }])).toBe(true);
    expect(node.hasRuntimePermissions([{ service: "tinycloud.kv", space: "default", path: "outside", actions: ["tinycloud.kv/get"] }])).toBe(false);
  } finally { await node.waitForAccountRegistrySync(); fetch.mockRestore(); }
});
