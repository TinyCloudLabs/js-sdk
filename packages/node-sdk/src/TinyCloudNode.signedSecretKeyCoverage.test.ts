import "../../operations/test-support/test-bootstrap.mjs";
import { expect, test } from "bun:test";
import { composeManifestRequest, extractRecapAttenuations, isCapabilitySubset, type Manifest } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { startUnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

test("a signed session covers only the exact secret keys and actions it approved", async () => {
  const signer = new PrivateKeySigner("1".padStart(64, "0"));
  const address = await signer.getAddress();
  const network = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
  const key = `${network}/secrets/fireflies_api_key`;
  const scopedKey = `${network}/secrets/scoped/google-meet/oauth_token`;
  const permission = (path: string, actions = ["decrypt", "key.create"]) => ({ service: "tinycloud.encryption", path, actions, skipPrefix: true });
  const manifest: Manifest = {
    manifest_version: 1, app_id: "xyz.tinycloud.exact-key-test", name: "Exact key test",
    space: "applications", defaults: false,
    permissions: [permission(network.toLowerCase(), ["decrypt"]), permission(key), permission(scopedKey, ["decrypt"])],
  };
  const registry = startUnregisteredLocationRegistry();
  const node = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({
      protocol: 1, version: "1.26.21", features: ["encryption-named-keys-v1"],
      nodeId: "did:key:z6MkvSbonMn1Xgewrb4EsbjTmvMT8T9Y3PTb5PcnQcQUbzjc",
    });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    if (path === `/encryption/networks/${network}` || path === "/encryption/networks") {
      return Response.json({ descriptor: { networkId: network, state: "active" } });
    }
    return new Response(null, { status: 404 });
  }});
  try {
    const sdk = new TinyCloudNode({
      host: node.url.origin, tinycloudRegistryUrl: registry.url.origin, signer, wasmBindings: new NodeWasmBindings(),
      domain: "fixture.example", manifest, autoCreateSpace: false, autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
    });
    await sdk.signIn();
    const signed = extractRecapAttenuations(sdk.session!.siwe);
    expect(Object.keys(signed[key] ?? {}).sort()).toEqual(["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"]);
    expect(Object.keys(signed[scopedKey] ?? {})).toEqual(["tinycloud.encryption/decrypt"]);
    const request = composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources;
    expect(sdk.hasRuntimePermissions([permission(network, ["decrypt"])])).toBe(true);
    expect(sdk.hasRuntimePermissions([permission(`${network}/secrets/unsigned`, ["decrypt"])])).toBe(false);
    expect(sdk.hasRuntimePermissions([permission(scopedKey, ["key.create"])])).toBe(false);
    expect(sdk.hasRuntimePermissions([permission(`${network}/share/`, ["decrypt"])])).toBe(false);
    expect(isCapabilitySubset([{ ...permission(`${network}/secrets/`, ["decrypt"]), space: "encryption" }], request).subset).toBe(false);
    expect(sdk.hasRuntimePermissions(request)).toBe(true);
    for (const action of ["decrypt", "key.create"]) {
      expect(sdk.hasRuntimePermissions([permission(key, [action])])).toBe(true);
    }
  } finally {
    registry.stop(true);
    node.stop(true);
  }
});
