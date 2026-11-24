import { expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY, composeManifestRequest, extractRecapAttenuations } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

const feature = "encryption-named-keys-v1";
const decrypt = "tinycloud.encryption/decrypt";

test("sign-in reports only omitted resources and clears the warning on the next successful sign-in", async () => {
  const signer = new PrivateKeySigner("1".padStart(64, "0"));
  const address = await signer.getAddress();
  const network = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
  const resources = [`${network}/secrets/api_key`, `${network}/secrets/scoped/team/token`];
  const spaceId = `tinycloud:pkh:eip155:1:${address}:default`;
  let features = ["encryption"];
  let activations = 0;
  let signatures = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (/^\/v[12]\/locations\//.test(path)) {
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/info") return Response.json({ protocol: 1, version: "test", features, nodeId: "did:key:z6MkNode" });
    if (path === "/delegate" && request.method === "POST") {
      activations++;
      return Response.json({ activated: [spaceId], skipped: [] });
    }
    if (decodeURIComponent(path) === `/encryption/networks/${network}`) return Response.json({ network_id: network });
    return new Response(`Unexpected request: ${request.method} ${path}`, { status: 500 });
  } });
  try {
    const node = new TinyCloudNode({
      signer: {
        getAddress: () => signer.getAddress(), getChainId: () => signer.getChainId(),
        signMessage: async (message) => { signatures++; return signer.signMessage(message); },
      },
      wasmBindings: new NodeWasmBindings(),
      host: server.url.origin, tinycloudRegistryUrl: server.url.origin, autoDiscoverLocalNode: false,
      autoBootstrapAccount: false, includeAccountRegistryPermissions: false,
      capabilityRequest: composeManifestRequest([{
        app_id: "test", name: "Sign-in warnings fixture", space: "default", prefix: "", defaults: false,
        includePublicSpace: false,
        permissions: [
          { service: "tinycloud.kv", path: "notes/", actions: ["get"] },
          ...[network, ...resources].map((path) => ({ service: "tinycloud.encryption", path, actions: [decrypt] })),
        ],
      }], { includeAccountRegistryPermissions: false }),
    });
    expect(await node.signIn()).toEqual({ warnings: [{ code: "NODE_FEATURE_UNAVAILABLE", feature, resources }] });
    const legacy = extractRecapAttenuations(node.session!.siwe);
    expect(legacy[network]?.[decrypt]).toBeDefined();
    for (const resource of resources) expect(legacy[resource]).toBeUndefined();
    expect(node.restorableSession).not.toHaveProperty("warnings");
    expect(signatures).toBe(1);
    expect(activations).toBe(1);

    features = [...features, feature];
    expect(await node.signIn()).not.toHaveProperty("warnings");
    const named = extractRecapAttenuations(node.session!.siwe);
    for (const resource of resources) expect(named[resource]?.[decrypt]).toBeDefined();
    const { [resources[0]!]: _first, [resources[1]!]: _second, ...rest } = named;
    expect(rest).toEqual(legacy);
    expect(signatures).toBe(2);
    expect(activations).toBe(2);
  } finally {
    server.stop(true);
  }
});
